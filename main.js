'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, protocol, screen, clipboard, nativeImage, shell,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');

const RENDERER = path.join(__dirname, 'renderer');

/* El renderer se sirve por un esquema propio en vez de file://.
 *
 * No es capricho: los modulos ES cargados desde file:// los bloquea CORS
 * (origin 'null'), asi que un <script type="module"> no levanta ni un import.
 * La alternativa seria empaquetar todo con un bundler, pero entonces el codigo
 * que corre deja de ser el que se lee. Con un esquema registrado como
 * 'standard' y 'secure', los imports andan igual que contra un servidor. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'scrawl',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function registerProtocol() {
  protocol.handle('scrawl', async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const target = path.join(RENDERER, rel);

    // sin esto, un '../../..' en la URL leeria cualquier archivo del disco
    const inside = path.relative(RENDERER, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return new Response('fuera del directorio del renderer', { status: 403 });
    }

    /* Se lee con fs en vez de net.fetch(file://) por el empaquetado: en
     * produccion el renderer vive DENTRO de app.asar, y el modulo fs de Node lo
     * atraviesa porque Electron lo parchea, mientras que el cargador de file://
     * no tiene por que hacerlo. Leyendo con fs, el mismo camino sirve corriendo
     * desde la carpeta y desde el instalador. */
    try {
      const data = await fs.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('no encontrado', { status: 404 });
    }
  });
}

/* La base oscura vive aca arriba a proposito, y tiene doble laburo:
 *   1. mata el flash de contenido del arranque (el renderer todavia no pinto), y
 *   2. Electron 40 tine con ESTE color el frame fantasma que el compositor de
 *      Windows pinta al minimizar->restaurar. Sin el, ese frame sale blanco y no
 *      hay CSS que lo tape porque vive en el compositor, no en el documento. */
const BG = '#0d0d0d';

const WIN_W = 1560;
const WIN_H = 960;

const DEV = process.argv.includes('--dev');

/* Modo captura de interfaz: abre, espera que las animaciones de entrada
 * terminen, guarda un PNG de la ventana y cierra. Existe para poder revisar la
 * app sin mirarla — un cambio de layout se verifica abriendo el PNG, no
 * confiando en que "deberia andar".
 *
 * Acepta un sufijo ':modo' en la ruta, que se le pasa al renderer como ?ui=modo:
 *   demo  dibuja trazos sinteticos con presion variable antes de la captura, asi
 *         el motor de pinceles queda verificado incluso sin tablet enchufada
 *   puck  lo mismo, y ademas deja el puck de navegacion abierto sobre el dibujo:
 *         es un elemento que solo existe con una tecla apretada, y sin esto no
 *         habria forma de mirarlo sin estar sentado frente a la app
 *   canvas  abre el dialogo de tamano del lienzo, por el mismo motivo: un modal
 *         solo existe mientras alguien lo tiene abierto
 *   update  abre el aviso de actualizacion; hay que darle el estado a mirar con
 *         --fake-update=available|downloading|ready */
/* Autotest del motor: carga selftest.html en vez de la app, deja que corra las
 * aserciones y cierra con codigo 1 si alguna fallo, para que sirva desde un
 * script o un hook de commit. */
const SELFTEST = process.argv.includes('--selftest');

const UI_ARG = process.argv.find((a) => a.startsWith('--ui-shot='));
const UI_RAW = UI_ARG ? UI_ARG.slice('--ui-shot='.length) : null;
/* El sufijo se busca pegado al final. Una ruta absoluta de Windows tambien lleva
 * dos puntos ('C:\...'), pero no ahi, asi que no se la come. */
const UI_MODE_AT = UI_RAW ? UI_RAW.match(/:([a-z]+)$/) : null;
const UI_MODE = UI_MODE_AT ? UI_MODE_AT[1] : '1';
const UI_SHOT = UI_MODE_AT ? UI_RAW.slice(0, -UI_MODE_AT[0].length) : UI_RAW;
// los modos que dibujan necesitan mas margen antes de disparar la captura
const UI_DRAWS = UI_MODE === 'demo' || UI_MODE === 'puck';

