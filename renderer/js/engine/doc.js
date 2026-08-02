/* Documento y capas.
 *
 * Cada capa es su propio canvas del tamano del documento. La composicion se
 * hornea en un canvas 'flat' que es lo unico que el viewport dibuja.
 *
 * La parte que importa para que dibujar se sienta instantaneo son las dos
 * optimizaciones de abajo:
 *
 *   1. Cache 'below': la composicion de todas las capas DEBAJO de la activa se
 *      guarda horneada. Como el 99% de lo que hacemos es pintar en la capa
 *      activa, esas capas de abajo no cambian y no hay que recomponerlas nunca.
 *
 *   2. Recomposicion por region: al pintar solo se recompone el rectangulo que
 *      el trazo toco, no el lienzo entero. Con esto el costo de un trazo depende
 *      del trazo, no del tamano del documento.
 *
 * Las capas de ARRIBA de la activa no se cachean: se recorren en orden. No es
 * descuido — un blend mode ('multiply' y compania) tiene que aplicarse contra
 * todo lo acumulado debajo, y una cache aislada daria un resultado distinto.
 * Arriba de la activa suele haber pocas capas, asi que recorrerlas sale gratis. */

export const BLEND_MODES = [
  { id: 'source-over', name: 'Normal' },
  { id: 'multiply',    name: 'Multiply' },
  { id: 'screen',      name: 'Screen' },
  { id: 'overlay',     name: 'Overlay' },
  { id: 'darken',      name: 'Darken' },
  { id: 'lighten',     name: 'Lighten' },
  { id: 'color-dodge', name: 'Color Dodge' },
  { id: 'color-burn',  name: 'Color Burn' },
  { id: 'hard-light',  name: 'Hard Light' },
  { id: 'soft-light',  name: 'Soft Light' },
  { id: 'difference',  name: 'Difference' },
  { id: 'exclusion',   name: 'Exclusion' },
  { id: 'hue',         name: 'Hue' },
  { id: 'saturation',  name: 'Saturation' },
  { id: 'color',       name: 'Color' },
  { id: 'luminosity',  name: 'Luminosity' },
];

let nextId = 1;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Layer {
  constructor(w, h, name = 'Layer') {
    this.id = nextId++;
    this.name = name;
    this.canvas = makeCanvas(w, h);
    /* willReadFrequently: el historial saca ImageData de cada capa al cerrar un
     * trazo. Sin este flag Chromium mantiene la capa en GPU y cada getImageData
     * fuerza una lectura de vuelta que congela unos milisegundos. */
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.opacity = 1;
    this.visible = true;
    this.blend = 'source-over';
    // se sube cada vez que los pixeles cambian: las miniaturas lo usan para
    // saber si tienen que redibujarse
    this.rev = 0;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.rev++;
  }
}

export class ScrawlDoc {
  constructor(w = 1920, h = 1200) {
    this.width = w;
    this.height = h;

    this.layers = [];
    this.activeIndex = 0;

    // composicion final, lo unico que el viewport lee
    this.flat = makeCanvas(w, h);
    this.flatCtx = this.flat.getContext('2d', { willReadFrequently: true });

    // cache de las capas debajo de la activa
    this.below = makeCanvas(w, h);
    this.belowCtx = this.below.getContext('2d');
    this.belowDirty = true;

    // scratch para mezclar la capa activa con el trazo en curso
    this.scratch = makeCanvas(w, h);
    this.scratchCtx = this.scratch.getContext('2d');

    this.addLayer(0, 'Background');
  }

  get active() { return this.layers[this.activeIndex] || null; }

  get bounds() { return { x: 0, y: 0, w: this.width, h: this.height }; }

  // ── capas ─────────────────────────────────────────────────────────────────

  addLayer(at = this.activeIndex + 1, name = null) {
    const n = name || `Layer ${this.layers.length + 1}`;
    const layer = new Layer(this.width, this.height, n);
    this.layers.splice(Math.max(0, Math.min(at, this.layers.length)), 0, layer);
    this.activeIndex = this.layers.indexOf(layer);
    this.belowDirty = true;
    return layer;
  }

