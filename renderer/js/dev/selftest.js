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
import { PAPERS, DPIS, paperPixels, paperMm, matchPaper, pxToMm } from '../engine/paper.js';
import { Painter, makeBrush } from '../engine/brush.js';
import {
  History, pixelEntry, grab, snapshotCanvas, fullLayerEntry, layersEntry, docState,
  canvasEntry, canvasState,
} from '../engine/history.js';
import { floodFill } from '../engine/fill.js';
import { buildPDF } from '../engine/pdf.js';

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
  const doc = new ScrawlDoc(90, 70, 300);
  doc.paper = { id: 'a4', orientation: 'landscape' };
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
  /* La densidad y el papel se guardan porque son la mitad de la medida: un
   * archivo que vuelve con los pixeles pero sin sus DPI se abre midiendo otra
   * cosa en papel, y el PDF que salga de el ya no es la hoja que era. */
  ok('el round trip conserva la densidad', back.dpi === 300, `dpi=${back.dpi}`);
  ok('el round trip conserva el papel',
    back.paper?.id === 'a4' && back.paper?.orientation === 'landscape',
    JSON.stringify(back.paper));
  const old = await ScrawlDoc.fromJSON({ width: 20, height: 20, layers: [] });
  ok('un archivo viejo sin densidad se abre a 96 DPI', old.dpi === 96 && old.paper === null,
    `dpi=${old.dpi} paper=${JSON.stringify(old.paper)}`);
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
  const doc = new ScrawlDoc(200, 150, 300);
  doc.paper = { id: 'a4', orientation: 'portrait' };
  const history = new History();

  const shot = document.createElement('canvas');
  shot.width = 320;
  shot.height = 240;
  const sc = shot.getContext('2d');
  sc.fillStyle = '#3d8fd6';
  sc.fillRect(0, 0, 320, 240);

  // el mismo orden que sigue placeImage en la app
  const before = docState(doc);
  /* Adoptar la captura deja al documento midiendo pixeles de pantalla: deja de
   * ser la hoja que era, y con ella se va la densidad de impresion. */
  doc.paper = null;
  doc.dpi = 96;
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
  /* El tamano sin la densidad no alcanza: el lienzo volveria a medir lo mismo en
   * pixeles pero otra cosa en papel, y el PDF saldria de otra hoja. */
  ok('undo del pegado devuelve tambien la hoja y la densidad',
    doc.dpi === 300 && doc.paper?.id === 'a4',
    `dpi=${doc.dpi} paper=${JSON.stringify(doc.paper)}`);

  history.redo();
  ok('redo del pegado vuelve a agrandar el lienzo',
    doc.width === 320 && doc.height === 240, `${doc.width}x${doc.height}`);
  ok('redo devuelve la imagen entera, sin recorte del lienzo chico',
    px(doc.layers[1], 310, 230).a === 255,
    `alpha en 310,230 = ${px(doc.layers[1], 310, 230).a}`);
}

// ── 11. exportar a PDF ──────────────────────────────────────────────────────

/* Un PDF mal armado no se nota mirando: el archivo pesa lo que tiene que pesar y
 * recien no abre en el visor del otro. Asi que se verifican las dos cosas que lo
 * romperian en silencio — que las posiciones de la tabla xref caigan justo en su
 * objeto, y que los pixeles sobrevivan al filtro Up y a DEFLATE. */

const latin1 = new TextDecoder('latin1');

// deshace el filtro PNG "Up" que aplica pdf.js antes de comprimir
function unpredict(filtered, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    for (let i = 0; i < stride; i++) {
      const up = y ? out[(y - 1) * stride + i] : 0;
      out[y * stride + i] = (filtered[row + 1 + i] + up) & 0xff;
    }
  }
  return out;
}

