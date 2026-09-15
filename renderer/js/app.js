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

import {
  ScrawlDoc, BLEND_MODES, clampRect, unionRect, loadImage, layerBounds, makeCanvas,
} from './engine/doc.js';
import { Viewport } from './engine/viewport.js';
import { Painter, BRUSHES, TOOL_SETTINGS, makeBrush, toHex } from './engine/brush.js';
import { StrokeInput, StrokePath } from './engine/stroke.js';
import { floodFill } from './engine/fill.js';
import {
  selectionRect, selectionHasPixels, copySelectionPixels, eraseSelectionPixels,
} from './engine/selection.js';
import { buildPDF } from './engine/pdf.js';
import { matchPaper, paperMm, paperPixels, formatMm } from './engine/paper.js';
import {
  History, pixelEntry, grab, snapshotCanvas, fullLayerEntry, layersEntry, docState,
  canvasEntry, canvasState, formatBytes,
} from './engine/history.js';
import { hydrateIcons, icon } from './ui/icons.js';
import { el, makeSelect, toast } from './ui/controls.js';
import { modalOpen } from './ui/modal.js';
import { openCanvasSize } from './ui/canvassize.js';
import { initUpdate } from './ui/update.js';
import { initTooltips } from './ui/tooltips.js';
import { initTitlebar } from './ui/titlebar.js';
import { initColor } from './ui/color.js';
import { initLayers } from './ui/layers.js';
import { initBrushPanel } from './ui/brushpanel.js';
import { initPuck } from './ui/puck.js';
import { initPlaceBar } from './ui/placebar.js';
import { initCloseGuard } from './ui/closeguard.js';

const q = (id) => document.getElementById(id);

/* Cuantos pixeles de arrastre duplican la escala en el zoom del puck. Con 180 el
 * nucleo entero (48px de diametro) cubre un 20% de zoom, que es el rango en el
 * que uno ajusta, y cruzar el lienzo de arriba abajo lleva de encajar a mirar el
 * pixel. Mas chico se vuelve nervioso, mas grande obliga a arrastres largos. */
const ZOOM_DRAG_PX = 180;

// ── estado ──────────────────────────────────────────────────────────────────

/* Con lo que abre la app: una A4 vertical a 300 DPI, o sea 2480x3508.
 *
 * La decision es que el default sea imprimible. Un lienzo de pantalla obliga a
 * acordarse de cambiarlo ANTES de dibujar, y el que se olvida se entera al final,
 * que es el peor momento posible. Al reves no pasa nada: si lo que estabas
 * haciendo no era para papel, el tamano de mas no molesta.
 *
 * Cuesta memoria — cuatro veces la del lienzo de pantalla que habia antes — pero
 * no velocidad: recomponer trabaja por region, asi que lo que cuesta un trazo
 * depende del trazo y no del tamano del documento. */
const DEFAULT_PAPER = { id: 'a4', orientation: 'portrait' };
const DEFAULT_DPI = 300;

/* Una ventana abierta desde otra (Ctrl+T) hereda la hoja de la que la abrio, por
 * el mismo motivo que Ctrl+N: quien se armo una A4 quiere la siguiente igual. La
 * medida viene con la ventana desde el arranque (ver preload), asi que el
 * documento nace ya del tamano correcto en vez de crearse en A4 y reemplazarse. */
const seed = window.scrawl.win.seed;
const startSize = seed
  ? { w: seed.w, h: seed.h }
  : paperPixels(DEFAULT_PAPER.id, DEFAULT_PAPER.orientation, DEFAULT_DPI);
const doc = new ScrawlDoc(startSize.w, startSize.h, seed ? seed.dpi : DEFAULT_DPI);
doc.paper = seed ? (seed.paper ?? null) : { ...DEFAULT_PAPER };
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

/* Imagen pegada que todavia no aterrizo, y el arrastre que la esta acomodando.
 * Mientras placing existe, el lienzo es de ella: mover y escalar mandan sobre
 * cualquier herramienta. Es el mismo objeto que view.placement — el viewport lo
 * pinta, aca se lo mueve. */
let placing = null;
let placeDrag = null;

/* La seleccion es geometria, no pixeles flotantes: siempre apunta al mismo rect
 * del documento y las operaciones actuan sobre la capa activa. selecting solo
 * existe mientras el puntero esta apoyado armando esa caja. */
let selection = null;
let selecting = null;

/* La recta tiene un redibujado pendiente para el proximo frame. Ver
 * renderStraight: es lo que junta los cuatro o cinco puntos que una tableta
 * entrega por frame en un solo trazado. */
let straightPending = false;

const params = new URLSearchParams(location.search);
const UI_MODE = params.get('ui');

// ── redibujado ──────────────────────────────────────────────────────────────

let scheduled = false;
function invalidate() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    // la recta se traza una vez por frame, con la ultima posicion que llego
    if (straightPending) renderStraight();
    /* La barra cuelga de la caja en coordenadas de PANTALLA, asi que la corre
     * cualquier cosa que mueva la vista: zoom, paneo, encajar, abrir los
     * paneles. Recolocarla junto al frame la deja pegada a la caja sin que cada
     * uno de esos caminos tenga que acordarse de avisar. */
    if (placing) syncPlaceBar();
    view.draw();
  });
}

function markDirty(on = true) {
  if (dirtyDoc === on) return;
  dirtyDoc = on;
  q('sc-docname').classList.toggle('dirty', on);
  // el principal lo necesita para no reiniciar la app con esto sin guardar
  window.scrawl.file.reportDirty(on);
  syncTitle();
}

/* El nombre del documento va en la barra propia y ADEMAS en el titulo de la
 * ventana, que la app no muestra pero Windows si: en Alt+Tab y en la barra de
 * tareas es lo unico que distingue dos ventanas de Scrawl entre si. */
function setDocName(path) {
  q('sc-docname').textContent = path ? baseName(path) : 'Untitled';
  syncTitle();
}