/* Estado de actualizacion de mentira, para revisar ese aviso sin tener que
 * publicar un release. Solo con --dev o durante una captura: en una app
 * instalada, la unica fuente de este estado es GitHub. */
const FAKE_ARG = process.argv.find((a) => a.startsWith('--fake-update='));
const FAKE_UPDATE = (DEV || UI_ARG) && FAKE_ARG ? FAKE_ARG.split('=')[1] : null;

/* Las ventanas abiertas. Cada una es un documento con su propio renderer — un
 * app.js entero, con su historial, su vista y sus pinceles — y el proceso
 * principal no distingue entre ellas salvo para saber cual pidio que. Por eso
 * todo lo de abajo que antes hablaba con "la ventana" habla con la que mando el
 * mensaje (senderWin), y lo que llega de afuera va a la ultima que tuvo foco. */
const windows = new Set();
let lastFocused = null;

const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

function focusedWin() {
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  for (const w of windows) if (!w.isDestroyed()) return w;
  return null;
}

/* Ventanas con trabajo sin guardar. Lo reporta cada renderer al cambiar: el
 * principal lo necesita para no reiniciar la app por una actualizacion cuando
 * OTRA ventana — que el dialogo que pidio reiniciar no ve — tiene un dibujo a
 * medio hacer. */
const dirtyWins = new WeakSet();

/* Ruta de un .scrawl pasada por linea de comandos: es como Windows entrega el
 * archivo al hacer doble clic, una vez registrada la asociacion. */
function fileFromArgv(argv) {
  return argv.slice(1).find(
    (a) => !a.startsWith('--') && a.toLowerCase().endsWith('.scrawl'),
  ) || null;
}

let pendingFile = fileFromArgv(process.argv);

async function sendOpenFile(filePath, target = focusedWin()) {
  if (!target || target.isDestroyed()) return;
  try {
    const json = await fs.readFile(filePath, 'utf8');
    target.webContents.send('file:open-external', { json, path: filePath });
  } catch (err) {
    console.error(`[abrir] ${filePath}: ${err.message}`);
  }
}

/* Donde y de que tamano nace una ventana.
 *
 * La primera va centrada a mano sobre el area util del display primario
 * (descuenta la taskbar). Va a mano porque la ventana se crea con x/y explicitos
 * fuera de pantalla, y eso desactiva el auto-centrado de Electron.
 *
 * Una abierta desde otra sale en cascada: el tamano de la que la abrio, corrida
 * 40px hacia abajo y a la derecha, para que se vea que hay dos y no que la
 * primera se recargo. Si con eso se saldria de su display vuelve al borde. Y si
 * la que la abrio estaba maximizada, la nueva se maximiza tambien — quien
 * trabaja a pantalla completa con la tableta quiere la segunda hoja igual, no
 * una ventana chica que hay que ir a agrandar. */
const CASCADE = 40;

function placeFor(opener) {
  if (!opener || opener.isDestroyed()) {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(x + (width - WIN_W) / 2),
      y: Math.round(y + (height - WIN_H) / 2),
      w: WIN_W, h: WIN_H, maximize: false,
    };
  }
  const b = opener.getNormalBounds();
  const wa = screen.getDisplayMatching(opener.getBounds()).workArea;
  let x = b.x + CASCADE;
  let y = b.y + CASCADE;
  if (x + b.width > wa.x + wa.width) x = wa.x;
  if (y + b.height > wa.y + wa.height) y = wa.y;
  return { x, y, w: b.width, h: b.height, maximize: opener.isMaximized() };
}

/* opener  la ventana desde la que se pidio esta, o null para la primera
 * seed    medida a heredar ({ w, h, dpi, paper }): la ventana nueva abre con la
 *         hoja de la que la abrio, por el mismo motivo que Ctrl+N. Viaja por la
 *         linea de comandos del renderer porque tiene que estar ANTES de crear
 *         el documento — crearlo en A4 y reemplazarlo despues costaria cuatro
 *         lienzos de 35 MB para nada. */