async function streamOf(bytes, text, num, width, height, channels) {
  const at = text.indexOf(`\n${num} 0 obj`) + 1;
  const len = Number(text.slice(at).match(/\/Length (\d+)/)[1]);
  const start = text.indexOf('stream\n', at) + 'stream\n'.length;
  const raw = bytes.subarray(start, start + len);
  const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
  const filtered = new Uint8Array(await new Response(s).arrayBuffer());
  return unpredict(filtered, width, height, channels);
}

function pdfOf(doc) {
  const flat = doc.render();
  return flat.getContext('2d').getImageData(0, 0, flat.width, flat.height);
}

async function testPDF() {
  const doc = new ScrawlDoc(60, 40);
  const c = doc.active.ctx;
  c.fillStyle = '#ff0000';
  c.fillRect(0, 0, 60, 40);
  c.fillStyle = '#00a0ff';
  c.fillRect(10, 10, 20, 15);

  const src = pdfOf(doc);
  const bytes = await buildPDF(src);
  const text = latin1.decode(bytes);

  ok('el PDF arranca con la firma', text.startsWith('%PDF-'));
  ok('el PDF cierra con %%EOF', text.trimEnd().endsWith('%%EOF'));

  const sx = Number(text.match(/startxref\s+(\d+)/)[1]);
  ok('startxref cae justo en la tabla', text.startsWith('xref', sx), `offset ${sx}`);

  const rows = text.slice(sx).match(/^\d{10} 00000 n $/gm) || [];
  const alineados = rows.filter(
    (r, i) => text.startsWith(`${i + 1} 0 obj`, Number(r.slice(0, 10))),
  ).length;
  ok('cada offset de la xref cae en su objeto',
    rows.length >= 6 && alineados === rows.length, `${alineados}/${rows.length}`);

  const box = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  ok('la pagina mide la imagen a 96 DPI',
    Number(box[1]) === 45 && Number(box[2]) === 30, `${box[1]}x${box[2]}`);

  ok('un dibujo opaco no arrastra mascara de alfa', !text.includes('/SMask'));

  const rgb = await streamOf(bytes, text, 5, 60, 40, 3);
  const sample = (x, y) => {
    const i = (y * 60 + x) * 3;
    return `${rgb[i]},${rgb[i + 1]},${rgb[i + 2]}`;
  };
  ok('el rojo del fondo llega intacto al PDF', sample(50, 35) === '255,0,0', sample(50, 35));
  ok('el rectangulo azul llega intacto al PDF', sample(20, 15) === '0,160,255', sample(20, 15));

  let iguales = 0;
  for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
    if (rgb[i] === src.data[p] && rgb[i + 1] === src.data[p + 1]
      && rgb[i + 2] === src.data[p + 2]) iguales++;
  }
  ok('los 2400 pixeles vuelven identicos', iguales === 60 * 40, `${iguales}/2400`);
}

async function testPDFAlpha() {
  const doc = new ScrawlDoc(40, 40);
  const c = doc.active.ctx;
  c.fillStyle = 'rgba(0, 255, 0, 0.5)';
  c.fillRect(0, 0, 20, 40);          // media izquierda a medio alfa, derecha vacia

  const bytes = await buildPDF(pdfOf(doc));
  const text = latin1.decode(bytes);

  ok('un dibujo con transparencia lleva /SMask', text.includes('/SMask 6 0 R'));

  const mask = await streamOf(bytes, text, 6, 40, 40, 1);
  near(mask[20 * 40 + 5], 128, 2, 'la mascara guarda el alfa del pintado');
  ok('la mascara guarda el vacio como transparente', mask[20 * 40 + 30] === 0,
    `alfa=${mask[20 * 40 + 30]}`);
}

// ── 13. tamanos de papel ────────────────────────────────────────────────────

/* La aritmetica del papel es la clase de cosa que sale mal por un pixel y no se
 * nota hasta que la hoja impresa no cierra. Se verifica contra los numeros
 * publicados — 2480x3508 es lo que da cualquier otra herramienta para una A4 a
 * 300 — y se comprueba que el reconocimiento cierre el circulo: lo que este
 * modulo genera, este modulo lo tiene que volver a llamar por su nombre. */