function syncTitle() {
  const name = docPath ? baseName(docPath) : 'Untitled';
  document.title = `${dirtyDoc ? '● ' : ''}${name} — Scrawl`;
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
  commitPlacement();
  if (!(next in brushes) && !['line', 'fill', 'picker', 'select', 'pan'].includes(next)) return;
  if (tool === 'select' && next !== 'select') clearSelection({ silent: true });
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
  /* Cambiar de herramienta con el puntero quieto tambien tiene que retirar o
   * recalcular el anillo: esperar al proximo pointermove deja el cursor del
   * pincel anterior flotando encima de una seleccion recien activada. */
  updateBrushCursor();
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
    select: 'Drag around an area · Ctrl+C copy · Ctrl+X cut · Del delete · Esc deselect',
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
    /* Sobre el nucleo el cursor se apaga: el puck ya ilumina la zona que esta
     * bajo el puntero, asi que la flecha del sistema no agrega ubicacion y de
     * paso tapa la lupa, que es lo que dice que ahi se hace zoom. En el anillo
     * el cursor si trabaja — ahi la mano es toda la senal de que se desplaza. */
    const overCore = zooming || (!panning && hoverPt && puck.zoneAt(hoverPt.x, hoverPt.y) === 'core');
    canvas.style.cursor = overCore ? 'none' : panning ? 'grabbing' : 'grab';
  } else if (placing) {
    /* Acomodando una imagen el cursor es el del sistema y no el anillo: aca no
     * se pinta nada, se agarra — y las flechas diagonales son lo unico que dice
     * que esas esquinas escalan. Durante el arrastre manda el tirador tomado y
     * no lo que haya abajo del puntero, que con la mano rapida se le escapa. */
    const h = placeDrag ? placeDrag.hit
      : hoverPt ? view.placementHitAt(hoverPt.x, hoverPt.y) : null;
    canvas.style.cursor = (h === 'nw' || h === 'se') ? 'nwse-resize'
      : (h === 'ne' || h === 'sw') ? 'nesw-resize'
      : 'move';
  } else if (t === 'picker') canvas.style.cursor = 'crosshair';
  else if (t === 'fill') canvas.style.cursor = 'crosshair';
  else if (t === 'select') canvas.style.cursor = 'crosshair';
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
  /* Con una imagen colocandose, el lienzo entero es suya: cualquier arrastre la
   * mueve o la escala, sin importar que herramienta este elegida. Va DESPUES del
   * paneo a proposito — navegar tiene que seguir disponible mientras se acomoda,
   * que es justo cuando uno necesita acercarse a mirar el encaje. */
  if (placing) { beginPlaceDrag(pt); return; }

  if (t === 'select') { beginSelection(docPt); return; }
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

  /* Un lapiz sin hover apoya sin haber emitido ningun pointermove: el anillo
   * quedaria donde estaba. Y aunque haya habido hover, el radio puede cambiar
   * recien aca — la goma del stylus dada vuelta se conoce en este momento. */
  hoverPt = pt;
  view.cursor = { x: pt.x, y: pt.y, r: (effective.size / 2) * view.scale };

  painter.begin(effective, color);

  // shift al apoyar = linea recta, sin cambiar de herramienta
  const straight = t === 'line' || mods.shift;

  stroke = {
    layer,
    brush: effective,
    straight,
    from: { x: docPt.x, y: docPt.y },
    /* Solo para la recta: donde esta la punta AHORA, y UNA presion para todo su
     * largo. Los puntos de por medio no se guardan porque no significan nada —
     * una recta es sus dos extremos. */
    to: { x: docPt.x, y: docPt.y },
    pressure: pt.p,
    lastRect: null,
    path: null,
  };

  if (straight) {
    renderStraight();
    invalidate();
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
  if (placeDrag) { movePlaceDrag(pt); return; }
  if (selecting) { moveSelection(view.toDoc(pt.x, pt.y)); return; }
  if (!stroke) return;

  const docPt = view.toDoc(pt.x, pt.y);

  /* El anillo sigue al puntero tambien durante el trazo: con la goma es la unica
   * senal de por donde va, porque borrar no deja marca visible. El radio sale
   * del pincel del trazo y no de effectiveTool(), que sin mods no se entera de
   * la goma del stylus dada vuelta. El invalidate es necesario aparte del de
   * flushStroke: un movimiento que el suavizado descarta no ensucia nada, y sin
   * el, el anillo se quedaria quieto justo en los trazos mas finos. */
  hoverPt = pt;
  view.cursor = { x: pt.x, y: pt.y, r: (stroke.brush.size / 2) * view.scale };
  q('sc-st-pos').textContent = `${Math.round(docPt.x)}, ${Math.round(docPt.y)}`;
  invalidate();

  if (stroke.straight) {
    stroke.to = { x: docPt.x, y: docPt.y };
    /* La presion de la recta es la mas FUERTE que vio el gesto, no la del
     * instante. Ver el porque en renderStraight. */
    stroke.pressure = Math.max(stroke.pressure, pt.p);
    straightPending = true;
    invalidate();
  } else {
    stroke.path.push({ x: docPt.x, y: docPt.y, p: pt.p });
    flushStroke();
  }
  updatePressureMeter(pt);
}

/* La linea recta se re-dibuja ENTERA cada vez: se limpia el wet y se vuelve a
 * trazar desde el origen. Es lo que permite verla seguir al puntero antes de
 * soltar. Dos cosas la hacen distinta de un trazo a mano alzada:
 *
 * ── Una sola presion para todo el largo, y es la mas fuerte del gesto ───────
 * Antes cada extremo llevaba su presion instantanea y el rasterizador
 * interpolaba entre las dos. Con un lapiz eso no es un degrade, es un bug: la
 * presion del ARRANQUE es siempre casi cero — la punta recien toca — y la del
 * otro extremo cambia a cada momento, asi que la linea entera cambiaba de peso
 * mientras uno la estiraba y, al levantar el lapiz, la presion cae a cero y la
 * linea se desplomaba a un pelo tenue justo en el frame que se guardaba. Con
 * mouse no se veia nunca: ahi la presion es 1 fija.
 *
 * Se toma el maximo y no la actual porque el maximo no retrocede. Apretar mas
 * engorda la linea — la expresion se conserva — pero aflojar para levantar la
 * punta ya no se la lleva puesta. Y con las dos puntas a la misma presion la
 * recta sale de ancho parejo, que es lo que una recta tiene que ser: la cuna
 * que salia antes (fina en el origen, gruesa en la punta) tampoco la queria
 * nadie.
 *
 * ── Un redibujado por FRAME, no por evento ─────────────────────────────────
 * Redibujar la recta cuesta en proporcion a su largo: con un pincel fino son
 * miles de estampas, medidas en 7-12 ms cada vez. Una tableta entrega cuatro o
 * cinco puntos por frame y todos entraban por aca, asi que el trabajo se
 * multiplicaba por cinco y el hilo principal no llegaba — de ahi el tironeo.
 * Coalescer a uno por frame no pierde NADA: para una recta los puntos de por
 * medio no existen, solo cuenta donde esta la punta ahora. */
