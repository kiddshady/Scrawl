/* Driver REPL para lanzar y manejar Scrawl desde un agente (o a mano).
 * Lee comandos de stdin, uno por linea. Sirve interactivo o por pipe:
 *
 *   printf "launch\nss demo\nquit\n" | node .claude/skills/run-scrawl/driver.mjs
 *
 * Las capturas van a .shots/ (gitignoreado, el mismo lugar que npm run shot).
 * Las coordenadas de los comandos de puntero son px CSS de la ventana; `box`
 * imprime el rectangulo del lienzo para apuntar adentro. */
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOTS = path.join(APP_DIR, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

let app = null;
let page = null;
let shotN = 0;

/* El entorno de un agente de Claude puede traer ELECTRON_RUN_AS_NODE=1; con eso
 * Electron arranca como Node pelado y la ventana no existe nunca. */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const need = () => { if (!page) { console.log('ERROR: primero launch'); return true; } return false; };
const n = (v) => parseFloat(v);

const COMMANDS = {
  async launch() {
    if (app) return console.log('ya lanzado');
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules/electron/dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron'),
      args: [APP_DIR],
      env,
      timeout: 30_000,
    });
    try {
      page = await app.firstWindow();
      // 'ready' lo pone boot() al final; despues quedan el fade del splash y el
      // reposicionamiento de la ventana (nace off-screen y se mueve a los 200ms)
      await page.waitForSelector('#sc-app.ready', { timeout: 20_000 });
      await page.waitForTimeout(1200);
      console.log('lanzado.');
    } catch (e) {
      console.log('ERROR:', e.message.split('\n')[0]);
      console.log('¿Scrawl ya estaba abierto? El lock de instancia unica cierra la copia de prueba en silencio — cerra la app y proba de nuevo.');
      await app.close().catch(() => {});
      app = null; page = null;
    }
  },

  async ss(name) {
    if (need()) return;
    const f = path.join(SHOTS, (name || `driver-${++shotN}`) + '.png');
    await page.screenshot({ path: f });
    console.log('captura:', f);
  },

  async box() {
    if (need()) return;
    const b = await page.locator('#sc-canvas').boundingBox();
    console.log(JSON.stringify(b));
  },

  // teclas de herramienta: b p m a e l g i h (las mismas de la app)
  async tool(key) {
    if (need()) return;
    await page.keyboard.press(key.trim());
    console.log('herramienta:', key.trim());
  },

  async hover(args) {
    if (need()) return;
    const [x, y] = args.split(/\s+/).map(n);
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(100);
  },

  /* down / move / up sueltos: permiten frenar A MITAD de un trazo — capturar con
   * el boton apretado es como se verifica lo que solo existe durante el gesto
   * (el anillo del pincel, el wet, la linea elastica de shift). */
  async down() { if (!need()) { await page.mouse.down(); await page.waitForTimeout(80); } },
  async up()   { if (!need()) { await page.mouse.up();   await page.waitForTimeout(80); } },
  async move(args) {
    if (need()) return;
    const [x, y, steps] = args.split(/\s+/).map(n);
    await page.mouse.move(x, y, { steps: steps || 12 });
    await page.waitForTimeout(100);
  },

  // gesto completo de una vez, para cuando el durante no importa
  async stroke(args) {
    if (need()) return;
    const [x1, y1, x2, y2] = args.split(/\s+/).map(n);
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(x2, y2, { steps: 24 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(80);
    console.log(`trazo (${x1},${y1}) -> (${x2},${y2})`);
  },

  // posicion del puntero en coordenadas de documento, como la ve el usuario
  async pos() {
    if (need()) return;
    console.log(await page.locator('#sc-st-pos').innerText());
  },

  async click(sel) {
    if (need()) return;
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NO_EXISTE';
      el.click();
      return 'OK';
    }, sel);
    console.log('click', sel, '->', r);
  },

  async press(key) { if (!need()) await page.keyboard.press(key.trim()); },
  async type(text) { if (!need()) await page.keyboard.type(text, { delay: 25 }); },

  async text(sel) {
    if (need()) return;
    console.log(await page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null,
    ));
  },

  async eval(expr) {
    if (need()) return;
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message.split('\n')[0]); }
  },

  async quit() {
    if (app) await app.close().catch(() => {});
    app = null; page = null;
  },

  help() { console.log('comandos:', Object.keys(COMMANDS).join(', ')); },
};

const tty = process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? 'driver> ' : '' });

/* Los comandos se encadenan en serie. Por pipe, readline entrega todas las
 * lineas de una: sin la cadena, todo lo que sigue a launch correria antes de
 * que la ventana exista. */
let chain = Promise.resolve();

rl.on('line', (line) => {
  chain = chain.then(async () => {
    const t = line.trim();
    if (!t) return rl.prompt();
    const sp = t.indexOf(' ');
    const cmd = sp === -1 ? t : t.slice(0, sp);
    const rest = sp === -1 ? '' : t.slice(sp + 1);
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('no existe:', cmd, '— proba: help'); return rl.prompt(); }
    try { await fn(rest); } catch (e) { console.log('ERROR:', e.message.split('\n')[0]); }
    if (cmd === 'quit') process.exit(0);
    rl.prompt();
  });
});

// el EOF del pipe llega enseguida: hay que drenar la cola antes de salir
rl.on('close', () => {
  chain = chain.then(async () => { await COMMANDS.quit(); process.exit(0); });
});

if (tty) console.log('driver de Scrawl — "help" lista los comandos, "launch" abre la app');
rl.prompt();