function testPaper() {
  const a4 = paperPixels('a4', 'portrait', 300);
  ok('A4 a 300 DPI da 2480x3508', a4.w === 2480 && a4.h === 3508, `${a4.w}x${a4.h}`);

  const land = paperPixels('a4', 'landscape', 300);
  ok('el horizontal da vuelta la hoja', land.w === 3508 && land.h === 2480, `${land.w}x${land.h}`);

  const letter = paperPixels('letter', 'portrait', 300);
  ok('Letter sale exacta de sus 8.5x11 pulgadas',
    letter.w === 2550 && letter.h === 3300, `${letter.w}x${letter.h}`);

  const back = matchPaper(2480, 3508, 300);
  ok('un lienzo A4 se reconoce como A4',
    back?.id === 'a4' && back?.orientation === 'portrait', JSON.stringify(back));

  // los mismos pixeles a otra densidad son otra medida fisica, y ya no son A4
  ok('el reconocimiento mira la densidad', !matchPaper(2480, 3508, 96));
  ok('una medida libre no se hace pasar por papel', !matchPaper(1920, 1200, 96));

  let round = 0;
  for (const p of PAPERS) {
    for (const o of ['portrait', 'landscape']) {
      for (const d of DPIS) {
        const px = paperPixels(p.id, o, d);
        const m = matchPaper(px.w, px.h, d);
        if (m && m.id === p.id && m.orientation === o) round++;
      }
    }
  }
  const total = PAPERS.length * 2 * DPIS.length;
  ok('cada papel se reconoce en toda orientacion y densidad', round === total, `${round}/${total}`);

  near(pxToMm(2480, 300), 210, 0.05, 'volver a milimetros da la hoja de nuevo');
}

// ── 14. redimensionar el lienzo ─────────────────────────────────────────────

/* Lo que se rompe en silencio aca es el camino de vuelta. Achicar el lienzo
 * RECORTA las capas, y con la entrada de historial equivocada — la que restaura
 * el tamano llamando de nuevo a resize() — deshacer devuelve un lienzo grande
 * con el dibujo ya mutilado: el tamano vuelve, los pixeles no. Por eso el paso
 * se guarda quedandose con los canvas viejos, y por eso esto lo verifica
 * mirando un pixel que solo existe si nunca se perdio. */
function testCanvasResize() {
  const doc = new ScrawlDoc(200, 100);
  const history = new History();
  const c = doc.active.ctx;
  c.fillStyle = '#ff0000';
  c.fillRect(0, 0, 200, 100);
  c.fillStyle = '#00ff00';
  c.fillRect(190, 90, 10, 10);          // marca en la esquina inferior derecha

  let before = canvasState(doc);
  doc.resize(400, 300, 'c');
  history.push(canvasEntry(doc, before, canvasState(doc)));

  ok('el lienzo crece', doc.width === 400 && doc.height === 300, `${doc.width}x${doc.height}`);
  ok('los buffers acompanan al tamano nuevo',
    doc.flat.width === 400 && doc.below.height === 300,
    `flat=${doc.flat.width} below=${doc.below.height}`);
  ok('anclado al centro, el contenido queda centrado', px(doc.active, 100, 100).r === 255);
  ok('lo que se agrego queda vacio', px(doc.active, 40, 40).a === 0);

  before = canvasState(doc);
  doc.resize(120, 80, 'nw');
  history.push(canvasEntry(doc, before, canvasState(doc)));
  ok('el lienzo se achica', doc.width === 120 && doc.height === 80, `${doc.width}x${doc.height}`);

  history.undo();
  ok('undo devuelve el tamano de antes del recorte',
    doc.width === 400 && doc.height === 300, `${doc.width}x${doc.height}`);
  ok('undo devuelve los pixeles que el recorte tiro',
    px(doc.active, 295, 195).g === 255, `verde=${px(doc.active, 295, 195).g}`);
  ok('undo tambien devuelve los buffers', doc.flat.width === 400);

  history.redo();
  ok('redo vuelve a recortar', doc.width === 120 && doc.height === 80);

  // la densidad y el papel son parte del paso, no solo los pixeles
  const d2 = new ScrawlDoc(100, 100, 96);
  const h2 = new History();
  const st = canvasState(d2);
  d2.dpi = 300;
  d2.paper = { id: 'a4', orientation: 'portrait' };
  d2.resize(2480, 3508, 'c');
  h2.push(canvasEntry(d2, st, canvasState(d2)));
  h2.undo();
  ok('undo devuelve tambien la densidad y el papel',
    d2.dpi === 96 && d2.paper === null && d2.width === 100, `dpi=${d2.dpi}`);
}

