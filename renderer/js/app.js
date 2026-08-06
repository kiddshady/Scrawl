/* Scrawl — orquestador.
 *
 * Junta motor, viewport y interfaz. Nada de dibujo real vive aca: esto decide
 * QUE pasa cuando el stylus se apoya, y el motor decide COMO se pinta.
 *
 * Sobre el redibujado: no hay un requestAnimationFrame corriendo en loop. Se
 * pide un frame solo cuando algo cambio (invalidate) y se coalesce en uno por
 * frame. Un loop permanente mantendria la GPU y el ventilador trabajando para
 * redibujar un lienzo identico sesenta veces por segundo, y en una app que uno
 * deja abierta durante horas eso se nota. */

import { ScrawlDoc, BLEND_MODES, clampRect, unionRect, loadImage } from './engine/doc.js';
import { Viewport } from './engine/viewport.js';
import { Painter, BRUSHES, TOOL_SETTINGS, makeBrush, toHex } from './engine/brush.js';
import { StrokeInput, StrokePath } from './engine/stroke.js';
import { floodFill } from './engine/fill.js';
import {
  History, pixelEntry, grab, snapshotCanvas, fullLayerEntry, layersEntry, docState, formatBytes,
} from './engine/history.js';
import { hydrateIcons, icon } from './ui/icons.js';
import { el, makeSelect, toast } from './ui/controls.js';
import { initTooltips } from './ui/tooltips.js';
import { initTitlebar } from './ui/titlebar.js';
import { initColor } from './ui/color.js';
import { initLayers } from './ui/layers.js';
import { initBrushPanel } from './ui/brushpanel.js';
import { initPuck } from './ui/puck.js';

const q = (id) => document.getElementById(id);

/* Cuantos pixeles de arrastre duplican la escala en el zoom del puck. Con 180 el
 * nucleo entero (48px de diametro) cubre un 20% de zoom, que es el rango en el
 * que uno ajusta, y cruzar el lienzo de arriba abajo lleva de encajar a mirar el
 * pixel. Mas chico se vuelve nervioso, mas grande obliga a arrastres largos. */
const ZOOM_DRAG_PX = 180;

// ── estado ──────────────────────────────────────────────────────────────────

const doc = new ScrawlDoc(1920, 1200);
const canvas = q('sc-canvas');
const view = new Viewport(canvas, doc);
const painter = new Painter(doc);
const history = new History({ onChange: syncHistoryUI });

// una instancia por herramienta: los ajustes de cada pincel se conservan al
// cambiar de una a otra y volver, que es lo que uno espera
const brushes = Object.fromEntries(Object.keys(BRUSHES).map((k) => [k, makeBrush(k)]));

// ajustes de las herramientas que no pintan trazos (por ahora, el relleno)
const toolSettings = Object.fromEntries(
  Object.entries(TOOL_SETTINGS).map(([k, v]) => [k, { ...v }]),
);

let tool = 'brush';
let color = '#e8e8e8';

let stroke = null;             // trazo en curso
let panning = null;
/* Arrastre de zoom desde el nucleo del puck. Guarda la escala del arranque en
 * vez de acumular factores frame a frame: asi el zoom es funcion de cuanto se
 * movio la mano desde que apoyo, y volver al punto de partida devuelve la escala
 * exacta que habia. Acumulando, cada frame arrastraria su error de redondeo y el
 * viaje de ida y vuelta no cerraria. */
let zooming = null;
let spaceDown = false;
/* Alt y espacio se siguen a mano porque las herramientas temporales tienen que
 * responder al modificador aunque el puntero este quieto: si solo se leyeran del
 * evento del mouse, mantener Alt no cambiaria el cursor hasta mover la mano. */
let altDown = false;
let dirtyDoc = false;
let docPath = null;
let panelsHidden = false;

const params = new URLSearchParams(location.search);
const UI_MODE = params.get('ui');

// ── redibujado ──────────────────────────────────────────────────────────────

let scheduled = false;
function invalidate() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    view.draw();
  });
}

function markDirty(on = true) {
  if (dirtyDoc === on) return;
  dirtyDoc = on;
  q('sc-docname').classList.toggle('dirty', on);
}

// ── herramientas ────────────────────────────────────────────────────────────

/* La herramienta efectiva puede no ser la elegida: la goma del stylus, un
 * modificador o la barra espaciadora la cambian mientras estan activos. Que esa
 * decision viva en un solo lugar evita el clasico bug de "solte alt y sigue
 * siendo el cuentagotas". */
function effectiveTool(mods = {}) {
  if (mods.eraser) return 'eraser';
  if (panning || zooming || spaceDown || mods.middle || mods.barrel) return 'pan';
  if ((mods.alt ?? altDown) && isPaintTool(tool)) return 'picker';
  return tool;
}

function isPaintTool(t) { return t in brushes || t === 'line'; }

/* La herramienta 'line' usa el pincel actual: una linea recta con el lapiz sale
 * de lapiz y con el marcador sale de marcador. */
function brushFor(t) {
  if (t === 'line') return brushes[tool in brushes ? tool : 'brush'];
  return brushes[t] || brushes.brush;
}

function setTool(next, { silent = false } = {}) {
  if (!(next in brushes) && !['line', 'fill', 'picker', 'pan'].includes(next)) return;
  tool = next;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === next);
  }
  /* El panel se llena con el pincel de la herramienta o, si no pinta trazos, con
   * sus ajustes propios. Cuando no tiene ninguno (cuentagotas, mano) se deja lo
   * que habia: sigue siendo el pincel al que se va a volver. */
  const settings = brushes[next] || toolSettings[next];
  if (settings) brushPanel.setBrush(settings);
  updateCanvasCursor();
  if (!silent) hint(hintFor(next));
}

