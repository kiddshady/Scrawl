/* Autotest del motor.
 *
 * Corre con:  npm run test     (o  npx electron . --selftest )
 *
 * Prueba el motor sin la interfaz: importa doc/brush/history/fill directo y
 * verifica pixeles. Existe porque las cosas que mas facil se rompen en una app de
 * dibujo son invisibles en una captura de pantalla — que el undo restaure exacto,
 * que un trazo semitransparente no se oscurezca donde se cruza consigo mismo, que
 * recomponer una region de un rectangulo de un trazo de el mismo resultado que
 * recomponer el lienzo entero. Un cambio en el motor se verifica corriendo esto,
 * no mirando y confiando. */

import { ScrawlDoc, clampRect } from '../engine/doc.js';
import { Painter, makeBrush } from '../engine/brush.js';
import {
  History, pixelEntry, grab, snapshotCanvas, fullLayerEntry, layersEntry, docState,
} from '../engine/history.js';
import { floodFill } from '../engine/fill.js';

const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

function ok(name, cond, detail = '') { check(name, !!cond, detail); }

function near(a, b, tol, name, detail = '') {
  check(name, Math.abs(a - b) <= tol, detail || `${a} vs ${b} (tol ${tol})`);
}

function px(layer, x, y) {
  const d = layer.ctx.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

function pxOf(canvas, x, y) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/* Cierra un trazo igual que lo hace la app: captura el antes, compone, captura
 * el despues y arma la entrada de historial. */
function commitStroke(doc, painter, history, label = 'stroke') {
  const layer = doc.active;
  const rect = clampRect(painter.dirty, doc.width, doc.height);
  const before = grab(layer, rect);
  painter.commit(layer);
  const after = grab(layer, rect);
  history.push(pixelEntry(layer, rect, before, after, label));
  doc.recompose(rect);
  return rect;
}

// ── 1. trazo, undo, redo ────────────────────────────────────────────────────

function testUndoRedo() {
  const doc = new ScrawlDoc(200, 200);
  const painter = new Painter(doc);
  const history = new History();
  const layer = doc.active;

  const brush = makeBrush('pencil');
  brush.size = 20;
  painter.begin(brush, '#ff0000');
  painter.segment({ x: 50, y: 100, p: 1 }, { x: 150, y: 100, p: 1 });
  commitStroke(doc, painter, history);

  const painted = px(layer, 100, 100);
  ok('trazo deja pixel opaco', painted.a > 200, `alpha=${painted.a}`);
  ok('trazo usa el color pedido', painted.r > 200 && painted.g < 40, `rgb=${painted.r},${painted.g},${painted.b}`);

  history.undo();
  ok('undo devuelve el pixel a transparente', px(layer, 100, 100).a === 0, `alpha=${px(layer, 100, 100).a}`);

  history.redo();
  ok('redo vuelve a pintar', px(layer, 100, 100).a > 200);

  ok('el historial solo guarda el bbox del trazo, no el lienzo',
    history.bytes < 200 * 200 * 4 * 2,
    `${history.bytes} bytes para un trazo de 100x20 en 200x200`);
}

// ── 2. la capa wet no acumula sobre si misma ────────────────────────────────

/* Este es EL test del diseno de la capa wet. Un trazo con opacidad 50% que se
 * cruza consigo mismo tiene que dar el mismo alpha en el cruce que en los
 * brazos. Si el trazo se pintara directo sobre la capa, el cruce quedaria en
 * ~75% y se veria una mancha oscura en cada superposicion. */
function testWetNoBuildup() {
  const doc = new ScrawlDoc(200, 200);
  const painter = new Painter(doc);
  const history = new History();
  const layer = doc.active;

  const brush = makeBrush('pencil');
  brush.size = 24;
  brush.opacity = 0.5;

  painter.begin(brush, '#ffffff');
  // un solo trazo en forma de cruz: pasa dos veces por el centro
  painter.segment({ x: 40, y: 100, p: 1 }, { x: 160, y: 100, p: 1 });
  painter.segment({ x: 160, y: 100, p: 1 }, { x: 100, y: 100, p: 1 });
  painter.segment({ x: 100, y: 100, p: 1 }, { x: 100, y: 40, p: 1 });
  painter.segment({ x: 100, y: 40, p: 1 }, { x: 100, y: 160, p: 1 });
  commitStroke(doc, painter, history);

  const arm = px(layer, 55, 100).a;      // solo el brazo horizontal
  const cross = px(layer, 100, 100).a;   // donde el trazo se cruza consigo mismo

  near(cross, arm, 3, 'el cruce del trazo no se oscurece (capa wet)',
    `cruce=${cross} brazo=${arm} — si difieren, el trazo se esta acumulando`);
  near(arm, 128, 8, 'la opacidad del pincel se aplica una sola vez', `alpha=${arm}, esperado ~128`);
}

// ── 3. presion ──────────────────────────────────────────────────────────────

function testPressure() {
  const doc = new ScrawlDoc(100, 100);
  const painter = new Painter(doc);
  const brush = makeBrush('brush');
  brush.size = 40;
  brush.sizePressure = 1;
  painter.begin(brush, '#ffffff');

  const light = painter.radiusAt(0.1);
  const heavy = painter.radiusAt(1);
  ok('mas presion, mas radio', heavy > light * 2, `r(0.1)=${light.toFixed(1)} r(1)=${heavy.toFixed(1)}`);

  brush.sizePressure = 0;
  ok('con sizePressure en 0 el radio es constante',
    Math.abs(painter.radiusAt(0.1) - painter.radiusAt(1)) < 0.01);
}

// ── 4. recomponer una region == recomponer todo ─────────────────────────────

/* La optimizacion por region es invisible cuando funciona y produce costuras
 * cuando no. Este test compara pixel por pixel el resultado de recomponer solo
 * el rect del trazo contra recomponer el lienzo completo. */
function testRegionEqualsFull() {
  const doc = new ScrawlDoc(160, 160);
  const painter = new Painter(doc);
  const history = new History();

  // dos capas con opacidad y blend, para que la composicion no sea trivial
  doc.active.ctx.fillStyle = '#204060';
  doc.active.ctx.fillRect(0, 0, 160, 160);
  doc.active.rev++;
  const top = doc.addLayer(1, 'Top');
  top.opacity = 0.6;
  top.blend = 'screen';

  const brush = makeBrush('brush');
  brush.size = 30;
  painter.begin(brush, '#e0a04a');
  painter.segment({ x: 40, y: 80, p: 0.4 }, { x: 120, y: 80, p: 1 });
  const rect = commitStroke(doc, painter, history);

  const regional = pxOf(doc.flat, 80, 80);
  const edge = pxOf(doc.flat, rect.x + 1, 80);

  doc.recompose();   // completo
  const full = pxOf(doc.flat, 80, 80);
  const fullEdge = pxOf(doc.flat, rect.x + 1, 80);

  ok('el centro de la region coincide con la composicion completa',
    regional.r === full.r && regional.g === full.g && regional.b === full.b && regional.a === full.a,
    `region=${JSON.stringify(regional)} full=${JSON.stringify(full)}`);
  ok('el borde de la region no deja costura',
    edge.r === fullEdge.r && edge.g === fullEdge.g && edge.b === fullEdge.b && edge.a === fullEdge.a,
    `region=${JSON.stringify(edge)} full=${JSON.stringify(fullEdge)}`);
}

// ── 5. borrador ─────────────────────────────────────────────────────────────

function testEraser() {
  const doc = new ScrawlDoc(120, 120);
  const painter = new Painter(doc);
  const history = new History();
  const layer = doc.active;

  layer.ctx.fillStyle = '#ffffff';
  layer.ctx.fillRect(0, 0, 120, 120);
  layer.rev++;
  doc.recompose();

  const eraser = makeBrush('eraser');
  eraser.size = 40;
  eraser.hardness = 1;
  painter.begin(eraser, '#000000');
  painter.segment({ x: 20, y: 60, p: 1 }, { x: 100, y: 60, p: 1 });
  commitStroke(doc, painter, history);

  ok('el borrador deja transparencia, no pinta negro', px(layer, 60, 60).a < 20,
    `alpha=${px(layer, 60, 60).a}`);
  ok('el borrador no toca lo que esta fuera del trazo', px(layer, 60, 10).a === 255);

  history.undo();
  ok('undo del borrador devuelve los pixeles', px(layer, 60, 60).a === 255);
}

// ── 6. flood fill ───────────────────────────────────────────────────────────

function testFloodFill() {
  const doc = new ScrawlDoc(100, 100);
  const layer = doc.active;

  // un marco cerrado: el relleno no debe escaparse
  layer.ctx.strokeStyle = '#ffffff';
  layer.ctx.lineWidth = 6;
  layer.ctx.strokeRect(20, 20, 60, 60);
  layer.rev++;
  doc.recompose();

  const before = snapshotCanvas(layer);
  const rect = floodFill({
    sample: doc.flat, target: layer, x: 50, y: 50, color: '#ff0000', tolerance: 0.1,
  });

  ok('el relleno reporta un rect', !!rect, JSON.stringify(rect));
  ok('el relleno pinta dentro', px(layer, 50, 50).r > 200 && px(layer, 50, 50).a === 255);
  ok('el relleno no se escapa del contorno cerrado', px(layer, 5, 5).a === 0,
    `afuera alpha=${px(layer, 5, 5).a}`);
  ok('el relleno queda contenido en su bbox',
    rect && rect.x >= 20 && rect.y >= 20 && rect.x + rect.w <= 81 && rect.y + rect.h <= 81,
    JSON.stringify(rect));

  const history = new History();
  history.push(fullLayerEntry(layer, before, snapshotCanvas(layer), 'fill'));
  history.undo();
  ok('undo del relleno lo deshace', px(layer, 50, 50).a === 0);
}

// ── 7. capas ────────────────────────────────────────────────────────────────

function testLayers() {
  const doc = new ScrawlDoc(80, 80);
  const bottom = doc.active;
  bottom.ctx.fillStyle = '#ff0000';
  bottom.ctx.fillRect(0, 0, 80, 80);

  const top = doc.addLayer(1, 'Top');
  top.ctx.fillStyle = '#00ff00';
  top.ctx.fillRect(0, 0, 40, 80);

  ok('la capa nueva queda activa', doc.active === top);
  ok('el orden pone la nueva arriba', doc.layers.indexOf(top) > doc.layers.indexOf(bottom));

  doc.recompose();
  ok('la de arriba tapa a la de abajo', pxOf(doc.flat, 20, 40).g > 200);
  ok('donde no tapa se ve la de abajo', pxOf(doc.flat, 60, 40).r > 200);

  top.visible = false;
  doc.invalidateBelow();
  doc.recompose();
  ok('ocultar una capa la saca de la composicion', pxOf(doc.flat, 20, 40).r > 200);
  top.visible = true;

  top.opacity = 0.5;
  doc.invalidateBelow();
  doc.recompose();
  const blended = pxOf(doc.flat, 20, 40);
  ok('la opacidad de capa mezcla con lo de abajo',
    blended.r > 100 && blended.g > 100,
    `rgb=${blended.r},${blended.g},${blended.b}`);

  doc.mergeDown(1);
  ok('merge down deja una sola capa', doc.layers.length === 1);
  doc.recompose();
  const merged = pxOf(doc.flat, 20, 40);
  ok('merge conserva la mezcla', merged.r > 100 && merged.g > 100,
    `rgb=${merged.r},${merged.g},${merged.b}`);

  const gone = doc.removeLayer(0);
  ok('no se puede borrar la unica capa', gone === null && doc.layers.length === 1);
}

// ── 8. guardar y abrir ──────────────────────────────────────────────────────

async function testRoundTrip() {
  const doc = new ScrawlDoc(90, 70);
  doc.active.ctx.fillStyle = '#3d8fd6';
  doc.active.ctx.fillRect(10, 10, 40, 30);
  const l2 = doc.addLayer(1, 'Segunda');
  l2.opacity = 0.42;
  l2.blend = 'multiply';
  l2.visible = false;
  l2.ctx.fillStyle = '#f5c944';
  l2.ctx.fillRect(30, 20, 40, 30);

  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  const back = await ScrawlDoc.fromJSON(json);

  ok('el round trip conserva el tamano', back.width === 90 && back.height === 70);
  ok('el round trip conserva la cantidad de capas', back.layers.length === 2);
  ok('el round trip conserva el nombre', back.layers[1].name === 'Segunda');
  near(back.layers[1].opacity, 0.42, 0.001, 'el round trip conserva la opacidad');
  ok('el round trip conserva el blend', back.layers[1].blend === 'multiply');
  ok('el round trip conserva la visibilidad', back.layers[1].visible === false);

  const orig = px(doc.layers[0], 20, 20);
  const copy = px(back.layers[0], 20, 20);
  ok('el round trip conserva los pixeles',
    orig.r === copy.r && orig.g === copy.g && orig.b === copy.b && orig.a === copy.a,
    `${JSON.stringify(orig)} vs ${JSON.stringify(copy)}`);
}

// ── 9. presupuesto del historial ────────────────────────────────────────────

function testHistoryBudget() {
  const history = new History();
  const doc = new ScrawlDoc(60, 60);
  const layer = doc.active;

  for (let i = 0; i < 140; i++) {
    const rect = { x: 0, y: 0, w: 4, h: 4 };
    const before = grab(layer, rect);
    layer.ctx.fillStyle = '#ffffff';
    layer.ctx.fillRect(0, 0, 4, 4);
    const after = grab(layer, rect);
    history.push(pixelEntry(layer, rect, before, after));
  }
  ok('el historial evicta los pasos mas viejos', history.depth <= 120, `depth=${history.depth}`);
  ok('el historial sigue siendo utilizable tras evictar', history.canUndo);
}

// ── 10. pegar una captura mas grande que el lienzo ──────────────────────────

/* Pegar una captura mas grande agranda el lienzo para no recortarla. Lo que se
 * rompe en silencio es el camino de vuelta: si el tamano no viaja en la foto del
 * estado, deshacer saca la capa y deja el lienzo estirado, sin forma de volver.
 * Y como encoger el lienzo recorta las capas, el redo tiene que devolver la
 * imagen ENTERA, no la parte que entraba en el lienzo chico. */
function testPasteGrowsCanvas() {
  const doc = new ScrawlDoc(200, 150);
  const history = new History();

  const shot = document.createElement('canvas');
  shot.width = 320;
  shot.height = 240;
  const sc = shot.getContext('2d');
  sc.fillStyle = '#3d8fd6';
  sc.fillRect(0, 0, 320, 240);

  // el mismo orden que sigue placeImage en la app
  const before = docState(doc);
  doc.resize(Math.max(doc.width, 320), Math.max(doc.height, 240), 'keep');
  const pasted = doc.addLayer(doc.layers.length, 'Pasted');
  pasted.ctx.drawImage(shot, 0, 0);
  pasted.rev++;
  history.push(layersEntry(doc, before, docState(doc), 'place image'));

  ok('pegar agranda el lienzo hasta la imagen',
    doc.width === 320 && doc.height === 240, `${doc.width}x${doc.height}`);
  ok('pegar deja la imagen en una capa nueva', doc.layers.length === 2);
  ok('la esquina lejana de la captura entra en el lienzo', px(pasted, 310, 230).a === 255);

  history.undo();
  ok('undo del pegado saca la capa', doc.layers.length === 1);
  ok('undo del pegado devuelve el lienzo a su tamano',
    doc.width === 200 && doc.height === 150, `${doc.width}x${doc.height}`);

  history.redo();
  ok('redo del pegado vuelve a agrandar el lienzo',
    doc.width === 320 && doc.height === 240, `${doc.width}x${doc.height}`);
  ok('redo devuelve la imagen entera, sin recorte del lienzo chico',
    px(doc.layers[1], 310, 230).a === 255,
    `alpha en 310,230 = ${px(doc.layers[1], 310, 230).a}`);
}

// ── corrida ─────────────────────────────────────────────────────────────────

async function run() {
  const suites = [
    ['undo / redo', testUndoRedo],
    ['capa wet', testWetNoBuildup],
    ['presion', testPressure],
    ['region == completo', testRegionEqualsFull],
    ['borrador', testEraser],
    ['flood fill', testFloodFill],
    ['capas', testLayers],
    ['guardar / abrir', testRoundTrip],
    ['presupuesto del historial', testHistoryBudget],
    ['pegar una captura grande', testPasteGrowsCanvas],
  ];

  for (const [name, fn] of suites) {
    const at = results.length;
    try {
      await fn();
    } catch (err) {
      check(`${name}: excepcion`, false, String(err && err.stack || err));
    }
    if (results.length === at) check(`${name}: no verifico nada`, false);
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} pasaron`);

  window.__scrawlTest = { total: results.length, failed: failed.length, results };
  document.title = failed.length ? `FAIL ${failed.length}` : 'PASS';
  const out = document.getElementById('out');
  if (out) {
    out.textContent = results
      .map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
      .join('\n') + `\n\n${results.length - failed.length}/${results.length} pasaron`;
  }
}

run();