/* Escalar al cambiar de medida: el dibujo entra entero en vez de recortarse. */
function testCanvasScale() {
  const doc = new ScrawlDoc(200, 100);
  doc.active.ctx.fillStyle = '#ff0000';
  doc.active.ctx.fillRect(0, 0, 200, 100);

  // de 200x100 a 100x100: entra al 50%, o sea 100x50 centrado en vertical
  doc.resize(100, 100, 'c', true);
  ok('el escalado mete el dibujo entero', px(doc.active, 50, 50).r === 255);
  ok('el escalado deja vacio lo que sobra de la otra medida',
    px(doc.active, 50, 5).a === 0, `alpha=${px(doc.active, 50, 5).a}`);
  ok('el escalado no recorta por los lados', px(doc.active, 2, 50).r === 255);
}

// ── 15. el PDF sale del tamano de la hoja ───────────────────────────────────

/* El punto entero de tener densidad en el documento: que el PDF mida en papel lo
 * que uno preparo. Sin esto, una A4 a 300 DPI sale como una pagina de 2480 pt —
 * 87 cm de ancho — y hay que reescalarla al imprimir. */
async function testPrintPDF() {
  const doc = new ScrawlDoc(60, 40, 300);
  doc.active.ctx.fillStyle = '#ffffff';
  doc.active.ctx.fillRect(0, 0, 60, 40);

  const box = async (opts) => {
    const text = latin1.decode(await buildPDF(pdfOf(doc), opts));
    const m = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    return [Number(m[1]), Number(m[2])];
  };

  const at300 = await box({ dpi: 300 });
  ok('a 300 DPI la pagina mide los pixeles en pulgadas de verdad',
    at300[0] === 14.4 && at300[1] === 9.6, `${at300[0]}x${at300[1]}`);

  const at96 = await box({ dpi: 96 });
  ok('a 96 DPI la pagina sigue saliendo del tamano de pantalla',
    at96[0] === 45 && at96[1] === 30, `${at96[0]}x${at96[1]}`);

  /* Con la hoja declarada, la pagina es la hoja EXACTA y no el redondeo de los
   * pixeles: 595.28 pt son los 210 mm de la norma, contra los 595.2 que darian
   * 2480 px. Es la diferencia entre que el visor anuncie A4 y que anuncie una
   * medida personalizada. */
  const a4 = await box({ dpi: 300, pageMm: paperMm('a4', 'portrait') });
  ok('con papel declarado la pagina es la hoja exacta',
    a4[0] === 595.28 && a4[1] === 841.89, `${a4[0]}x${a4[1]}`);

  const a4land = await box({ dpi: 300, pageMm: paperMm('a4', 'landscape') });
  ok('el horizontal sale acostado', a4land[0] === 841.89 && a4land[1] === 595.28,
    `${a4land[0]}x${a4land[1]}`);
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
    ['exportar PDF', testPDF],
    ['exportar PDF con alfa', testPDFAlpha],
    ['tamanos de papel', testPaper],
    ['redimensionar el lienzo', testCanvasResize],
    ['escalar al redimensionar', testCanvasScale],
    ['PDF con tamano de hoja', testPrintPDF],
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