function hintFor(t) {
  const map = {
    brush: 'Hold Alt to pick a color · Shift+drag for a straight line',
    pencil: 'Hold Alt to pick a color · Shift+drag for a straight line',
    marker: 'Overlapping passes darken, like a real highlighter',
    airbrush: 'Build up gradually — press harder for more flow',
    eraser: 'Flip the stylus over to erase from any tool',
    line: 'Click and drag to draw a straight line',
    fill: 'Fills the region you see, painting into the active layer',
    picker: 'Click anywhere to sample that color',
    pan: 'Drag to move the canvas · Hold Space from any tool',
  };
  return map[t] || '';
}

function hint(text) {
  const n = q('sc-st-hint');
  n.textContent = text || '';
}

/* El canvas no lleva cursor del sistema cuando pinta: el anillo del tamano real
 * del pincel se dibuja adentro del lienzo (viewport.cursor). Para las
 * herramientas que no pintan, un cursor nativo comunica mejor. */
function updateCanvasCursor() {
  const t = effectiveTool();
  if (t === 'pan') {
    /* Con el puck arriba el cursor dice cual de los dos gestos va a salir si
     * apoyas aca: la doble flecha vertical del nucleo es la unica pista de que
     * el zoom se arrastra hacia arriba y hacia abajo. */
    const overCore = zooming || (!panning && hoverPt && puck.zoneAt(hoverPt.x, hoverPt.y) === 'core');
    canvas.style.cursor = overCore ? 'ns-resize' : panning ? 'grabbing' : 'grab';
  } else if (t === 'picker') canvas.style.cursor = 'crosshair';
  else if (t === 'fill') canvas.style.cursor = 'crosshair';
  else canvas.style.cursor = 'none';
}

// ── ciclo del trazo ─────────────────────────────────────────────────────────

function beginStroke(pt, mods) {
  const t = effectiveTool(mods);
  const docPt = view.toDoc(pt.x, pt.y);

  /* El puck reparte el gesto de navegacion: apoyar en el nucleo hace zoom,
   * apoyar en cualquier otro lado desplaza. Cuando no hay puck — la mano, el
   * boton del medio, el boton lateral del lapiz — zoneAt devuelve null y todo
   * cae en el desplazamiento de siempre. */
  if (t === 'pan') {
    hoverPt = pt;
    if (puck.zoneAt(pt.x, pt.y) === 'core') {
      // el zoom pivotea sobre el centro del disco, no sobre donde apoyaste: el
      // puck es la lupa, y lo que esta abajo del disco es lo que no se mueve
      zooming = { scale: view.scale, y: pt.y, ax: puck.x, ay: puck.y };
      puck.setActive('core');
    } else {
      panning = { x: pt.x, y: pt.y };
      puck.setActive('ring');
    }
    updateCanvasCursor();
    return;
  }
  if (t === 'picker') { pickColorAt(docPt); return; }
  if (t === 'fill') { doFill(docPt); return; }

  const layer = doc.active;
  if (!layer) return;
  if (!layer.visible) {
    toast('That layer is hidden — nothing would show', 'eyeOff');
    return;
  }

  const brush = brushFor(t);
  // la goma del stylus fuerza el borrador aunque el pincel elegido sea otro
  const effective = t === 'eraser' ? brushes.eraser : brush;

  painter.begin(effective, color);

  // shift al apoyar = linea recta, sin cambiar de herramienta
  const straight = t === 'line' || mods.shift;

  stroke = {
    layer,
    brush: effective,
    straight,
    from: { x: docPt.x, y: docPt.y, p: pt.p },
    lastRect: null,
    path: null,
  };

  if (straight) {
    paintStraight({ x: docPt.x, y: docPt.y, p: pt.p });
  } else {
    stroke.path = new StrokePath((a, b) => painter.segment(a, b));
    const first = stroke.path.begin({ x: docPt.x, y: docPt.y, p: pt.p }, effective.smoothing);
    painter.dot(first);
    flushStroke();
  }
  updatePressureMeter(pt);
}

function moveStroke(pt, mods) {
  /* Zoom exponencial: cada ZOOM_DRAG_PX de recorrido duplica o divide la escala.
   * Lineal no serviria — el zoom se percibe en proporcion, asi que un paso fijo
   * se siente enorme al 20% y microscopico al 800%. */
  if (zooming) {
    hoverPt = pt;
    view.zoomTo(zooming.scale * Math.pow(2, (zooming.y - pt.y) / ZOOM_DRAG_PX), zooming.ax, zooming.ay);
    updateZoomLabel();
    invalidate();
    return;
  }
  if (panning) {
    hoverPt = pt;
    view.pan(pt.x - panning.x, pt.y - panning.y);
    panning = { x: pt.x, y: pt.y };
    invalidate();
    return;
  }
  if (!stroke) return;

  const docPt = view.toDoc(pt.x, pt.y);
  if (stroke.straight) {
    paintStraight({ x: docPt.x, y: docPt.y, p: pt.p });
  } else {
    stroke.path.push({ x: docPt.x, y: docPt.y, p: pt.p });
    flushStroke();
  }
  updatePressureMeter(pt);
}

/* La linea recta se re-dibuja entera en cada movimiento: se limpia el wet y se
 * vuelve a trazar desde el origen. Barato porque el wet es un solo canvas, y es
 * lo que permite ver la linea siguiendo al puntero antes de soltar. */
function paintStraight(to) {
  const before = painter.clearWet();
  const a = stroke.from;
  if (Math.hypot(to.x - a.x, to.y - a.y) < 0.5) painter.dot(a);
  else painter.segment(a, to);

  // hay que recomponer tambien donde ESTABA la linea, o queda su fantasma
  const region = unionRect(before, painter.dirty);
  if (region) {
    doc.recompose(region, painter.wetLayer);
    invalidate();
  }
}

/* Recompone solo lo que se pinto desde el ultimo frame. Con un trazo largo, el
 * bbox total del trazo crece hasta cubrir el lienzo; recomponer ese bbox entero
 * en cada frame haria que dibujar se pusiera cada vez mas lento a medida que el
 * trazo avanza. */