  insertLayer(layer, at) {
    this.layers.splice(Math.max(0, Math.min(at, this.layers.length)), 0, layer);
    this.belowDirty = true;
    return layer;
  }

  removeLayer(i) {
    if (this.layers.length <= 1) return null;
    const [gone] = this.layers.splice(i, 1);
    this.activeIndex = Math.min(this.activeIndex, this.layers.length - 1);
    this.belowDirty = true;
    return gone;
  }

  duplicateLayer(i) {
    const src = this.layers[i];
    const copy = new Layer(this.width, this.height, `${src.name} copy`);
    copy.ctx.drawImage(src.canvas, 0, 0);
    copy.opacity = src.opacity;
    copy.blend = src.blend;
    copy.visible = src.visible;
    this.layers.splice(i + 1, 0, copy);
    this.activeIndex = i + 1;
    this.belowDirty = true;
    return copy;
  }

  moveLayer(from, to) {
    if (from === to) return;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.activeIndex = this.layers.indexOf(l);
    this.belowDirty = true;
  }

  /* Aplasta la capa i sobre la i-1, respetando opacidad y blend de la de arriba.
   * Devuelve la capa que se fue, por si el historial la necesita para deshacer. */
  mergeDown(i) {
    if (i <= 0) return null;
    const top = this.layers[i];
    const bottom = this.layers[i - 1];
    const c = bottom.ctx;
    c.save();
    c.globalAlpha = top.opacity;
    c.globalCompositeOperation = top.blend;
    if (top.visible) c.drawImage(top.canvas, 0, 0);
    c.restore();
    bottom.rev++;
    const gone = this.removeLayer(i);
    this.activeIndex = i - 1;
    return gone;
  }

  setActive(i) {
    const clamped = Math.max(0, Math.min(i, this.layers.length - 1));
    if (clamped === this.activeIndex) return;
    this.activeIndex = clamped;
    // cambio el punto de corte, asi que la cache de abajo ya no sirve
    this.belowDirty = true;
  }

  // ── composicion ───────────────────────────────────────────────────────────

  /* Cualquier cambio que afecte a capas debajo de la activa (opacidad,
   * visibilidad, blend, orden) tiene que llamar a esto. */
  invalidateBelow() { this.belowDirty = true; }

