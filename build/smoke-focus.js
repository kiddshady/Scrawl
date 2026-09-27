/* Smoke de los anillos de foco: abre Scrawl, enfoca cada control como con el
 * teclado y mide si su anillo queda entero. Es el auditor del humo de Onyx
 * (build/anillos.js): pasó en sus controles de ventana, en el segmentado y en
 * todo lo que va de borde a borde de algo que recorta.
 *
 * Se mide la ventana principal y el modal de tamaño de lienzo, que es el único
 * con controles propios (segmentado, grilla de anclaje, campos numéricos). */

const assert = require('node:assert/strict');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { auditarAnillos } = require('./anillos.js');

const appRoot = path.resolve(__dirname, '..');

(async () => {
  let electronApp;
  const cortes = [];
  try {
    electronApp = await electron.launch({ args: [appRoot, '--smoke'], cwd: appRoot });
    const page = await electronApp.firstWindow();
    await page.waitForSelector('#sc-app.ready');
    await page.waitForTimeout(600);

    // Sin foco en la ventana :focus-visible no se aplica y todo anillo mide
    // cero: la auditoría pasaría sin haber medido nada.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.focus();
      w.webContents.focus();
    });
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.hasFocus()), 'la ventana no tiene el foco: no hay anillos que medir');

    for (const c of await page.evaluate(auditarAnillos())) cortes.push('ventana: ' + c);

    // El modal de tamaño de lienzo, abierto con su atajo y NO con clicks: un
    // click real deja a Chromium en modalidad mouse, y ahí :focus-visible no
    // matchea aunque se enfoque a mano — el modal pasaba sin medir nada.
    await page.keyboard.press('Control+Alt+C');
    await page.waitForTimeout(500);
    const vivo = await page.evaluate(() => {
      const b = document.querySelector('.sc-modal .sc-seg__btn');
      if (!b) return 'no hay modal con segmentado';
      b.focus();
      const ok = b.matches(':focus-visible');
      b.blur();
      return ok || 'el foco no es de teclado: no hay anillos que medir';
    });
    if (vivo !== true) cortes.push('modal: ' + vivo);
    else for (const c of await page.evaluate(auditarAnillos('.sc-modal'))) cortes.push('modal: ' + c);
    await page.evaluate(() => document.getElementById('aud-notr')?.remove());

    assert.equal(cortes.length, 0, 'anillos cortados:\n  ' + cortes.join('\n  '));
    console.log('[smoke:focus] ningún anillo de foco se corta ni roza un canto');
  } finally {
    if (electronApp) await electronApp.close();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