function createWindow({ opener = null, seed = null } = {}) {
  // la primera ventana es la que corre los modos de verificacion y recibe el
  // archivo de la linea de comandos: son cosas del arranque, no de cada ventana
  const primary = windows.size === 0;
  const at = placeFor(opener);

  const win = new BrowserWindow({
    /* Crear fuera de pantalla: el flash del compositor DWM ocurre en el primer
     * show() del HWND y no se puede evitar, solo mover a donde nadie lo vea. A
     * -20000 queda fuera de cualquier monitor, incluso en setups multi-pantalla
     * hacia la izquierda o arriba. La ventana se snapea a su lugar despues. */
    x: -20000,
    y: -20000,
    width: at.w,
    height: at.h,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: BG,
    show: false,
    // fuerza a Chromium a pintar el primer frame con la ventana oculta, asi el
    // show() off-screen ya encuentra contenido y 'ready-to-show' dispara
    paintWhenInitiallyHidden: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: seed ? [`--scrawl-seed=${JSON.stringify(seed)}`] : [],
    },
  });

  windows.add(win);
  win.on('focus', () => { lastFocused = win; });
  win.on('closed', () => {
    windows.delete(win);
    if (lastFocused === win) lastFocused = null;
  });

  if (SELFTEST) {
    win.loadURL('scrawl://app/selftest.html');
  } else {
    const query = UI_SHOT ? `?ui=${UI_MODE}` : '';
    win.loadURL(`scrawl://app/index.html${query}`);
  }

  win.once('ready-to-show', () => {
    // el autotest no necesita mostrarse: corre y reporta por consola
    if (SELFTEST) return;
    // El flash DWM ocurre aca — off-screen, invisible.
    win.show();
    /* Dejar que DWM asiente la superficie off-screen antes de mover. Mover
     * demasiado rapido dispara un segundo flash, esta vez en el destino: 200ms
     * es el valor validado, 120 resulto intermitente. */
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setPosition(at.x, at.y);
      // recien despues de estar en su display: maximizar desde -20000 la
      // mandaria al monitor que Windows considere mas cercano a la nada
      if (at.maximize) win.maximize();
    }, 200);
    if (DEV && !UI_SHOT) win.webContents.openDevTools({ mode: 'detach' });
  });

  if (DEV || UI_SHOT || SELFTEST) {
    /* Electron 40 entrega un objeto de evento; las versiones viejas, argumentos
     * sueltos. Se soportan los dos para que esto no se rompa en un upgrade. */
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      const msg = e && typeof e === 'object' && 'message' in e
        ? `${e.message}  (${e.sourceId}:${e.lineNumber})`
        : `${args[2]}  (${args[4]}:${args[3]})`;
      console.log(`[renderer] ${msg}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[carga fallida] ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer caido]', JSON.stringify(details));
    });
  }

  /* El renderer dibuja su propia barra de titulo, asi que necesita saber en que
   * estado esta la ventana para cambiar el icono de maximizar. */
  const pushState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('window:state', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', pushState);
  win.on('unmaximize', pushState);

  if (SELFTEST && primary) {
    win.webContents.once('did-finish-load', async () => {
      /* Se sondea window.__scrawlTest en vez de esperar un IPC: el autotest
       * importa solo modulos del motor y no depende del preload, asi que no
       * tiene por donde mandar un mensaje. */
      const deadline = Date.now() + 30000;
      let report = null;
      while (Date.now() < deadline) {
        report = await win.webContents.executeJavaScript('window.__scrawlTest || null');
        if (report) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      if (!report) {
        console.error('[selftest] no termino dentro de 30s');
        app.exit(1);
        return;
      }
      const passed = report.total - report.failed;
      console.log(`\n[selftest] ${passed}/${report.total} pasaron`);
      app.exit(report.failed ? 1 : 0);
    });
  }

  if (FAKE_UPDATE && primary) {
    /* Estado de actualizacion simulado, para poder mirar ese aviso sin esperar a
     * que exista un release nuevo. Las notas van en HTML como las manda GitHub:
     * asi el simulacro tambien ejercita el pasaje a texto plano. */
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => setUpdateState(FAKE_UPDATE, {
        version: '0.4.0',
        notes: plainNotes('<ul><li>Canvas Size: A4, Letter &amp; friends</li>'
          + '<li>PDF pages now match the paper exactly</li></ul>'
          + '<p>Fixed a cursor glitch over the puck core.</p>'),
        percent: 42,
      }), 600);
    });
  }

  if (UI_SHOT && primary) {
    win.webContents.once('did-finish-load', async () => {
      /* Margen para que el lienzo haya dibujado y las animaciones de entrada
       * hayan terminado; una captura antes de eso muestra una app a medio
       * armar. En modo demo se suma el tiempo de los trazos sinteticos. */
      await new Promise((r) => setTimeout(r, UI_DRAWS ? 4000 : 2600));
      const img = await win.webContents.capturePage();
      await fs.mkdir(path.dirname(UI_SHOT), { recursive: true });
      await fs.writeFile(UI_SHOT, img.toPNG());
      console.log(`[ui] ${UI_SHOT}`);
      app.quit();
    });
  }

  if (pendingFile && !SELFTEST && primary) {
    // recien cuando el renderer monto: antes no hay quien reciba el mensaje
    win.webContents.once('did-finish-load', () => {
      const f = pendingFile;
      pendingFile = null;
      sendOpenFile(f, win);
    });
  }

  return win;
}

/* Una sola instancia. Sin esto, cada doble clic en un .scrawl abriria otra copia
 * de la app en vez de abrir el dibujo en la que ya esta corriendo — y con dos
 * ventanas sobre el mismo archivo, la ultima en guardar pisa a la otra. */
/* Los modos de verificacion quedan afuera del lock a proposito: son procesos
 * efimeros y, si pidieran el lock con la app abierta, se cerrarian en silencio y
 * parecerian un test que "no imprime nada". */
/* Una copia de prueba conviviendo con la app instalada: el lock se deriva de la
 * carpeta userData, asi que con otra carpeta es otro lock. Lo usa el driver de
 * la skill run-scrawl; un usuario nunca define esta variable. Va antes de pedir
 * el lock porque despues ya no cambia nada. */
if (process.env.SCRAWL_USER_DATA) app.setPath('userData', process.env.SCRAWL_USER_DATA);

const gotLock = (SELFTEST || UI_SHOT) ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  /* Con varias ventanas, el archivo va a la ultima que tuvo foco — el mismo
   * lugar al que iba cuando habia una sola: el dibujo abierto ahi se reemplaza,
   * como siempre. Abrirlo en una ventana nueva seria otro flujo, no este. */
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    const target = focusedWin();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    if (f) sendOpenFile(f, target);
  });

  // 'screen' recien existe despues de whenReady, de ahi que el centrado viva adentro.
  app.whenReady().then(() => {
    registerProtocol();
    createWindow();
    initUpdates();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (windows.size === 0) createWindow();
});

// ── controles de ventana ────────────────────────────────────────────────────
// cada uno actua sobre la ventana que lo pidio, no sobre "la" ventana
ipcMain.on('window:minimize', (e) => senderWin(e)?.minimize());
ipcMain.on('window:toggle-maximize', (e) => {
  const win = senderWin(e);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (e) => senderWin(e)?.close());
ipcMain.handle('window:is-maximized', (e) => senderWin(e)?.isMaximized() ?? false);

/* Otra ventana, o sea otro documento abierto a la vez. Es la forma de tener dos
 * dibujos a la vista y pasar cosas de uno al otro por el portapapeles: copiar
 * una capa aca, pegarla alla. Hereda la medida de la que la abre. */
ipcMain.on('window:new', (e, seed) => {
  createWindow({ opener: senderWin(e), seed: seed || null });
});

ipcMain.on('doc:dirty', (e, on) => {
  const win = senderWin(e);
  if (!win) return;
  if (on) dirtyWins.add(win);
  else dirtyWins.delete(win);
});

// ── archivos ────────────────────────────────────────────────────────────────
/* El renderer hornea los bytes (es el unico que tiene los canvas); el main solo
 * elige ruta y escribe. */

ipcMain.handle('file:export-png', async (e, { data, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(senderWin(e), {
    title: 'Export PNG',
    defaultPath: suggestedName || 'scrawl.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, Buffer.from(data));
  return { ok: true, path: filePath };
});

/* El PDF llega ya armado desde el renderer (ver renderer/js/engine/pdf.js): es el
 * unico que tiene los pixeles, y el navegador trae DEFLATE de fabrica. Aca solo se
 * elige la ruta y se escribe, igual que con el PNG. */
ipcMain.handle('file:export-pdf', async (e, { data, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(senderWin(e), {
    title: 'Export PDF',
    defaultPath: suggestedName || 'scrawl.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, Buffer.from(data));
  return { ok: true, path: filePath };
});

ipcMain.handle('file:save-doc', async (e, { json, suggestedName, path: known }) => {
  let filePath = known || null;
  if (!filePath) {
    const res = await dialog.showSaveDialog(senderWin(e), {
      title: 'Save drawing',
      defaultPath: suggestedName || 'untitled.scrawl',
      filters: [{ name: 'Scrawl drawing', extensions: ['scrawl'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    filePath = res.filePath;
  }
  await fs.writeFile(filePath, json, 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('file:open-doc', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWin(e), {
    title: 'Open drawing',
    properties: ['openFile'],
    filters: [{ name: 'Scrawl drawing', extensions: ['scrawl'] }],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const json = await fs.readFile(filePaths[0], 'utf8');
  return { ok: true, json, path: filePaths[0] };
});

ipcMain.handle('file:open-image', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWin(e), {
    title: 'Open image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const buf = await fs.readFile(filePaths[0]);
  return { ok: true, data: buf, path: filePaths[0] };
});

// ── portapapeles ────────────────────────────────────────────────────────────

// las mismas que acepta el dialogo de importar, y las mismas que baseName sabe
// sacarle a un nombre de archivo
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

/* Ruta de imagen dejada en el portapapeles COMO ARCHIVO en vez de como pixeles.
 *
 * No es un caso raro: ShareX — y varios capturadores mas — vienen configurados
 * para copiar el archivo guardado, no el bitmap. El portapapeles queda entonces
 * con una lista de archivos y ni una imagen a la vista. Los chats lo pegan igual
 * porque saben leer archivos, asi que desde afuera parece que la captura esta
 * ahi y que la app que no la ve esta rota. Windows sintetiza FileNameW a partir
 * de la lista, que es la via mas simple de leerla; con varios archivos copiados
 * entrega el primero, que es justo lo que uno querria pegar. */
function clipboardImagePath() {
  for (const [format, enc] of [['FileNameW', 'ucs2'], ['FileName', 'latin1']]) {
    let buf = null;
    try { buf = clipboard.readBuffer(format); } catch { continue; }
    if (!buf || !buf.length) continue;
    // el formato viene terminado en NUL; la ruta es lo de antes
    const file = buf.toString(enc).split('\0')[0].trim();
    if (file && IMAGE_EXT.includes(path.extname(file).toLowerCase())) return file;
  }
  return null;
}

/* Pegar una captura es el otro uso central de la app, asi que el puente al
 * portapapeles va cableado desde el arranque aunque la UI de anotacion venga
 * despues.
 *
 * Devuelve los bytes crudos de la imagen — PNG si venia como pixeles, el archivo
 * tal cual si venia como ruta — o null si no hay nada pegable. El renderer los
 * decodifica igual en los dos casos, asi que no hace falta normalizar el formato
 * aca: reencodear un JPEG a PNG solo agregaria una perdida de calidad. */
/* Una capa copiada desde Scrawl viaja por el portapapeles de dos formas a la
 * vez, en una sola escritura:
 *
 *   image  el PNG de siempre, para que cualquier otra app la pegue como imagen
 *   html   un <img> con ese MISMO PNG adentro (data URL) y la marca de la capa —
 *          nombre, opacidad, blend y en que punto del lienzo estaba
 *
 * El HTML es el unico lugar donde entra la marca: Electron no deja agregar un
 * formato propio junto a la imagen (cada escritura vacia el portapapeles), y un
 * texto plano con JSON aparece como basura en cualquier campo de texto. El HTML
 * solo lo miran las apps que saben que hacer con el, y ademas trae el PNG
 * intacto: los bytes que se pegan en la otra ventana son los que se copiaron,
 * sin pasar por el bitmap del sistema. */
const LAYER_MARK = 'data-scrawl-layer';

ipcMain.handle('clipboard:write-layer', (_e, { data, meta }) => {
  const png = Buffer.from(data);
  const mark = encodeURIComponent(JSON.stringify(meta));
  const html = `<img src="data:image/png;base64,${png.toString('base64')}" ${LAYER_MARK}="${mark}">`;
  clipboard.write({ image: nativeImage.createFromBuffer(png), html });
  return { ok: true };
});

/* La marca de una capa de Scrawl, si el portapapeles trae una: { data, layer }
 * o null. Se mira ANTES que la imagen a secas — es la misma imagen, pero con
 * nombre y posicion — y solo se reconoce la propia: el HTML que deja un
 * navegador al copiar una foto no la tiene y sigue el camino de siempre. */
function clipboardLayer() {
  const html = clipboard.readHTML();
  if (!html) return null;
  const mark = html.match(new RegExp(`${LAYER_MARK}="([^"]+)"`));
  const src = html.match(/src="data:image\/png;base64,([^"]+)"/);
  if (!mark || !src) return null;
  try {
    return { data: Buffer.from(src[1], 'base64'), layer: JSON.parse(decodeURIComponent(mark[1])) };
  } catch {
    return null;
  }
}

