/* Historial.
 *
 * La decision de diseno que importa: un trazo NO guarda el lienzo entero, guarda
 * solo el rectangulo que toco. Un garabato de 200x200 px en un documento de
 * 1920x1200 cuesta 160 KB en vez de 9 MB — un factor de 57. Eso es lo que hace
 * viable tener decenas de pasos de undo sin comerse la RAM.
 *
 * Cada entrada es un par de closures undo/redo mas su costo en bytes. El
 * historial no sabe que hay adentro: eso deja que un trazo, un borrado de capa y
 * un cambio de opacidad convivan en la misma pila sin casos especiales.
 *
 * El limite es de MEMORIA, no de cantidad de pasos. Contar pasos no dice nada:
 * cincuenta toques chiquitos ocupan menos que un solo relleno del lienzo. */

const BUDGET = 512 * 1024 * 1024;   // 512 MB de pixeles historicos
const MAX_STEPS = 120;              // techo duro, por si las entradas son diminutas

export class History {
  constructor({ onChange = null } = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.onChange = onChange;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get depth() { return this.undoStack.length; }

  push(entry) {
    this.undoStack.push(entry);
    this.bytes += entry.bytes || 0;
    /* Cualquier accion nueva invalida el redo: la linea de tiempo se bifurco y
     * quedarse con la rama vieja llevaria a estados imposibles. */
    if (this.redoStack.length) {
      for (const e of this.redoStack) this.bytes -= e.bytes || 0;
      this.redoStack.length = 0;
    }
    this.#evict();
    this.#changed();
  }

  #evict() {
    while ((this.bytes > BUDGET || this.undoStack.length > MAX_STEPS) && this.undoStack.length > 1) {
      const gone = this.undoStack.shift();
      this.bytes -= gone.bytes || 0;
      gone.dispose?.();
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.#changed();
    return e;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.#changed();
    return e;
  }

  clear() {
    for (const e of this.undoStack) e.dispose?.();
    for (const e of this.redoStack) e.dispose?.();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.bytes = 0;
    this.#changed();
  }

  #changed() { this.onChange?.(this); }
}

// ── constructores de entradas ───────────────────────────────────────────────

/* Entrada de pixeles: solo la region tocada.
 *
 * putImageData escribe los pixeles crudos, sin pasar por globalAlpha ni por el
 * modo de composicion. Eso es justo lo que hace falta para deshacer: se restaura
 * el estado exacto y no una mezcla con lo que hay debajo. */
export function pixelEntry(layer, rect, before, after, label = 'stroke') {
  const bytes = (before?.data?.length || 0) + (after?.data?.length || 0);
  return {
    kind: 'pixels', label, bytes,
    undo() {
      layer.ctx.putImageData(before, rect.x, rect.y);
      layer.rev++;
    },
    redo() {
      layer.ctx.putImageData(after, rect.x, rect.y);
      layer.rev++;
    },
  };
}

/* Captura la region de una capa. Devuelve null si el rect quedo vacio. */
export function grab(layer, rect) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  return layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
}

/* Copia completa de una capa, como canvas y no como ImageData: un canvas puede
 * quedarse en memoria de GPU y no paga la conversion a un array de bytes. Se usa
 * para operaciones que tocan toda la capa (merge, limpiar, pegar). */
export function snapshotCanvas(layer) {
  const c = document.createElement('canvas');
  c.width = layer.canvas.width;
  c.height = layer.canvas.height;
  c.getContext('2d').drawImage(layer.canvas, 0, 0);
  return c;
}

export function fullLayerEntry(layer, before, after, label = 'layer') {
  const bytes = (before.width * before.height + after.width * after.height) * 4;
  const restore = (src) => {
    const c = layer.ctx;
    c.save();
    c.globalCompositeOperation = 'copy';   // reemplaza, no mezcla
    c.globalAlpha = 1;
    c.drawImage(src, 0, 0);
    c.restore();
    layer.rev++;
  };
  return {
    kind: 'layer-pixels', label, bytes,
    undo: () => restore(before),
    redo: () => restore(after),
  };
}

/* Entrada estructural: agregar, borrar, reordenar, duplicar capas y cambios de
 * propiedades.
 *
 * Guarda las LISTAS de capas, no sus pixeles. Los objetos Layer siguen vivos
 * aunque salgan del documento, asi que restaurar es volver a poner la lista y
 * los canvas vuelven intactos y gratis. */
export function layersEntry(doc, before, after, label = 'layers') {
  const snap = (s) => {
    doc.layers = s.layers.slice();
    doc.activeIndex = Math.max(0, Math.min(s.activeIndex, doc.layers.length - 1));
    // las props se guardan aparte porque el mismo objeto Layer puede aparecer en
    // los dos estados con distinta opacidad o visibilidad
    for (const [layer, props] of s.props) Object.assign(layer, props);
    doc.invalidateBelow();
  };
  return {
    kind: 'layers', label,
    // las listas son punteros: el costo real de memoria son los canvas, que
    // existirian igual estando o no en el historial
    bytes: 0,
    undo: () => snap(before),
    redo: () => snap(after),
  };
}

/* Foto del estado estructural del documento, para pasar a layersEntry. */
export function docState(doc) {
  return {
    layers: doc.layers.slice(),
    activeIndex: doc.activeIndex,
    props: doc.layers.map((l) => [l, {
      opacity: l.opacity, visible: l.visible, blend: l.blend, name: l.name,
    }]),
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