function flushStroke() {
  const region = painter.takeFrameDirty();
  if (!region) return;
  doc.recompose(region, painter.wetLayer);
  invalidate();
}

function endStroke() {
  if (panning || zooming) {
    panning = null;
    zooming = null;
    puck.setActive(null);
    if (spaceDown) {
      puck.setHover(hoverPt ? puck.zoneAt(hoverPt.x, hoverPt.y) : null);
    } else if (puck.visible) {
      /* La barra se solto a mitad del arrastre y el gesto se dejo terminar
       * igual: recien ahora se apaga el modo navegacion. El puck.visible es lo
       * que deja afuera al paneo sin puck — boton del medio, boton lateral del
       * lapiz — que nunca entro en ese modo y no tiene nada que apagar. */
      exitNav();
    }
    updateCanvasCursor();
    return;
  }
  if (!stroke) return;

  if (stroke.path) {
    stroke.path.end();
    flushStroke();
  }

  const raw = painter.dirty;
  const layer = stroke.layer;
  stroke = null;

  if (!raw) { painter.cancel(); return; }

  const rect = clampRect(raw, doc.width, doc.height);
  if (rect.w <= 0 || rect.h <= 0) { painter.cancel(); return; }

  /* El orden importa: se captura el ANTES mientras la capa todavia esta intacta
   * (el trazo vive en el wet, no en la capa), despues se compone, y recien
   * entonces se captura el DESPUES. Es lo que permite guardar solo el bbox en
   * lugar del lienzo completo. */
  const before = grab(layer, rect);
  painter.commit(layer);
  const after = grab(layer, rect);
  history.push(pixelEntry(layer, rect, before, after, 'stroke'));

  doc.recompose(rect);
  markDirty(true);
  invalidate();
  layersPanel.refreshThumbs();
}

// ── herramientas puntuales ──────────────────────────────────────────────────