ipcMain.handle('clipboard:read-image', async () => {
  const own = clipboardLayer();
  if (own) return own;

  const img = clipboard.readImage();
  if (img && !img.isEmpty()) return { data: img.toPNG() };

  const file = clipboardImagePath();
  if (!file) return null;
  try {
    return { data: await fs.readFile(file), path: file };
  } catch (err) {
    // la ruta puede apuntar a algo ya borrado o a una unidad desconectada
    console.error(`[portapapeles] ${file}: ${err.message}`);
    return null;
  }
});

ipcMain.handle('clipboard:write-image', (_e, { data }) => {
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data)));
  return { ok: true };
});

// ── actualizaciones ─────────────────────────────────────────────────────────

/* Se mira el release mas nuevo de GitHub y, si hay uno, se avisa. Dos decisiones
 * definen como se siente:
 *
 *   autoDownload = false — el aviso llega solo, la descarga la decide el
 *     usuario. Bajar cien megas sin preguntar, con la conexion que tenga y
 *     mientras dibuja, no es una cortesia.
 *   autoInstallOnAppQuit = true — una vez descargada, si no aprieta "reiniciar"
 *     la actualizacion se aplica cuando cierre la app por su cuenta. Nunca a
 *     mitad de un dibujo.
 *
 * El portable queda afuera a proposito: corre desde una extraccion temporal y no
 * hay instalacion que reemplazar, asi que meterle el instalador encima
 * convertiria en instalado a alguien que eligio no estarlo. Ahi el aviso llega
 * igual, pero lleva a la pagina del release en vez de descargar. */

