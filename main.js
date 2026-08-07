'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, protocol, screen, clipboard, nativeImage,
} = require('electron');
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
 *         habria forma de mirarlo sin estar sentado frente a la app */
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

let win = null;

/* Ruta de un .scrawl pasada por linea de comandos: es como Windows entrega el
 * archivo al hacer doble clic, una vez registrada la asociacion. */
function fileFromArgv(argv) {
  return argv.slice(1).find(
    (a) => !a.startsWith('--') && a.toLowerCase().endsWith('.scrawl'),
  ) || null;
}

let pendingFile = fileFromArgv(process.argv);

async function sendOpenFile(filePath) {
  if (!win || win.isDestroyed()) return;
  try {
    const json = await fs.readFile(filePath, 'utf8');
    win.webContents.send('file:open-external', { json, path: filePath });
  } catch (err) {
    console.error(`[abrir] ${filePath}: ${err.message}`);
  }
}

function createWindow() {
  /* Centrado a mano sobre el area util del display primario (descuenta la
   * taskbar). Va a mano porque abajo pasamos x/y explicitos para crear la
   * ventana fuera de pantalla, y eso desactiva el auto-centrado de Electron. */
  const { x: waX, y: waY, width: waW, height: waH } = screen.getPrimaryDisplay().workArea;
  const winX = Math.round(waX + (waW - WIN_W) / 2);
  const winY = Math.round(waY + (waH - WIN_H) / 2);

  win = new BrowserWindow({
    /* Crear fuera de pantalla: el flash del compositor DWM ocurre en el primer
     * show() del HWND y no se puede evitar, solo mover a donde nadie lo vea. A
     * -20000 queda fuera de cualquier monitor, incluso en setups multi-pantalla
     * hacia la izquierda o arriba. La ventana se snapea al centro despues. */
    x: -20000,
    y: -20000,
    width: WIN_W,
    height: WIN_H,
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
    },
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
      if (win && !win.isDestroyed()) win.setPosition(winX, winY);
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

  if (SELFTEST) {
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

  if (UI_SHOT) {
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

  if (pendingFile && !SELFTEST) {
    // recien cuando el renderer monto: antes no hay quien reciba el mensaje
    win.webContents.once('did-finish-load', () => {
      const f = pendingFile;
      pendingFile = null;
      sendOpenFile(f);
    });
  }

  win.on('closed', () => { win = null; });
}

/* Una sola instancia. Sin esto, cada doble clic en un .scrawl abriria otra copia
 * de la app en vez de abrir el dibujo en la que ya esta corriendo — y con dos
 * ventanas sobre el mismo archivo, la ultima en guardar pisa a la otra. */
/* Los modos de verificacion quedan afuera del lock a proposito: son procesos
 * efimeros y, si pidieran el lock con la app abierta, se cerrarian en silencio y
 * parecerian un test que "no imprime nada". */
const gotLock = (SELFTEST || UI_SHOT) ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (f) sendOpenFile(f);
  });

  // 'screen' recien existe despues de whenReady, de ahi que el centrado viva adentro.
  app.whenReady().then(() => {
    registerProtocol();
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── controles de ventana ────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win && win.close());
ipcMain.handle('window:is-maximized', () => (win ? win.isMaximized() : false));

// ── archivos ────────────────────────────────────────────────────────────────
/* El renderer hornea los bytes (es el unico que tiene los canvas); el main solo
 * elige ruta y escribe. */

ipcMain.handle('file:export-png', async (_e, { data, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
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
ipcMain.handle('file:export-pdf', async (_e, { data, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export PDF',
    defaultPath: suggestedName || 'scrawl.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, Buffer.from(data));
  return { ok: true, path: filePath };
});

ipcMain.handle('file:save-doc', async (_e, { json, suggestedName, path: known }) => {
  let filePath = known || null;
  if (!filePath) {
    const res = await dialog.showSaveDialog(win, {
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

ipcMain.handle('file:open-doc', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open drawing',
    properties: ['openFile'],
    filters: [{ name: 'Scrawl drawing', extensions: ['scrawl'] }],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const json = await fs.readFile(filePaths[0], 'utf8');
  return { ok: true, json, path: filePaths[0] };
});

ipcMain.handle('file:open-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
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
ipcMain.handle('clipboard:read-image', async () => {
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