function renderStraight() {
  straightPending = false;
  if (!stroke || !stroke.straight) return;

  const before = painter.clearWet();
  const a = { x: stroke.from.x, y: stroke.from.y, p: stroke.pressure };
  const b = { x: stroke.to.x, y: stroke.to.y, p: stroke.pressure };
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) painter.dot(a);
  else painter.segment(a, b);

  // hay que recomponer tambien donde ESTABA la linea, o queda su fantasma
  const region = unionRect(before, painter.dirty);
  if (region) doc.recompose(region, painter.wetLayer);
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
  if (placeDrag) { endPlaceDrag(); return; }
  if (selecting) { endSelection(); return; }
  if (!stroke) return;

  /* La recta puede tener un frame pendiente: el ultimo movimiento del puntero
   * llego despues del ultimo rAF. Sin esto se guardaria la linea del frame
   * anterior y la punta quedaria un paso atras de donde se solto. */
  if (straightPending) renderStraight();

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

// ── seleccion rectangular ───────────────────────────────────────────────────

function setSelection(rect) {
  selection = rect;
  view.selection = rect;
  invalidate();
}

function beginSelection(docPt) {
  selecting = { from: docPt, to: docPt };
  setSelection(null);
  hint('Drag around the area to select');
}

function moveSelection(docPt) {
  selecting.to = docPt;
  const rect = selectionRect(selecting.from, selecting.to, doc.width, doc.height);
  setSelection(rect);
  if (rect) hint(`Selecting ${rect.w}×${rect.h}`);
}

function endSelection() {
  const rect = selectionRect(selecting.from, selecting.to, doc.width, doc.height);
  selecting = null;
  setSelection(rect);
  hint(rect
    ? `Selected ${rect.w}×${rect.h} · Ctrl+C copy · Ctrl+X cut · Del delete · Esc deselect`
    : hintFor('select'));
}

function clearSelection({ silent = false } = {}) {
  if (!selection && !selecting) return false;
  selecting = null;
  setSelection(null);
  if (!silent) hint(hintFor(tool));
  return true;
}