const RELEASES_URL = 'https://github.com/kiddshady/Scrawl/releases/latest';

// el primer chequeo espera a que la app termine de montar; despues, cada tantas horas
const UPDATE_FIRST = 10 * 1000;
const UPDATE_EVERY = 6 * 60 * 60 * 1000;

/* electron-builder le pasa esta variable al portable con la carpeta desde la que
 * se ejecuto: es la unica forma de saber, desde adentro, cual de los dos
 * paquetes esta corriendo. */
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

/* Lo ultimo que se supo. Existe porque el primer chequeo puede resolverse antes
 * de que el renderer termine de montar, y un mensaje mandado a una ventana que
 * todavia no escucha se pierde sin dejar rastro. */
let updateState = { status: 'idle' };

function setUpdateState(status, extra = {}) {
  updateState = { status, portable: PORTABLE, current: app.getVersion(), ...extra };
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send('update:state', updateState);
  }
}

/* Las notas del release vienen como HTML desde GitHub. Se pasan a texto plano
 * aca en vez de mandarlas al renderer: nada que llega por la red se inyecta como
 * marcado, y el dialogo las muestra como lo que son, un texto. */
function plainNotes(notes) {
  const raw = Array.isArray(notes)
    ? notes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n\n')
    : String(notes || '');
  return raw
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<\/(p|div|li|h\d|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // &amp; se decodifica al final: al reves, un "&amp;lt;" terminaria en "<"
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1500);
}