  #rebuildBelow() {
    const c = this.belowCtx;
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.activeIndex; i++) {
      const l = this.layers[i];
      if (!l.visible || l.opacity <= 0) continue;
      c.globalAlpha = l.opacity;
      c.globalCompositeOperation = l.blend;
      c.drawImage(l.canvas, 0, 0);
    }
    c.restore();
    this.belowDirty = false;
  }

  #drawRegion(ctx, src, alpha, blend, r) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  /* Rehornea 'flat'. Con rect, solo esa region (lo que usa el trazo en vivo).
   *
   * wet es el trazo en curso: vive en su propio canvas y recien se aplica a la
   * capa al soltar el stylus. Se compone aca sobre una copia scratch de la capa
   * activa, asi el trazo se ve con su opacidad final sin que los solapamientos
   * del propio trazo se acumulen. */
  recompose(rect = null, wet = null) {
    if (this.belowDirty) this.#rebuildBelow();

    const r = clampRect(rect || this.bounds, this.width, this.height);
    if (r.w <= 0 || r.h <= 0) return;

    const f = this.flatCtx;
    f.save();
    f.globalCompositeOperation = 'source-over';
    f.globalAlpha = 1;
    f.clearRect(r.x, r.y, r.w, r.h);
    f.drawImage(this.below, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);

    const act = this.active;
    if (act && act.visible && act.opacity > 0) {
      if (wet && wet.canvas) {
        const s = this.scratchCtx;
        s.save();
        s.globalCompositeOperation = 'source-over';
        s.globalAlpha = 1;
        s.clearRect(r.x, r.y, r.w, r.h);
        s.drawImage(act.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        s.globalAlpha = wet.alpha ?? 1;
        s.globalCompositeOperation = wet.mode || 'source-over';
        s.drawImage(wet.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        s.restore();
        this.#drawRegion(f, this.scratch, act.opacity, act.blend, r);
      } else {
        this.#drawRegion(f, act.canvas, act.opacity, act.blend, r);
      }
    }

    for (let i = this.activeIndex + 1; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l.visible) continue;
      this.#drawRegion(f, l.canvas, l.opacity, l.blend, r);
    }

    f.restore();
  }

  /* Composicion limpia sobre un canvas nuevo, sin cache ni region: es lo que se
   * exporta a PNG. Con flatten=false respeta la transparencia. */
  render(background = null) {
    const out = makeCanvas(this.width, this.height);
    const c = out.getContext('2d');
    if (background) {
      c.fillStyle = background;
      c.fillRect(0, 0, this.width, this.height);
    }
    for (const l of this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      c.globalAlpha = l.opacity;
      c.globalCompositeOperation = l.blend;
      c.drawImage(l.canvas, 0, 0);
    }
    return out;
  }

  // ── redimensionado ────────────────────────────────────────────────────────

  /* Cambia el tamano del lienzo conservando el contenido. Usado al pegar o abrir
   * una imagen mas grande que el documento actual. */
  resize(w, h, mode = 'keep') {
    const old = { w: this.width, h: this.height };
    this.width = w;
    this.height = h;

    let dx = 0, dy = 0;
    if (mode === 'center') {
      dx = Math.round((w - old.w) / 2);
      dy = Math.round((h - old.h) / 2);
    }

    for (const l of this.layers) {
      const prev = l.canvas;
      l.canvas = makeCanvas(w, h);
      l.ctx = l.canvas.getContext('2d', { willReadFrequently: true });
      l.ctx.drawImage(prev, dx, dy);
      l.rev++;
    }

    this.flat = makeCanvas(w, h);
    this.flatCtx = this.flat.getContext('2d', { willReadFrequently: true });
    this.below = makeCanvas(w, h);
    this.belowCtx = this.below.getContext('2d');
    this.scratch = makeCanvas(w, h);
    this.scratchCtx = this.scratch.getContext('2d');
    this.belowDirty = true;
  }

  // ── serializacion ─────────────────────────────────────────────────────────

  toJSON() {
    return {
      format: 'scrawl',
      version: 1,
      width: this.width,
      height: this.height,
      activeIndex: this.activeIndex,
      layers: this.layers.map((l) => ({
        name: l.name,
        opacity: l.opacity,
        visible: l.visible,
        blend: l.blend,
        // dataURL en vez de un blob aparte: un .scrawl es un solo archivo de
        // texto, facil de inspeccionar y de versionar
        data: l.canvas.toDataURL('image/png'),
      })),
    };
  }

  static async fromJSON(obj) {
    const doc = new ScrawlDoc(obj.width, obj.height);
    doc.layers = [];
    for (const raw of obj.layers) {
      const l = new Layer(obj.width, obj.height, raw.name);
      l.opacity = raw.opacity ?? 1;
      l.visible = raw.visible ?? true;
      l.blend = raw.blend || 'source-over';
      if (raw.data) {
        const img = await loadImage(raw.data);
        l.ctx.drawImage(img, 0, 0);
      }
      doc.layers.push(l);
    }
    if (!doc.layers.length) doc.addLayer(0, 'Background');
    doc.activeIndex = Math.min(obj.activeIndex ?? 0, doc.layers.length - 1);
    doc.belowDirty = true;
    doc.recompose();
    return doc;
  }
}

// ── utilidades ──────────────────────────────────────────────────────────────

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('no se pudo cargar la imagen'));
    img.src = src;
  });
}

/* Recorta un rect a los limites del documento y lo lleva a enteros hacia
 * afuera. Los enteros importan: un drawImage con coordenadas fraccionarias
 * interpola y deja una costura visible en el borde de la region recompuesta. */
export function clampRect(r, w, h) {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/* Dibuja una capa escalada dentro de un canvas de miniatura, con 'contain'. */
export function drawThumb(canvas, layer, docW, docH) {
  const c = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  c.clearRect(0, 0, cw, ch);
  const s = Math.min(cw / docW, ch / docH);
  const w = docW * s, h = docH * s;
  c.drawImage(layer.canvas, (cw - w) / 2, (ch - h) / 2, w, h);
}