async function copySelection({ announce = true } = {}) {
  const layer = doc.active;
  const rect = selection;
  if (!layer || !rect) return false;
  if (!selectionHasPixels(layer, rect)) {
    if (announce) toast('That part of the layer is empty', 'clipboard');
    return false;
  }

  const crop = copySelectionPixels(layer, rect);
  const blob = await new Promise((resolve) => crop.toBlob(resolve, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  await window.scrawl.clip.writeLayer(buf, {
    name: `${layer.name} fragment`,
    opacity: layer.opacity,
    blend: layer.blend,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    docW: doc.width, docH: doc.height,
  });
  if (announce) toast(`Copied selection · ${rect.w}×${rect.h}`, 'clipboard');
  return true;
}

function eraseSelected(label, announce = true) {
  const layer = doc.active;
  const rect = selection;
  if (!layer || !rect) return false;
  if (!selectionHasPixels(layer, rect)) {
    if (announce) toast('That part of the layer is already empty', 'clear');
    return false;
  }

  const before = grab(layer, rect);
  eraseSelectionPixels(layer, rect);
  const after = grab(layer, rect);
  history.push(pixelEntry(layer, rect, before, after, label));
  doc.recompose(rect);
  markDirty(true);
  invalidate();
  layersPanel.refreshThumbs();
  if (announce) toast(`Deleted selection · ${rect.w}×${rect.h}`, 'clear');
  return true;
}

async function cutSelection() {
  if (!selection) return;
  const layer = doc.active;
  const rect = { ...selection };
  if (!(await copySelection({ announce: false }))) return;
  /* El portapapeles cruza IPC. Si durante ese await se cambio de capa o se armo
   * otra seleccion, no hay que cortar ese destino nuevo: la copia ya hecha sigue
   * siendo valida y la interrupcion convierte la accion, de forma segura, en
   * solo copiar. */
  if (doc.active !== layer || !selection
    || selection.x !== rect.x || selection.y !== rect.y
    || selection.w !== rect.w || selection.h !== rect.h) return;
  if (eraseSelected('cut selection', false)) {
    toast(`Cut selection · ${rect.w}×${rect.h}`, 'clipboard');
  }
}

function deleteSelection() { eraseSelected('delete selection'); }

function clearLayer() {
  commitPlacement();
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
  commitPlacement();
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
  commitPlacement();
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

/* El tamano del lienzo en la barra de estado. Cuando el documento tiene medida
 * de papel se muestra el nombre junto a los pixeles, porque es el dato que uno
 * quiere confirmar de reojo mientras dibuja: "sigo adentro de la A4". */
function updateStatusSize() {
  const paper = doc.paper ? matchPaper(doc.width, doc.height, doc.dpi) : null;
  q('sc-st-size').textContent = paper
    ? `${doc.width}×${doc.height} · ${paper.name}`
    : `${doc.width}×${doc.height}`;
  q('sc-st-canvas').setAttribute('data-tip', paper
    ? `${paper.name} ${paper.orientation} — ${formatMm(doc.width, doc.height, doc.dpi)} at ${doc.dpi} DPI`
    : `Canvas size — ${formatMm(doc.width, doc.height, doc.dpi)} at ${doc.dpi} DPI`);
}

// ── tamano del lienzo ───────────────────────────────────────────────────────

function canvasSizeDialog() {
  if (modalOpen()) return;
  commitPlacement();
  openCanvasSize({ doc, onApply: applyCanvasSize });
}

/* Aplica lo que devolvio el dialogo.
 *
 * El paso se anota con canvasEntry y no con layersEntry: layersEntry restaura el
 * tamano llamando de vuelta a resize(), que sobre capas ya recortadas devolveria
 * un lienzo grande con el dibujo mutilado. canvasEntry se queda con los canvas
 * originales, asi que achicar el lienzo y deshacer devuelve hasta el ultimo
 * pixel que quedo afuera. */
function applyCanvasSize({ w, h, dpi, paper, anchor, scale }) {
  clearSelection({ silent: true });
  const before = canvasState(doc);

  doc.dpi = dpi;
  doc.paper = paper;
  doc.resize(w, h, anchor, scale);

  history.push(canvasEntry(doc, before, canvasState(doc), 'canvas size'));

  painter.syncSize();
  updateStatusSize();
  view.fit();
  updateZoomLabel();
  markDirty(true);
  refreshAll();
  layersPanel.refreshThumbs();

  const name = paper ? matchPaper(w, h, dpi)?.name : null;
  toast(name ? `Canvas ${name} · ${w}×${h}` : `Canvas ${w}×${h}`, 'resize');
}

// ── archivos ────────────────────────────────────────────────────────────────

async function exportPNG() {
  commitPlacement();
  const flat = doc.render();
  const blob = await new Promise((r) => flat.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const name = (docPath ? baseName(docPath) : 'scrawl') + '.png';
  const res = await window.scrawl.file.exportPNG(buf, name);
  if (res.ok) toast(`Exported ${baseName(res.path)}`, 'exportImage');
}

/* La pagina del PDF sale del tamano del LIENZO, no de una hoja con margenes: lo
 * que se exporta es el dibujo, a sangre. Cuanto mide ese lienzo en papel lo dice
 * su densidad — un lienzo comun queda a 96 DPI y sale del tamano al que lo veias
 * al 100%; uno con tamano de impresion sale exactamente de la hoja que elegiste,
 * y ahi imprimir es mandarlo a la impresora sin tocar nada.
 *
 * El papel se vuelve a medir contra los pixeles en vez de confiar en la etiqueta
 * del documento: si por lo que sea no se corresponden, mejor una pagina del
 * tamano real que una que dice A4 y estira el dibujo para llegar. */
async function exportPDF() {
  commitPlacement();
  const flat = doc.render();
  const px = flat.getContext('2d').getImageData(0, 0, flat.width, flat.height);
  const paper = doc.paper ? matchPaper(doc.width, doc.height, doc.dpi) : null;
  const bytes = await buildPDF(px, {
    dpi: doc.dpi,
    pageMm: paper ? paperMm(paper.id, paper.orientation) : null,
  });
  const name = (docPath ? baseName(docPath) : 'scrawl') + '.pdf';
  const res = await window.scrawl.file.exportPDF(bytes, name);
  if (res.ok) {
    toast(paper
      ? `Exported ${baseName(res.path)} · ${paper.name}`
      : `Exported ${baseName(res.path)}`, 'exportPdf');
  }
}

async function copyToClipboard() {
  commitPlacement();
  if (selection) return copySelection();
  const flat = doc.render();
  const blob = await new Promise((r) => flat.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  await window.scrawl.clip.writeImage(buf);
  toast('Copied to clipboard', 'clipboard');
}

/* Copia SOLO la capa activa, para pegarla en otro dibujo — otra ventana, o este
 * mismo — como capa: al pegar vuelve con su nombre, su opacidad y su blend, y en
 * el mismo punto del lienzo del que salio si las hojas miden igual.
 *
 * Va recortada a lo pintado, no la hoja entera. Un garabato de 300x200 en una A4
 * es un PNG de 300x200 y no de 2480x3508 casi vacio, y al pegarlo la caja con la
 * que se acomoda abraza el dibujo en vez de ser todo el lienzo — asi de paso se
 * lo puede correr o escalar antes de soltarlo. El recorte viaja en la marca
 * (x, y) para que el aterrizaje sea exacto.
 *
 * Al portapapeles va como imagen normal ademas de con su marca: en cualquier
 * otra app se pega como un PNG con transparencia. */
async function copyLayer() {
  commitPlacement();
  const layer = doc.active;
  if (!layer) return;
  const b = layerBounds(layer);
  if (!b) { toast('That layer is empty — nothing to copy', 'clipboard'); return; }

  const crop = makeCanvas(b.w, b.h);
  crop.getContext('2d').drawImage(layer.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  const blob = await new Promise((r) => crop.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  await window.scrawl.clip.writeLayer(buf, {
    name: layer.name,
    opacity: layer.opacity,
    blend: layer.blend,
    x: b.x, y: b.y, w: b.w, h: b.h,
    docW: doc.width, docH: doc.height,
  });
  toast(`Copied “${layer.name}” · ${b.w}×${b.h}`, 'clipboard');
}

/* Devuelve si quedo guardado: quien pregunta "guardar antes de cerrar" — o de
 * reiniciar — necesita saber si el dialogo de archivo se cancelo. */
async function saveDoc(forceDialog = false) {
  commitPlacement();
  const json = JSON.stringify(doc.toJSON());
  const res = await window.scrawl.file.saveDoc(
    json,
    docPath ? baseName(docPath) + '.scrawl' : 'untitled.scrawl',
    forceDialog ? null : docPath,
  );
  if (!res.ok) return false;
  docPath = res.path;
  setDocName(res.path);
  markDirty(false);
  toast(`Saved ${baseName(res.path)}`, 'save');
  return true;
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
  /* El documento se va entero: una imagen a medio acomodar sobre el anterior no
   * tiene donde aterrizar. */
  endPlacement();
  clearSelection({ silent: true });
  doc.width = next.width;
  doc.height = next.height;
  doc.dpi = next.dpi;
  doc.paper = next.paper;
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
  setDocName(path);
  markDirty(false);
  updateStatusSize();
  view.fit();
  updateZoomLabel();
  refreshAll();
}

/* Hereda la medida del documento anterior, papel incluido: quien se armo una A4
 * para dibujar quiere la siguiente hoja igual, no volver al lienzo de fabrica. */
function newDoc() {
  const fresh = new ScrawlDoc(doc.width, doc.height, doc.dpi);
  fresh.paper = doc.paper;
  adoptDoc(fresh, null);
  toast('New drawing', 'newDoc');
}

/* Otro documento SIN cerrar este: una ventana mas, con su propio dibujo, su
 * historial y su vista. Es lo que permite tener dos dibujos abiertos a la vez y
 * pasar cosas de uno al otro — copiar una capa aca, pegarla alla — o tener una
 * referencia a la vista mientras se trabaja en el otro. Hereda la hoja, igual
 * que Ctrl+N. */
function newWindow() {
  window.scrawl.win.newWindow({ w: doc.width, h: doc.height, dpi: doc.dpi, paper: doc.paper });
}

/* Cierra ESTA ventana por el mismo camino que la X: si hay cambios sin guardar,
 * el principal frena y pregunta (ver ui/closeguard.js). Antes Ctrl+W cerraba
 * igual — lo hacia el menu por defecto de Electron, sin preguntar nada. */
function closeWindow() {
  window.scrawl.win.close();
}

// ── colocar una imagen ──────────────────────────────────────────────────────

/* Pegar una captura la deja FLOTANDO sobre el lienzo, a su tamano real, hasta
 * que uno la deja donde quiere.
 *
 * El lienzo no se toca. Antes se acomodaba a la imagen — un documento intacto
 * pasaba a medir exactamente la captura — y eso resolvia un solo caso: abrir la
 * app para anotar una captura y exportar esa captura. El resto del tiempo
 * secuestraba la hoja. Quien se armo una A4 para meter dos capturas adentro se
 * encontraba con que la primera se llevaba puesto el documento, y sin forma de
 * correrla ni de achicarla despues.
 *
 * "A tamano real" es 1:1 en pixeles del DOCUMENTO, no del tamano fisico. Un
 * lienzo de impresion tiene mas pixeles por pulgada que la pantalla, asi que
 * igualar los milimetros obligaria a agrandar la captura tres veces — que es
 * exactamente el remuestreo que esto existe para no hacer. Entra sin tocar un
 * pixel y de ahi la escala la elige la mano.
 *
 * Mientras flota no hay nada en el documento: ni capa, ni paso de historial. La
 * imagen vive en el viewport, que la pinta encima del compuesto. Recien al
 * soltarla se crea la capa y se anota el paso. Eso es lo que la deja arrastrarse
 * a 60 fps sobre un lienzo de 2480x3508 — moviendo una capa de verdad habria que
 * repintarla y recomponer el lienzo entero en cada frame. */

/* Lo que dice la barra de estado mientras la imagen flota. Vive aparte porque
 * hay dos caminos que lo reponen: arrancar el acomodo, y salir del modo
 * navegacion — soltar la barra espaciadora ahi dentro no puede dejar en pantalla
 * el consejo del pincel, que en ese momento no se puede usar. */
const PLACE_HINT = 'Drag to move · corners to scale · Enter to place · Esc to discard';

const MIN_PLACE = 16;      // lado minimo en px de documento: mas chico no se agarra
const MAX_PLACE = 32000;   // techo duro, por si un arrastre se desboca

async function placeImage(src, label, layer = null) {
  let img;
  try {
    img = await loadImage(src);
  } catch {
    URL.revokeObjectURL(src);
    toast('That image could not be read', 'clear', 3200);
    return;
  }
  startPlacement(img, label, src, layer);
}

/* Arranca el estado flotante. Si ya habia una imagen acomodandose, esa aterriza
 * donde estaba: pegar dos veces seguidas deja las dos, no pierde la primera.
 *
 * layer es la marca de una capa copiada desde Scrawl, si la imagen es una. Con
 * ella la imagen no se centra: aparece en el punto exacto del que salio, para
 * que pasar una capa de un dibujo al otro la deje donde estaba — siempre que las
 * dos hojas midan lo mismo, porque en una de otra medida "el mismo punto" no
 * quiere decir nada y ahi vuelve a valer el centro. Y al soltarla, la capa nace
 * con la opacidad y el blend que tenia. */
function startPlacement(img, label, url, layer = null) {
  commitPlacement();
  clearSelection({ silent: true });

  const same = layer && layer.docW === doc.width && layer.docH === doc.height;
  const c = visibleCenter();
  placing = {
    img, label, url,
    w: img.width,
    h: img.height,
    x: same ? layer.x : Math.round(c.x - img.width / 2),
    y: same ? layer.y : Math.round(c.y - img.height / 2),
    handle: null,
    active: null,
    layer: layer ? { opacity: layer.opacity, blend: layer.blend } : null,
  };
  view.placement = placing;

  ensurePlacementVisible();
  placeBar.show();
  view.cursor = null;
  updateCanvasCursor();
  hint(PLACE_HINT);
  invalidate();
}

/* Centro de lo que se esta VIENDO del lienzo. Con el documento entero a la vista
 * es su centro, que es el caso comun. Metido en un rincon al 400%, poner la
 * captura en el centro del documento la dejaria fuera de la pantalla, y lo
 * primero que se veria de pegar seria nada. */
function visibleCenter() {
  const a = view.toDoc(0, 0);
  const b = view.toDoc(view.cssW, view.cssH);
  const x0 = Math.max(0, a.x), x1 = Math.min(doc.width, b.x);
  const y0 = Math.max(0, a.y), y1 = Math.min(doc.height, b.y);
  if (x1 <= x0 || y1 <= y0) return { x: doc.width / 2, y: doc.height / 2 };
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/* Una captura mas grande que la ventana entra con sus tiradores fuera de
 * pantalla, y ahi no hay como achicarla: el control para hacerlo son justo las
 * esquinas que no se ven. Cuando la caja no entra se encuadra la union de lienzo
 * e imagen, que ademas muestra de una cuanto sobresale. */
function ensurePlacementVisible() {
  const r = view.placeRect;
  const m = 36;   // aire para que los tiradores no queden pegados al borde
  if (r.x >= m && r.y >= m && r.x + r.w <= view.cssW - m && r.y + r.h <= view.cssH - m) return;
  const box = { x: placing.x, y: placing.y, w: placing.w, h: placing.h };
  view.fitRect(unionRect(doc.bounds, box), 0.86);
  updateZoomLabel();
}

function beginPlaceDrag(pt) {
  placing.active = view.placementHitAt(pt.x, pt.y);
  placeDrag = {
    hit: placing.active,
    from: view.toDoc(pt.x, pt.y),
    rect: { x: placing.x, y: placing.y, w: placing.w, h: placing.h },
  };
  placeBar.setBusy(true);
  updateCanvasCursor();
  invalidate();
}

function movePlaceDrag(pt) {
  const d = view.toDoc(pt.x, pt.y);
  const r = placeDrag.rect;

  if (placeDrag.hit === 'move') {
    placing.x = r.x + (d.x - placeDrag.from.x);
    placing.y = r.y + (d.y - placeDrag.from.y);
  } else {
    scalePlacement(placeDrag.hit, r, d.x - placeDrag.from.x, d.y - placeDrag.from.y);
  }

  hoverPt = pt;
  q('sc-st-pos').textContent = `${Math.round(d.x)}, ${Math.round(d.y)}`;
  invalidate();
}

/* Escala desde la esquina OPUESTA a la que se arrastra: esa se queda clavada y
 * la imagen crece hacia ella, que es lo que la mano espera de un tirador.
 *
 * Siempre proporcional, sin modificador para deformar. No hay un solo caso de
 * esta app en el que estirar una captura sea lo que se queria, y la tecla para
 * permitirlo seria una trampa esperando un shift accidental.
 *
 * El factor sale de proyectar el arrastre sobre la diagonal de la caja. Tomar un
 * solo eje — el ancho, digamos — haria que arrastrar hacia abajo no escalara, y
 * tomar el mayor de los dos haria saltar la escala cuando la mano cruza la
 * diagonal. La proyeccion reparte: cada direccion escala en su proporcion. */
function scalePlacement(hit, r, dx, dy) {
  const west = hit === 'nw' || hit === 'sw';
  const north = hit === 'nw' || hit === 'ne';

  // la esquina ancla, en coordenadas de documento
  const ax = west ? r.x + r.w : r.x;
  const ay = north ? r.y + r.h : r.y;

  // adonde quedo la esquina arrastrada, medida desde el ancla
  const wantW = Math.abs((west ? r.x + dx : r.x + r.w + dx) - ax);
  const wantH = Math.abs((north ? r.y + dy : r.y + r.h + dy) - ay);

  const k = (wantW * r.w + wantH * r.h) / (r.w * r.w + r.h * r.h);
  const lo = Math.max(MIN_PLACE / r.w, MIN_PLACE / r.h);
  const hi = Math.min(MAX_PLACE / r.w, MAX_PLACE / r.h);
  const f = Math.min(hi, Math.max(lo, k));

  placing.w = r.w * f;
  placing.h = r.h * f;
  placing.x = west ? ax - placing.w : ax;
  placing.y = north ? ay - placing.h : ay;
}

function endPlaceDrag() {
  placeDrag = null;
  if (placing) placing.active = null;
  placeBar.setBusy(false);
  updateCanvasCursor();
  invalidate();
}

/* Empujon con las flechas, en pixeles del DOCUMENTO. Al 25% de zoom un paso de
 * pantalla serian cuatro del documento, y entonces las flechas no servirian para
 * lo unico que sirven: el ajuste fino de la ultima vuelta. */
function nudgePlacement(dx, dy) {
  placing.x += dx;
  placing.y += dy;
  invalidate();
}

/* Vuelta al tamano real sin moverla de donde esta: crece o se achica alrededor
 * de su propio centro. Es el gesto del porcentaje del HUD de zoom, que tocandolo
 * vuelve al 100%. */
function resetPlacementScale() {
  if (!placing) return;
  const cx = placing.x + placing.w / 2;
  const cy = placing.y + placing.h / 2;
  placing.w = placing.img.width;
  placing.h = placing.img.height;
  placing.x = cx - placing.w / 2;
  placing.y = cy - placing.h / 2;
  invalidate();
}

/* Aterriza la imagen en una capa nueva. Devuelve si quedo algo colocado.
 *
 * Se llama tambien desde cualquier accion que no puede convivir con una imagen
 * flotando — exportar, guardar, tocar las capas, cambiar de herramienta. Ahi lo
 * correcto es que aterrice y no que se pierda: queda como paso de historial, asi
 * que un Ctrl+Z la saca si no era lo que se queria.
 *
 * El remuestreo se hace UNA sola vez, ya escalada, directo sobre la capa. La
 * calidad importa aca y sale gratis: es una operacion por pegado, no una por
 * frame. */
function commitPlacement() {
  if (!placing) return false;
  const p = placing;
  const rect = {
    x: Math.round(p.x),
    y: Math.round(p.y),
    w: Math.max(1, Math.round(p.w)),
    h: Math.max(1, Math.round(p.h)),
  };

  /* Entera afuera del lienzo no queda nada que colocar, y una capa vacia con
   * nombre de captura confunde mas que no hacer nada. */
  const inside = clampRect(rect, doc.width, doc.height);
  if (inside.w <= 0 || inside.h <= 0) {
    endPlacement();
    toast('That landed outside the canvas', 'clear', 2800);
    return false;
  }

  const before = docState(doc);
  const layer = doc.addLayer(doc.layers.length, p.label);
  // una capa copiada vuelve como era, no como una captura mas
  if (p.layer) {
    layer.opacity = p.layer.opacity;
    layer.blend = p.layer.blend;
  }
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = 'high';
  layer.ctx.drawImage(p.img, rect.x, rect.y, rect.w, rect.h);
  layer.rev++;
  history.push(layersEntry(doc, before, docState(doc), 'place image'));

  endPlacement();
  layersPanel.markEntering(layer.id);
  markDirty(true);
  refreshAll();
  toast(p.layer
    ? `Placed “${p.label}” · ${rect.w}×${rect.h}`
    : `Placed ${rect.w}×${rect.h}`, 'image');
  return true;
}

function cancelPlacement() {
  if (!placing) return;
  endPlacement();
  toast('Discarded', 'clear', 1400);
}

/* Cierra el estado flotante sin decidir nada sobre la imagen. La URL del blob se
 * suelta aca y no apenas termina de decodificar: revocarla antes obligaria a
 * confiar en que Chromium jamas vuelve a buscar los bytes de una imagen que ya
 * cargo, y esta se queda en pantalla todo lo que dure el acomodo. */
function endPlacement() {
  if (placing?.url) URL.revokeObjectURL(placing.url);
  placing = null;
  placeDrag = null;
  view.placement = null;
  placeBar.hide();
  updateCanvasCursor();
  updateBrushCursor();
  hint(hintFor(tool));
  invalidate();
}

function syncPlaceBar() {
  placeBar.setSize(placing.w, placing.h, placing.w / placing.img.width);
  placeBar.place(view.placeRect, view.cssW, view.cssH);
}

async function pasteImage() {
  const res = await window.scrawl.clip.readImage();
  if (!res) { toast('No image in the clipboard', 'clipboard'); return; }
  /* Blob sin type: el portapapeles puede traer los pixeles (PNG) o el archivo
   * tal cual, que bien puede ser un JPEG de ShareX. El decodificador sniffea los
   * bytes, asi que declarar un tipo aca solo abriria la posibilidad de mentirle. */
  const blob = new Blob([new Uint8Array(res.data)]);
  /* Una capa copiada desde Scrawl trae su marca y vuelve con su nombre; con un
   * archivo detras, la capa lleva el del archivo en vez de un 'Pasted' mas. */
  if (res.layer) {
    await placeImage(URL.createObjectURL(blob), res.layer.name || 'Layer', res.layer);
    return;
  }
  await placeImage(URL.createObjectURL(blob), res.path ? baseName(res.path) : 'Pasted');
}

async function importImage() {
  const res = await window.scrawl.file.openImage();
  if (!res.ok) return;
  const blob = new Blob([new Uint8Array(res.data)]);
  await placeImage(URL.createObjectURL(blob), baseName(res.path));
}

function baseName(p) {
  const f = String(p).split(/[\\/]/).pop();
  return f.replace(/\.(scrawl|png|jpe?g|webp|bmp|gif|pdf)$/i, '');
}

// ── undo / redo ─────────────────────────────────────────────────────────────

function undo() {
  /* Con una imagen todavia acomodandose, el ultimo paso no esta en la pila: es
   * ella. Deshacer ahi es descartarla. */
  if (placing) { cancelPlacement(); return; }
  if (!history.canUndo) return;
  const size = { w: doc.width, h: doc.height, dpi: doc.dpi, paper: doc.paper };
  history.undo();
  afterTimeTravel(size);
}

function redo() {
  if (!history.canRedo) return;
  const size = { w: doc.width, h: doc.height, dpi: doc.dpi, paper: doc.paper };
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
  } else if (doc.dpi !== size.dpi || doc.paper !== size.paper) {
    // el lienzo mide lo mismo pero ya no vale lo mismo en papel: la vista no se
    // mueve, el dato de la barra si
    updateStatusSize();
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
  hint(placing ? PLACE_HINT : hintFor(tool));
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

const TOOL_KEYS = { b: 'brush', p: 'pencil', m: 'marker', a: 'airbrush', e: 'eraser', l: 'line', g: 'fill', i: 'picker', s: 'select', h: 'pan' };

function onKeyDown(e) {
  // mientras se escribe en un campo, el teclado es del campo
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  /* Con un dialogo abierto los atajos de la app no existen: una 'b' ahi es una
   * letra, no el pincel, y un Ctrl+Z tendria que deshacer lo que el dialogo
   * hizo, que todavia no hizo nada. El dialogo maneja Escape y Enter por su
   * cuenta y no los deja llegar hasta aca. */
  if (modalOpen()) return;

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

  /* Con una imagen acomodandose el teclado es de ella: aterrizar, descartar y el
   * empujon fino. Espacio y Alt siguen arriba porque navegar mientras se acomoda
   * es justo lo que uno necesita para mirar el encaje de cerca. El resto de los
   * atajos tampoco se pierde — cambiar de herramienta o exportar la hacen
   * aterrizar primero. */
  if (placing) {
    if (k === 'enter') { e.preventDefault(); commitPlacement(); return; }
    // descartar tiene las dos teclas que uno prueba: la de cancelar y la de tirar
    if (k === 'escape' || k === 'delete' || k === 'backspace') {
      e.preventDefault();
      cancelPlacement();
      return;
    }
    if (k.startsWith('arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudgePlacement(
        (k === 'arrowright' ? step : 0) - (k === 'arrowleft' ? step : 0),
        (k === 'arrowdown' ? step : 0) - (k === 'arrowup' ? step : 0),
      );
      return;
    }
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
      // Ctrl+P a secas queda libre a proposito: es el reflejo de imprimir, y esto
      // no imprime. El PDF va con Shift, en la misma familia que el PNG.
      case 'p': if (e.shiftKey) { e.preventDefault(); exportPDF(); } return;
      case 'v': e.preventDefault(); pasteImage(); return;
      case 'x': e.preventDefault(); cutSelection(); return;
      /* Ctrl+Alt+C es el atajo de toda la vida para el tamano del lienzo. Con
       * Shift se copia SOLO la capa activa; a secas, el dibujo entero. */
      case 'c':
        e.preventDefault();
        if (e.altKey) canvasSizeDialog();
        else if (e.shiftKey) copyLayer();
        else copyToClipboard();
        return;
      // la tecla de "otra pestana" de cualquier navegador: aca es otra ventana
      case 't': e.preventDefault(); newWindow(); return;
      case 'w': e.preventDefault(); closeWindow(); return;
      case '0': e.preventDefault(); fitView(); return;
      case '1': e.preventDefault(); resetZoom(); return;
      /* Con Ctrl, las mismas teclas de zoom que sin el. Hasta que se saco el
       * menu por defecto de Electron, Ctrl+Plus agrandaba la INTERFAZ entera —
       * y Chromium se lo acordaba entre sesiones. */
      case '+': case '=': e.preventDefault(); view.zoomIn(); updateZoomLabel(); invalidate(); return;
      case '-': e.preventDefault(); view.zoomOut(); updateZoomLabel(); invalidate(); return;
      default: return;
    }
  }

  if (k === 'tab') { e.preventDefault(); togglePanels(); return; }
  if (k === 'escape' && clearSelection()) { e.preventDefault(); return; }
  if (k === 'x') { colorPicker.swap(); return; }
  if (k === 'delete' || k === 'backspace') {
    e.preventDefault();
    if (selection) deleteSelection();
    else clearLayer();
    return;
  }

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
  if (placing || !brush || t === 'pan' || t === 'picker' || t === 'fill') {
    view.cursor = null;
  } else {
    view.cursor = { x: hoverPt.x, y: hoverPt.y, r: (brush.size / 2) * view.scale };
  }
  invalidate();
}

// ── arranque de la interfaz ─────────────────────────────────────────────────

hydrateIcons();
initTooltips();

/* Va antes que el puck a proposito: son dos flotantes sobre el mismo contenedor
 * y el orden del DOM decide cual queda arriba. El puck aparece con la mano ya en
 * el gesto, asi que gana el. */
const placeBar = initPlaceBar(q('sc-view'), {
  onPlace: commitPlacement,
  onCancel: cancelPlacement,
  onReset: resetPlacementScale,
});

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

/* El aviso de actualizacion necesita dos cosas de aca: si hay trabajo sin
 * guardar — reiniciar para actualizar lo perderia — y como guardarlo. */
const updater = initUpdate({
  isDirty: () => dirtyDoc,
  save: () => saveDoc(false),
});

// cerrar la ventana con cambios sin guardar pregunta primero; necesita lo mismo
initCloseGuard({
  isDirty: () => dirtyDoc,
  docName: () => (docPath ? baseName(docPath) : 'Untitled'),
  save: () => saveDoc(false),
});

initTitlebar({
  isEnabled: (action) => {
    if (action === 'undo') return history.canUndo;
    if (action === 'redo') return history.canRedo;
    if (action === 'mergeDown') return doc.activeIndex > 0;
    if (action === 'deleteLayer') return doc.layers.length > 1;
    if (action === 'copySelection' || action === 'cutSelection' || action === 'deleteSelection') return !!selection;
    return true;
  },
  menus: {
    file: [
      { label: 'New', action: 'newDoc', key: 'Ctrl+N', icon: 'newDoc' },
      { label: 'New Window', action: 'newWindow', key: 'Ctrl+T', icon: 'newWindow' },
      { label: 'Open…', action: 'openDoc', key: 'Ctrl+O', icon: 'open' },
      { label: 'Save', action: 'save', key: 'Ctrl+S', icon: 'save' },
      { label: 'Save As…', action: 'saveAs', key: 'Ctrl+Shift+S', icon: 'save' },
      { label: 'Close Window', action: 'closeWindow', key: 'Ctrl+W', icon: 'winClose' },
      { rule: true },
      { label: 'Import Image…', action: 'importImage', icon: 'image' },
      { label: 'Paste from Clipboard', action: 'paste', key: 'Ctrl+V', icon: 'clipboard' },
      { rule: true },
      { label: 'Export PNG…', action: 'exportPNG', key: 'Ctrl+Shift+E', icon: 'exportImage' },
      { label: 'Export PDF…', action: 'exportPDF', key: 'Ctrl+Shift+P', icon: 'exportPdf' },
      { label: 'Copy to Clipboard', action: 'copyImage', key: 'Ctrl+C', icon: 'clipboard' },
      { rule: true },
      { label: 'Check for Updates…', action: 'checkUpdates', icon: 'download' },
    ],
    edit: [
      { label: 'Undo', action: 'undo', key: 'Ctrl+Z', icon: 'undo' },
      { label: 'Redo', action: 'redo', key: 'Ctrl+Shift+Z', icon: 'redo' },
      { rule: true },
      { label: 'Cut Selection', action: 'cutSelection', key: 'Ctrl+X', icon: 'select' },
      { label: 'Copy Selection', action: 'copySelection', key: 'Ctrl+C', icon: 'select' },
      { label: 'Delete Selection', action: 'deleteSelection', key: 'Del', icon: 'clear' },
      { rule: true },
      { label: 'Copy Layer', action: 'copyLayer', key: 'Ctrl+Shift+C', icon: 'clipboard' },
      { label: 'Clear Layer', action: 'clearLayer', key: 'Del', icon: 'clear' },
    ],
    image: [
      { label: 'Canvas Size…', action: 'canvasSize', key: 'Ctrl+Alt+C', icon: 'resize' },
      { rule: true },
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
    newDoc, newWindow, closeWindow, openDoc, save: () => saveDoc(false), saveAs: () => saveDoc(true),
    importImage, paste: pasteImage, exportPNG, exportPDF, copyImage: copyToClipboard, copyLayer,
    checkUpdates: () => updater.checkNow(),
    undo, redo, clearLayer, copySelection, cutSelection, deleteSelection, canvasSize: canvasSizeDialog,
    addLayer, duplicateLayer, mergeDown, deleteLayer,
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
q('sc-st-canvas').addEventListener('click', canvasSizeDialog);

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
    // el tirador bajo el puntero se ilumina: es lo que dice que ahi se escala
    if (placing) placing.handle = view.placementHitAt(pt.x, pt.y);
    updateCanvasCursor();
    updateBrushCursor();
  },
  leave: () => {
    hoverPt = null;
    view.cursor = null;
    if (placing) placing.handle = null;
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
  syncTitle();
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

  if (UI_MODE === 'demo' || UI_MODE === 'puck' || UI_MODE === 'selection') {
    runDemo({ puck: UI_MODE === 'puck', selection: UI_MODE === 'selection' });
  }
  /* Mismo motivo que el modo puck: un dialogo modal solo existe mientras alguien
   * lo tiene abierto, y sin esto no habria forma de mirarlo sin estar sentado
   * frente a la app. */
  if (UI_MODE === 'canvas') setTimeout(canvasSizeDialog, 400);
  /* El aviso de actualizacion, igual: el main lo alimenta con un estado de
   * mentira (--fake-update=) y aca se abre el dialogo que colgaria de el. */
  if (UI_MODE === 'update') setTimeout(() => q('sc-update').click(), 1100);
}

/* Trazos sinteticos con presion variable. Es la forma de verificar el motor sin
 * tablet: se corre con --ui-shot=ruta:demo y el PNG resultante muestra si los
 * pinceles, la presion y las capas hacen lo que deben. */
function runDemo({ puck: showPuck = false, selection: showSelection = false } = {}) {
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
      if (showSelection) {
        setTool('select');
        beginSelection({ x: doc.width * 0.16, y: doc.height * 0.16 });
        moveSelection({ x: doc.width * 0.72, y: doc.height * 0.60 });
        endSelection();
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