function initUpdates() {
  /* Sin empaquetar no hay version instalada contra la cual comparar, y los modos
   * de verificacion son procesos efimeros que no tienen por que salir a la red. */
  if (!app.isPackaged || SELFTEST || UI_SHOT) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // sin electron-log: lo que pasa se cuenta por consola y por el estado
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    setUpdateState('available', { version: info.version, notes: plainNotes(info.releaseNotes) });
  });
  autoUpdater.on('update-not-available', () => setUpdateState('idle'));
  autoUpdater.on('download-progress', (p) => {
    setUpdateState('downloading', {
      version: updateState.version,
      notes: updateState.notes,
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState('ready', { version: info.version, notes: updateState.notes });
  });

  /* Un chequeo que falla no es un problema del usuario: sin internet, o con
   * GitHub caido, esto tiene que seguir siendo una app de dibujo. Se anota, se
   * vuelve al estado anterior y se reintenta en el proximo ciclo. */
  autoUpdater.on('error', (err) => {
    const message = String((err && err.message) || err);
    console.error(`[update] ${message}`);
    setUpdateState(updateState.status === 'downloading' ? 'available' : 'idle', {
      version: updateState.version,
      notes: updateState.notes,
      error: message,
    });
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* ya lo reporta 'error' */ });
  setTimeout(check, UPDATE_FIRST);
  setInterval(check, UPDATE_EVERY);
}

ipcMain.handle('update:state', () => ({
  ...updateState, portable: PORTABLE, current: app.getVersion(),
}));

/* Devuelve el estado resultante, y no solo un ok. El renderer tambien lo recibe
 * por el canal de siempre, pero ese mensaje viaja por su cuenta: quien pregunto
 * "hay actualizacion?" tendria que decidir que contestar antes de que llegue, y
 * ahi diria "estas al dia" justo cuando acaba de encontrar una. */
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, state: { ...updateState, portable: PORTABLE, current: app.getVersion() } };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