function pickColorAt(docPt) {
  const x = Math.floor(docPt.x), y = Math.floor(docPt.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  // se muestrea el compuesto: el color que uno ve es el que espera levantar
  const d = doc.flatCtx.getImageData(x, y, 1, 1).data;
  if (d[3] === 0) { toast('Nothing there to sample', 'picker'); return; }
  const hex = toHex(d[0], d[1], d[2]);
  colorPicker.pick(hex);
  toast(hex, 'picker', 1200);
}

function doFill(docPt) {
  const layer = doc.active;
  if (!layer || !layer.visible) return;
  const before = snapshotCanvas(layer);
  const rect = floodFill({
    sample: doc.flat,
    target: layer,
    x: docPt.x,
    y: docPt.y,
    color,
    tolerance: toolSettings.fill.tolerance,
  });
  if (!rect) { toast('Nothing to fill there', 'fill'); return; }
  history.push(fullLayerEntry(layer, before, snapshotCanvas(layer), 'fill'));
  doc.recompose(rect);
  markDirty(true);
  invalidate();
  layersPanel.refreshThumbs();
}

function clearLayer() {
  const layer = doc.active;
  if (!layer) return;
  const before = snapshotCanvas(layer);
  layer.clear();
  history.push(fullLayerEntry(layer, before, snapshotCanvas(layer), 'clear'));
  doc.invalidateBelow();
  doc.recompose();
  markDirty(true);
  invalidate();
  layersPanel.refreshThumbs();
  toast('Layer cleared', 'clear');
}

// ── acciones de capa ────────────────────────────────────────────────────────

/* Toda accion estructural se envuelve en un par de estados: se fotografia la
 * estructura antes, se hace el cambio, se fotografia despues. Como las fotos
 * guardan referencias a los objetos Layer y no sus pixeles, deshacer un borrado
 * de capa devuelve el canvas intacto y sin costo de memoria. */
function structural(label, fn) {
  const before = docState(doc);
  const result = fn();
  const after = docState(doc);
  history.push(layersEntry(doc, before, after, label));
  markDirty(true);
  refreshAll();
  return result;
}

function refreshAll() {
  doc.invalidateBelow();
  doc.recompose();
  layersPanel.render();
  syncLayerControls();
  invalidate();
}

function addLayer() {
  const layer = structural('add layer', () => doc.addLayer(doc.activeIndex + 1));
  layersPanel.markEntering(layer.id);
  layersPanel.render();
  toast('Layer added', 'plus');
}

function duplicateLayer() {
  const copy = structural('duplicate layer', () => doc.duplicateLayer(doc.activeIndex));
  layersPanel.markEntering(copy.id);
  layersPanel.render();
  toast('Layer duplicated', 'duplicate');
}

function deleteLayer() {
  if (doc.layers.length <= 1) { toast('Can’t delete the only layer', 'trash'); return; }
  structural('delete layer', () => doc.removeLayer(doc.activeIndex));
  toast('Layer deleted', 'trash');
}

function mergeDown() {
  if (doc.activeIndex <= 0) { toast('Nothing below to merge into', 'merge'); return; }
  const i = doc.activeIndex;
  const bottom = doc.layers[i - 1];
  /* Merge toca pixeles Y estructura, asi que necesita las dos cosas: los pixeles
   * de la capa de abajo (que recibe el aplastado) y la lista de capas. */
  const pixBefore = snapshotCanvas(bottom);
  const structBefore = docState(doc);
  doc.mergeDown(i);
  const pixAfter = snapshotCanvas(bottom);
  const structAfter = docState(doc);

  const pix = fullLayerEntry(bottom, pixBefore, pixAfter, 'merge pixels');
  const str = layersEntry(doc, structBefore, structAfter, 'merge layers');
  history.push({
    kind: 'merge', label: 'merge down', bytes: pix.bytes,
    undo() { str.undo(); pix.undo(); },
    redo() { pix.redo(); str.redo(); },
  });
  markDirty(true);
  refreshAll();
  toast('Merged down', 'merge');
}

function toggleVisible(index) {
  const layer = doc.layers[index];
  if (!layer) return;
  structural('toggle visibility', () => { layer.visible = !layer.visible; });
  layersPanel.sync();
}

// ── paneles ─────────────────────────────────────────────────────────────────

let layerOpacity = null;
let blendSelect = null;

function syncLayerControls() {
  const layer = doc.active;
  if (!layer) return;
  layerOpacity?.set(layer.opacity);
  q('sc-layer-op-val').textContent = `${Math.round(layer.opacity * 100)}%`;
  blendSelect?.set(layer.blend);
}

function syncHistoryUI() {
  q('sc-undo').disabled = !history.canUndo;
  q('sc-redo').disabled = !history.canRedo;
  const n = q('sc-st-hist');
  n.textContent = history.depth ? `${history.depth} · ${formatBytes(history.bytes)}` : '0';
}

function updatePressureMeter(pt) {
  const fill = q('sc-press-fill');
  const val = q('sc-press-val');
  const src = q('sc-press-src');
  fill.style.width = `${Math.round(pt.p * 100)}%`;
  val.textContent = `${Math.round(pt.p * 100)}%`;
  const isPen = pt.pen;
  src.textContent = isPen ? 'pen' : pt.type === 'touch' ? 'touch' : 'mouse';
  src.classList.toggle('pen', isPen);
  src.setAttribute('data-tip', isPen
    ? 'Stylus reporting real pressure'
    : 'This device has no pressure — strokes use full width');
}

function updateZoomLabel() {
  q('sc-zoom-val').textContent = `${Math.round(view.scale * 100)}%`;
}

function updateStatusSize() {
  q('sc-st-size').textContent = `${doc.width}×${doc.height}`;
}

// ── archivos ────────────────────────────────────────────────────────────────

async function exportPNG() {
  const flat = doc.render();
  const blob = await new Promise((r) => flat.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const name = (docPath ? baseName(docPath) : 'scrawl') + '.png';
  const res = await window.scrawl.file.exportPNG(buf, name);
  if (res.ok) toast(`Exported ${baseName(res.path)}`, 'exportImage');
}

async function copyToClipboard() {
  const flat = doc.render();
  const blob = await new Promise((r) => flat.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  await window.scrawl.clip.writeImage(buf);
  toast('Copied to clipboard', 'clipboard');
}

async function saveDoc(forceDialog = false) {
  const json = JSON.stringify(doc.toJSON());
  const res = await window.scrawl.file.saveDoc(
    json,
    docPath ? baseName(docPath) + '.scrawl' : 'untitled.scrawl',
    forceDialog ? null : docPath,
  );
  if (!res.ok) return;
  docPath = res.path;
  q('sc-docname').textContent = baseName(res.path);
  markDirty(false);
  toast(`Saved ${baseName(res.path)}`, 'save');
}

async function openDoc() {
  const res = await window.scrawl.file.openDoc();
  if (!res.ok) return;
  await loadDoc(res.json, res.path);
}

async function loadDoc(json, path) {
  try {
    const loaded = await ScrawlDoc.fromJSON(JSON.parse(json));
    adoptDoc(loaded, path);
    toast(`Opened ${baseName(path)}`, 'open');
  } catch (err) {
    console.error(err);
    toast('That file could not be read', 'clear', 3200);
  }
}

/* Reemplaza el documento en vivo. El motor guarda referencias a doc, asi que se
 * copian los campos en la instancia existente en vez de crear otra: cambiar la
 * referencia dejaria a viewport y painter apuntando al documento viejo. */
function adoptDoc(next, path = null) {
  doc.width = next.width;
  doc.height = next.height;
  doc.layers = next.layers;
  doc.activeIndex = next.activeIndex;
  doc.flat = next.flat;
  doc.flatCtx = next.flatCtx;
  doc.below = next.below;
  doc.belowCtx = next.belowCtx;
  doc.scratch = next.scratch;
  doc.scratchCtx = next.scratchCtx;
  doc.belowDirty = true;

  painter.syncSize();
  history.clear();
  docPath = path;
  q('sc-docname').textContent = path ? baseName(path) : 'Untitled';
  markDirty(false);
  updateStatusSize();
  view.fit();
  updateZoomLabel();
  refreshAll();
}

function newDoc() {
  const fresh = new ScrawlDoc(doc.width, doc.height);
  adoptDoc(fresh, null);
  toast('New drawing', 'newDoc');
}

/* Documento intacto: una sola capa, nada dibujado, sin archivo detras y sin un
 * paso de historial. Es el estado de "abri Scrawl para anotar esta captura", y
 * el unico en el que se puede achicar el lienzo sin riesgo de recortar trabajo,
 * porque no hay nada que recortar. */
function pristineDoc() {
  return doc.layers.length === 1 && !docPath && !dirtyDoc && !history.canUndo;
}

/* Coloca una imagen en una capa nueva. Es el camino tanto para importar un
 * archivo como para pegar una captura, que es el otro uso central de la app.
 *
 * El lienzo se acomoda a la imagen segun en que estado este el documento:
 *
 *   intacto  el lienzo pasa a medir EXACTAMENTE la imagen. Pegar una captura de
 *            1920x1080 en el lienzo por defecto de 1920x1200 dejaba una banda
 *            transparente de 120px abajo que despues se colaba en el PNG
 *            exportado — anotar una captura tiene que dar esa captura, no la
 *            captura flotando en un lienzo de otra medida.
 *   con algo dibujado  solo crece, y solo lo necesario para que la imagen entre
 *            sin recortarse. Achicar aca borraria pixeles del dibujo. */
async function placeImage(src, label) {
  const img = await loadImage(src);
  /* La foto del estado va ANTES de tocar el lienzo: el tamano forma parte de lo
   * que se restaura, asi que capturarla despues del resize haria que deshacer
   * sacara la capa y dejara el lienzo agrandado para siempre. */
  const before = docState(doc);

  const fit = pristineDoc()
    ? { w: img.width, h: img.height }
    : { w: Math.max(doc.width, img.width), h: Math.max(doc.height, img.height) };

  if (fit.w !== doc.width || fit.h !== doc.height) {
    doc.resize(fit.w, fit.h, 'keep');
    painter.syncSize();
    updateStatusSize();
    view.fit();
    updateZoomLabel();
  }

  /* Centrada en lo que sobre del lienzo. Cuando el lienzo calzo con la imagen no
   * sobra nada y esto da 0,0; los dos casos salen de la misma cuenta. Nunca es
   * negativo: para llegar aca el lienzo ya contiene a la imagen. */
  const dx = Math.round((doc.width - img.width) / 2);
  const dy = Math.round((doc.height - img.height) / 2);

  const layer = doc.addLayer(doc.layers.length, label);
  layer.ctx.drawImage(img, dx, dy);
  layer.rev++;
  history.push(layersEntry(doc, before, docState(doc), 'place image'));
  layersPanel.markEntering(layer.id);
  markDirty(true);
  refreshAll();
  // el tamano lo reporta quien decodifico: es el unico que lo sabe de verdad
  return { w: img.width, h: img.height };
}

async function pasteImage() {
  const res = await window.scrawl.clip.readImage();
  if (!res) { toast('No image in the clipboard', 'clipboard'); return; }
  /* Blob sin type: el portapapeles puede traer los pixeles (PNG) o el archivo
   * tal cual, que bien puede ser un JPEG de ShareX. El decodificador sniffea los
   * bytes, asi que declarar un tipo aca solo abriria la posibilidad de mentirle. */
  const blob = new Blob([new Uint8Array(res.data)]);
  const url = URL.createObjectURL(blob);
  try {
    // con un archivo detras, la capa lleva su nombre en vez de un 'Pasted' mas
    const size = await placeImage(url, res.path ? baseName(res.path) : 'Pasted');
    toast(`Pasted ${size.w}×${size.h}`, 'clipboard');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function importImage() {
  const res = await window.scrawl.file.openImage();
  if (!res.ok) return;
  const blob = new Blob([new Uint8Array(res.data)]);
  const url = URL.createObjectURL(blob);
  try {
    await placeImage(url, baseName(res.path));
    toast(`Imported ${baseName(res.path)}`, 'image');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function baseName(p) {
  const f = String(p).split(/[\\/]/).pop();
  return f.replace(/\.(scrawl|png|jpe?g|webp|bmp|gif)$/i, '');
}

// ── undo / redo ─────────────────────────────────────────────────────────────

function undo() {
  if (!history.canUndo) return;
  const size = { w: doc.width, h: doc.height };
  history.undo();
  afterTimeTravel(size);
}

function redo() {
  if (!history.canRedo) return;
  const size = { w: doc.width, h: doc.height };
  history.redo();
  afterTimeTravel(size);
}

function afterTimeTravel(size) {
  /* Un paso puede cambiar el tamano del lienzo — deshacer un pegado que lo
   * agrando, por ejemplo — y entonces hay que resincronizar todo lo que depende
   * de el. Se compara en vez de hacerlo siempre porque re-encajar la vista en
   * cada Ctrl+Z moveria el zoom debajo de la mano en el 99% de los pasos, que no
   * tocan el tamano. */
  if (doc.width !== size.w || doc.height !== size.h) {
    painter.syncSize();
    updateStatusSize();
    view.fit();
    updateZoomLabel();
  }
  doc.invalidateBelow();
  doc.recompose();
  layersPanel.render();
  syncLayerControls();
  markDirty(true);
  invalidate();
}

// ── vista ───────────────────────────────────────────────────────────────────

function fitView() { view.fit(); updateZoomLabel(); invalidate(); }
function resetZoom() { view.zoomTo(1); updateZoomLabel(); invalidate(); }

/* Modo navegacion: lo que pasa mientras la barra espaciadora esta apretada.
 * Aparece el puck bajo el puntero y el HUD del zoom se queda fijo, porque
 * mientras dura el gesto el porcentaje es el unico numero que importa. */
const zoomHud = document.querySelector('.sc-zoom');

function enterNav() {
  // sin puntero sobre el lienzo (la barra se apreto con el mouse afuera) el
  // disco va al centro: sigue sirviendo, y ahi el zoom pivotea en el medio
  const x = hoverPt ? hoverPt.x : view.cssW / 2;
  const y = hoverPt ? hoverPt.y : view.cssH / 2;
  puck.show(x, y);
  puck.setHover(puck.zoneAt(x, y));
  zoomHud.classList.add('show');
  updateCanvasCursor();
  /* El anillo del pincel sobra mientras se navega. Hay que apagarlo a mano: se
   * dibuja adentro del lienzo y, si no, se queda pintado hasta que el puntero se
   * mueva y alguien recalcule. */
  updateBrushCursor();
  hint('Drag the center to zoom · drag anywhere else to pan');
}

function exitNav() {
  puck.hide();
  zoomHud.classList.remove('show');
  updateCanvasCursor();
  updateBrushCursor();
  hint(hintFor(tool));
}

function togglePanels() {
  panelsHidden = !panelsHidden;
  const body = document.querySelector('.sc-body');
  body.style.gridTemplateColumns = panelsHidden
    ? '0 1fr 0'
    : 'var(--sc-tool-w) 1fr var(--sc-panel-w)';
  document.querySelector('.sc-tools').style.opacity = panelsHidden ? '0' : '1';
  document.querySelector('.sc-panels').style.opacity = panelsHidden ? '0' : '1';
  // el viewport cambio de ancho: hay que remedir despues de la transicion
  setTimeout(() => { view.resize(); invalidate(); }, 220);
}

// ── atajos ──────────────────────────────────────────────────────────────────

const TOOL_KEYS = { b: 'brush', p: 'pencil', m: 'marker', a: 'airbrush', e: 'eraser', l: 'line', g: 'fill', i: 'picker', h: 'pan' };

function onKeyDown(e) {
  // mientras se escribe en un campo, el teclado es del campo
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  /* El preventDefault va en TODOS los keydown de la barra, no solo en el
   * primero. Manteniendola apretada — que es el gesto entero — Windows repite el
   * keydown, y un keydown sin prevenir deja "activo" al boton que tenga el foco;
   * al soltar la barra, Chromium le dispara el click. Alcanza con haber
   * clickeado un boton antes para que lo conserve. El sintoma es desconcertante
   * porque no se parece a su causa: mantenes espacio para navegar, soltas, y la
   * ventana se minimiza sola — el ultimo boton que tocaste fue el de minimizar. */
  if (k === ' ') {
    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      enterNav();
    }
    return;
  }

  if (k === 'alt') {
    // preventDefault para que Alt no intente activar la barra de menu de Chromium
    e.preventDefault();
    if (!altDown) {
      altDown = true;
      updateCanvasCursor();
      updateBrushCursor();
    }
    return;
  }

  if (mod) {
    switch (k) {
      case 'z': e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      case 'y': e.preventDefault(); redo(); return;
      case 's': e.preventDefault(); saveDoc(e.shiftKey); return;
      case 'o': e.preventDefault(); openDoc(); return;
      case 'n': e.preventDefault(); e.shiftKey ? addLayer() : newDoc(); return;
      case 'j': e.preventDefault(); duplicateLayer(); return;
      case 'e': e.preventDefault(); e.shiftKey ? exportPNG() : mergeDown(); return;
      case 'v': e.preventDefault(); pasteImage(); return;
      case 'c': e.preventDefault(); copyToClipboard(); return;
      case '0': e.preventDefault(); fitView(); return;
      case '1': e.preventDefault(); resetZoom(); return;
      default: return;
    }
  }

  if (k === 'tab') { e.preventDefault(); togglePanels(); return; }
  if (k === 'x') { colorPicker.swap(); return; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); clearLayer(); return; }

  // corchetes: el gesto universal para cambiar el tamano del pincel sin mirar
  if (k === '[' || k === ']') {
    const brush = brushes[tool];
    if (!brush) return;
    const dir = k === ']' ? 1 : -1;
    // paso proporcional: 1px cuando el pincel es fino, mas cuando es grueso
    const step = Math.max(1, Math.round(brush.size * 0.12));
    brush.size = Math.max(1, Math.min(400, brush.size + dir * step));
    brushPanel.syncField('size');
    updateBrushCursor();
    return;
  }

  if (k === '+' || k === '=') { view.zoomIn(); updateZoomLabel(); invalidate(); return; }
  if (k === '-') { view.zoomOut(); updateZoomLabel(); invalidate(); return; }

  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
}

function onKeyUp(e) {
  if (e.key === ' ') {
    spaceDown = false;
    /* Soltar la barra a mitad de un arrastre no lo corta: el gesto empezado
     * manda, y el puck se queda hasta que el lapiz se levante. Cortarlo ahi
     * dejaria el lienzo a mitad de camino por un dedo que se relajo. */
    if (panning || zooming) updateCanvasCursor();
    else exitNav();
  }
  if (e.key === 'Alt') {
    altDown = false;
    updateCanvasCursor();
    updateBrushCursor();
  }
}

/* Si la ventana pierde el foco con un modificador apretado, el keyup nunca llega
 * y la herramienta temporal se queda pegada. Al volver, el cursor mentiria. */
window.addEventListener('blur', () => {
  spaceDown = false;
  altDown = false;
  exitNav();
});

// ── cursor del pincel ───────────────────────────────────────────────────────

let hoverPt = null;

function updateBrushCursor() {
  if (!hoverPt) return;
  const t = effectiveTool();
  const brush = brushes[t];
  if (!brush || t === 'pan' || t === 'picker' || t === 'fill') {
    view.cursor = null;
  } else {
    view.cursor = { x: hoverPt.x, y: hoverPt.y, r: (brush.size / 2) * view.scale };
  }
  invalidate();
}

// ── arranque de la interfaz ─────────────────────────────────────────────────

hydrateIcons();
initTooltips();

// vive adentro del contenedor del lienzo: comparte su sistema de coordenadas con
// los puntos que entrega StrokeInput, asi el reparto entre zonas es una resta
const puck = initPuck(q('sc-view'));

const colorPicker = initColor({
  canvas: q('sc-wheel'),
  chip: q('sc-chip'),
  hexInput: q('sc-hex'),
  swatchHost: q('sc-swatches'),
  onChange: (hex) => {
    color = hex;
    brushPanel.setColor(hex);
  },
});
color = colorPicker.hex;

const brushPanel = initBrushPanel({
  host: q('sc-brush-fields'),
  titleEl: q('sc-brush-title'),
  previewCanvas: q('sc-preview'),
  onChange: (_brush, key) => {
    if (key === 'size') updateBrushCursor();
  },
});
brushPanel.setColor(color);

const layersPanel = initLayers({
  host: q('sc-layers'),
  doc,
  callbacks: {
    onSelect: (i) => {
      if (i === doc.activeIndex) return;
      doc.setActive(i);
      doc.recompose();
      layersPanel.sync();
      syncLayerControls();
      invalidate();
    },
    onToggleVisible: toggleVisible,
    onRename: (i, name) => {
      structural('rename layer', () => { doc.layers[i].name = name; });
    },
    onReorder: (from, to) => {
      structural('reorder layers', () => doc.moveLayer(from, to));
      toast('Layers reordered', 'merge', 1200);
    },
  },
});

initTitlebar({
  isEnabled: (action) => {
    if (action === 'undo') return history.canUndo;
    if (action === 'redo') return history.canRedo;
    if (action === 'mergeDown') return doc.activeIndex > 0;
    if (action === 'deleteLayer') return doc.layers.length > 1;
    return true;
  },
  menus: {
    file: [
      { label: 'New', action: 'newDoc', key: 'Ctrl+N', icon: 'newDoc' },
      { label: 'Open…', action: 'openDoc', key: 'Ctrl+O', icon: 'open' },
      { label: 'Save', action: 'save', key: 'Ctrl+S', icon: 'save' },
      { label: 'Save As…', action: 'saveAs', key: 'Ctrl+Shift+S', icon: 'save' },
      { rule: true },
      { label: 'Import Image…', action: 'importImage', icon: 'image' },
      { label: 'Paste from Clipboard', action: 'paste', key: 'Ctrl+V', icon: 'clipboard' },
      { rule: true },
      { label: 'Export PNG…', action: 'exportPNG', key: 'Ctrl+Shift+E', icon: 'exportImage' },
      { label: 'Copy to Clipboard', action: 'copyImage', key: 'Ctrl+C', icon: 'clipboard' },
    ],
    edit: [
      { label: 'Undo', action: 'undo', key: 'Ctrl+Z', icon: 'undo' },
      { label: 'Redo', action: 'redo', key: 'Ctrl+Shift+Z', icon: 'redo' },
      { rule: true },
      { label: 'Clear Layer', action: 'clearLayer', key: 'Del', icon: 'clear' },
    ],
    image: [
      { label: 'New Layer', action: 'addLayer', key: 'Ctrl+Shift+N', icon: 'plus' },
      { label: 'Duplicate Layer', action: 'duplicateLayer', key: 'Ctrl+J', icon: 'duplicate' },
      { label: 'Merge Down', action: 'mergeDown', key: 'Ctrl+E', icon: 'merge' },
      { label: 'Delete Layer', action: 'deleteLayer', icon: 'trash' },
    ],
    view: [
      { label: 'Zoom In', action: 'zoomIn', key: '+', icon: 'plus' },
      { label: 'Zoom Out', action: 'zoomOut', key: '−', icon: 'minus' },
      { label: 'Fit to Window', action: 'fit', key: 'Ctrl+0', icon: 'fit' },
      { label: 'Actual Size', action: 'reset', key: 'Ctrl+1', icon: 'resize' },
      { rule: true },
      { label: 'Toggle Panels', action: 'togglePanels', key: 'Tab', icon: 'flipH' },
    ],
  },
  onAction: (action) => ({
    newDoc, openDoc, save: () => saveDoc(false), saveAs: () => saveDoc(true),
    importImage, paste: pasteImage, exportPNG, copyImage: copyToClipboard,
    undo, redo, clearLayer, addLayer, duplicateLayer, mergeDown, deleteLayer,
    zoomIn: () => { view.zoomIn(); updateZoomLabel(); invalidate(); },
    zoomOut: () => { view.zoomOut(); updateZoomLabel(); invalidate(); },
    fit: fitView, reset: resetZoom, togglePanels,
  })[action]?.(),
});

/* El slider de opacidad de capa ya viene con su markup en el HTML y se cablea a
 * mano en vez de generarlo con makeSlider: necesita agrupar todo el arrastre en
 * UNA sola entrada de historial, y eso no encaja con el contrato de makeSlider,
 * que notifica en cada cambio. */
wireOpacitySlider(q('sc-layer-op'));

function wireOpacitySlider(sliderEl) {
  const track = sliderEl.querySelector('.sc-slider__track');
  const fill = sliderEl.querySelector('.sc-slider__fill');
  const thumb = sliderEl.querySelector('.sc-slider__thumb');
  const label = q('sc-layer-op-val');

  const paint = (v) => {
    fill.style.width = `${v * 100}%`;
    thumb.style.left = `${v * 100}%`;
    label.textContent = `${Math.round(v * 100)}%`;
  };

  let pendingBefore = null;

  const apply = (v, live) => {
    const layer = doc.active;
    if (!layer) return;
    layer.opacity = Math.max(0, Math.min(1, v));
    paint(layer.opacity);
    doc.invalidateBelow();
    doc.recompose();
    layersPanel.sync();
    invalidate();
    if (!live) {
      /* Una sola entrada de historial por gesto completo, no una por frame: si
       * no, arrastrar el slider llenaria la pila con cien pasos intermedios y
       * un solo Ctrl+Z no desharia nada perceptible. */
      history.push(layersEntry(doc, pendingBefore, docState(doc), 'layer opacity'));
      markDirty(true);
    }
  };

  const fromEvent = (e) => {
    const r = track.getBoundingClientRect();
    apply((e.clientX - r.left) / r.width, true);
  };

  sliderEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pendingBefore = docState(doc);
    sliderEl.setPointerCapture(e.pointerId);
    sliderEl.classList.add('drag');
    fromEvent(e);
  });
  sliderEl.addEventListener('pointermove', (e) => {
    if (sliderEl.classList.contains('drag')) fromEvent(e);
  });
  const done = (e) => {
    if (!sliderEl.classList.contains('drag')) return;
    sliderEl.classList.remove('drag');
    try { sliderEl.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    apply(doc.active.opacity, false);
  };
  sliderEl.addEventListener('pointerup', done);
  sliderEl.addEventListener('pointercancel', done);
  sliderEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const layer = doc.active;
    if (!layer) return;
    pendingBefore = docState(doc);
    apply(layer.opacity + (e.deltaY > 0 ? -0.04 : 0.04), true);
    apply(layer.opacity, false);
  }, { passive: false });

  layerOpacity = { set: paint };
  paint(doc.active.opacity);
}

blendSelect = makeSelect(q('sc-layer-blend'), {
  options: BLEND_MODES.map((b) => ({ id: b.id, name: b.name })),
  value: 'source-over',
  tip: 'How this layer blends with the ones below',
  onChange: (id) => {
    const layer = doc.active;
    if (!layer) return;
    structural('blend mode', () => { layer.blend = id; });
    layersPanel.sync();
  },
});

// barra de herramientas
for (const btn of document.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}
q('sc-undo').addEventListener('click', undo);
q('sc-redo').addEventListener('click', redo);
q('sc-layer-add').addEventListener('click', addLayer);
q('sc-layer-dup').addEventListener('click', duplicateLayer);
q('sc-layer-merge').addEventListener('click', mergeDown);
q('sc-layer-del').addEventListener('click', deleteLayer);
q('sc-swap').addEventListener('click', () => colorPicker.swap());

// HUD de zoom
q('sc-zoom-in').addEventListener('click', () => { view.zoomIn(); updateZoomLabel(); invalidate(); });
q('sc-zoom-out').addEventListener('click', () => { view.zoomOut(); updateZoomLabel(); invalidate(); });
q('sc-zoom-fit').addEventListener('click', fitView);
q('sc-zoom-val').addEventListener('click', resetZoom);

// ── entrada del lienzo ──────────────────────────────────────────────────────

const input = new StrokeInput(canvas, {
  begin: (pt, mods) => beginStroke(pt, mods),
  move: (pt, mods) => moveStroke(pt, mods),
  end: () => endStroke(),
  hover: (pt) => {
    hoverPt = pt;
    const d = view.toDoc(pt.x, pt.y);
    q('sc-st-pos').textContent = `${Math.round(d.x)}, ${Math.round(d.y)}`;
    puck.setHover(puck.zoneAt(pt.x, pt.y));
    updateCanvasCursor();
    updateBrushCursor();
  },
  leave: () => {
    hoverPt = null;
    view.cursor = null;
    puck.setHover(null);
    q('sc-st-pos').textContent = '—';
    invalidate();
  },
  wheel: (e, x, y) => {
    if (e.altKey) {
      // alt + rueda: tamano del pincel, sin soltar el lapiz del lienzo
      const brush = brushes[tool];
      if (!brush) return;
      const step = Math.max(1, Math.round(brush.size * 0.1));
      brush.size = Math.max(1, Math.min(400, brush.size + (e.deltaY > 0 ? -step : step)));
      brushPanel.syncField('size');
      updateBrushCursor();
      return;
    }
    if (e.shiftKey) { view.pan(-e.deltaY, 0); invalidate(); return; }
    // en una app de dibujo la rueda sola hace zoom: es lo que la mano espera
    view.zoomBy(e.deltaY > 0 ? 1 / 1.14 : 1.14, x, y);
    updateZoomLabel();
    updateBrushCursor();
    invalidate();
  },
});

window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

// ── layout ──────────────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  view.resize();
  invalidate();
});
ro.observe(q('sc-view'));

