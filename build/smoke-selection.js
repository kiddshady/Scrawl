/* Smoke real de la seleccion: abre Electron, usa el renderer como una persona y
 * verifica el cableado entre toolbar, Pointer Events, historial y teclado.
 *
 * No prueba Ctrl+C/Ctrl+X aca porque escribirian sobre el portapapeles real de
 * quien corre el test. El recorte y el borrado de pixeles se cubren en selftest;
 * este smoke se queda deliberadamente dentro de la ventana de Scrawl. */

const assert = require('node:assert/strict');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const appRoot = path.resolve(__dirname, '..');

(async () => {
  let electronApp;
  try {
    electronApp = await electron.launch({ args: [appRoot, '--smoke'], cwd: appRoot });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('#sc-app.ready');
    // ready arranca el fade del splash; hasta que termina, ese nodo todavia
    // cubre el canvas y se queda con los eventos del mouse.
    await page.waitForTimeout(600);

    const canvas = page.locator('#sc-canvas');
    const box = await canvas.boundingBox();
    assert(box, 'el canvas no tiene geometria');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Un trazo ancho por el centro garantiza contenido dentro de la seleccion.
    await page.mouse.move(cx - 110, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 110, cy, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    assert.match(await page.locator('#sc-st-hist').innerText(), /^1\b/, 'el trazo no entro al historial');

    const select = page.locator('[data-tool="select"]');
    await select.click();
    assert(await select.evaluate((el) => el.classList.contains('on')), 'la herramienta no quedo activa');
    assert.equal(await canvas.evaluate((el) => getComputedStyle(el).cursor), 'crosshair');

    await page.mouse.move(cx - 65, cy - 35);
    await page.mouse.down();
    await page.mouse.move(cx + 65, cy + 35, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    assert.match(await page.locator('#sc-st-hint').innerText(), /^Selected \d+×\d+/);

    // Delete tiene que crear un paso; undo debe devolver exactamente al anterior.
    await page.keyboard.press('Delete');
    await page.waitForTimeout(80);
    assert.match(await page.locator('#sc-st-hist').innerText(), /^2\b/, 'borrar no creo un paso');
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(80);
    assert.match(await page.locator('#sc-st-hist').innerText(), /^1\b/, 'undo no devolvio el fragmento');

    await page.keyboard.press('Escape');
    assert.match(await page.locator('#sc-st-hint').innerText(), /^Drag around an area/);

    console.log('[smoke:selection] toolbar, arrastre, Delete, undo y Escape pasaron');
  } finally {
    if (electronApp) await electronApp.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