ipcMain.on('update:download', () => {
  if (updateState.status !== 'available') return;
  if (PORTABLE) { shell.openExternal(RELEASES_URL); return; }
  setUpdateState('downloading', {
    version: updateState.version, notes: updateState.notes, percent: 0,
  });
  autoUpdater.downloadUpdate().catch(() => { /* ya lo reporta 'error' */ });
});

ipcMain.handle('update:install', (e) => {
  /* Sin nada descargado, quitAndInstall cierra la app y no instala nada: seria
   * perder el trabajo a cambio de nada. */
  if (updateState.status !== 'ready') return { ok: false, reason: 'not-ready' };
  /* Reiniciar cierra TODAS las ventanas. El dialogo que lo pidio avisa si su
   * dibujo esta sin guardar, pero no ve a las demas: si otra tiene trabajo
   * pendiente, no se reinicia y se le dice a quien pidio. */
  const me = senderWin(e);
  for (const w of windows) {
    if (w !== me && !w.isDestroyed() && dirtyWins.has(w)) return { ok: false, reason: 'other-dirty' };
  }
  /* Silencioso y volviendo a abrir sola: la actualizacion es un tramite, no una
   * visita al instalador. Si el modo silencioso no prosperara, autoInstallOnAppQuit
   * sigue en pie y el instalador aparece al cerrar. */
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
});

ipcMain.on('update:page', () => shell.openExternal(RELEASES_URL));