window.addEventListener('resize', () => {
  view.resize();
  invalidate();
});

// las miniaturas se refrescan en reposo, no en cada trazo
setInterval(() => layersPanel.refreshThumbs(), 700);

/* Un .scrawl abierto desde el explorador (doble clic, o arrastrado al icono)
 * entra por aca en vez de por el dialogo de abrir. */
window.scrawl.file.onOpenFile(({ json, path }) => loadDoc(json, path));

// ── primer arranque ─────────────────────────────────────────────────────────

function boot() {
  view.resize();
  doc.recompose();
  view.fit();
  updateZoomLabel();
  updateStatusSize();
  layersPanel.render();
  syncLayerControls();
  syncHistoryUI();
  setTool('brush', { silent: true });
  hint(hintFor('brush'));
  invalidate();

  q('sc-app').classList.add('ready');
  const bootSplash = q('sc-boot');
  if (bootSplash) {
    /* Doble rAF: el primero deja que el layout se asiente, el segundo garantiza
     * que el frame con la app ya visible se haya pintado antes de empezar a
     * desvanecer el splash. Sin eso se ve un parpadeo entre los dos. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bootSplash.classList.add('gone');
      bootSplash.addEventListener('transitionend', () => bootSplash.remove(), { once: true });
      setTimeout(() => bootSplash.remove(), 500);
    }));
  }

  if (UI_MODE === 'demo' || UI_MODE === 'puck') runDemo({ puck: UI_MODE === 'puck' });
}

/* Trazos sinteticos con presion variable. Es la forma de verificar el motor sin
 * tablet: se corre con --ui-shot=ruta:demo y el PNG resultante muestra si los
 * pinceles, la presion y las capas hacen lo que deben. */
function runDemo({ puck: showPuck = false } = {}) {
  const samples = [
    { tool: 'brush',    color: '#e05a3c', y: 0.22 },
    { tool: 'pencil',   color: '#e8e8e8', y: 0.38 },
    { tool: 'marker',   color: '#f5c944', y: 0.54 },
    { tool: 'airbrush', color: '#3d8fd6', y: 0.70 },
  ];

  let i = 0;
  const next = () => {
    if (i >= samples.length) {
      setTool('brush');
      /* El puck se abre sobre el dibujo ya hecho, que es la unica prueba que
       * importa: sus superficies son translucidas, asi que hay que verlo tapando
       * trazos y no el vacio. */
      if (showPuck) {
        hoverPt = { x: view.cssW * 0.5, y: view.cssH * 0.46, p: 0, pen: false, type: 'mouse' };
        spaceDown = true;
        enterNav();
      }
      return;
    }
    const s = samples[i++];
    setTool(s.tool, { silent: true });
    colorPicker.setSilent(s.color);
    color = s.color;

    const y = doc.height * s.y;
    const x0 = doc.width * 0.08;
    const x1 = doc.width * 0.92;
    const amp = doc.height * 0.05;

    const screenAt = (t) => {
      const d = { x: x0 + (x1 - x0) * t, y: y + Math.sin(t * Math.PI * 3) * amp };
      const p = view.toScreen(d.x, d.y);
      return { x: p.x, y: p.y, p: Math.max(0.05, Math.sin(t * Math.PI)), pen: true, type: 'pen' };
    };

    beginStroke(screenAt(0), {});
    const STEPS = 120;
    for (let k = 1; k <= STEPS; k++) moveStroke(screenAt(k / STEPS), {});
    endStroke();

    setTimeout(next, 220);
  };
  setTimeout(next, 400);
}

// document.fonts.ready evita que el primer frame se pinte con la fuente de
// fallback y salte cuando la real carga
if (document.fonts?.ready) document.fonts.ready.then(boot);
else boot();
