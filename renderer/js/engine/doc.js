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
  constructor(w = 1920, h = 1200, dpi = 96) {
    this.width = w;
    this.height = h;

    /* Pixeles por pulgada del documento. No cambia un solo pixel de lo que se
     * dibuja: es la escala con la que esos pixeles se miden al salir a papel, y
     * lo que hace que el PDF exportado tenga el tamano fisico correcto. 96 es la
     * densidad con la que Windows y el navegador miden todo, asi que es el
     * default de un lienzo que no se penso para imprimir. */
    this.dpi = dpi;

    /* Papel al que corresponde el lienzo — { id, orientation } — o null si es una
     * medida libre. Se guarda en vez de deducirse porque es una INTENCION: dice
     * "este documento es una A4", y de ahi sale que pegar una captura ya no
     * agrande el lienzo. Deducirlo de los pixeles daria el mismo nombre pero no
     * distinguiria un A4 elegido de un lienzo que por casualidad mide lo mismo. */
    this.paper = null;

    this.layers = [];
    this.activeIndex = 0;

    this.#buildBuffers();

    this.addLayer(0, 'Background');
  }

  /* Los tres canvas de trabajo, al tamano actual. Se rearman enteros en vez de
   * redimensionarse porque cambiarle el width a un canvas ya lo borra: no hay
   * nada que conservar en ninguno de los tres, todos son cache. */
  #buildBuffers() {
    // composicion final, lo unico que el viewport lee
    this.flat = makeCanvas(this.width, this.height);
    this.flatCtx = this.flat.getContext('2d', { willReadFrequently: true });

    // cache de las capas debajo de la activa
    this.below = makeCanvas(this.width, this.height);
    this.belowCtx = this.below.getContext('2d');

    // scratch para mezclar la capa activa con el trazo en curso
    this.scratch = makeCanvas(this.width, this.height);
    this.scratchCtx = this.scratch.getContext('2d');

    this.belowDirty = true;
  }

  /* Version publica: la usa el historial, que restaura los canvas de las capas
   * por su cuenta y despues necesita que los buffers acompanen al tamano. */
  rebuildBuffers() { this.#buildBuffers(); }

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

  /* Cambia el tamano del lienzo conservando el contenido. Lo usan tanto pegar
   * una imagen mas grande que el documento como el dialogo de tamano del lienzo.
   *
   *   anchor  donde queda el contenido viejo dentro del nuevo lienzo. Los nueve
   *           puntos cardinales; 'keep' y 'center' son los alias historicos de
   *           'nw' y 'c'. Solo importa cuando el lienzo cambia de medida: es lo
   *           que decide que borde crece y cual se recorta.
   *   scale   con true el contenido se estira o se achica para entrar entero en
   *           el lienzo nuevo, en vez de recortarse. Conserva la proporcion, asi
   *           que lo que sobra del otro lado lo reparte el anchor.
   *
   * Los pixeles que quedan afuera se PIERDEN aca: este metodo no guarda nada.
   * Quien lo llama es responsable de anotar el paso en el historial si quiere
   * poder volver — canvasEntry() en history.js hace justo eso, y sin copiar un
   * solo pixel, porque los canvas viejos que esto descarta siguen sirviendo. */
  resize(w, h, anchor = 'keep', scale = false) {
    if (w === this.width && h === this.height) return;

    const old = { w: this.width, h: this.height };
    this.width = w;
    this.height = h;

    // cuanto mide el contenido ya colocado: el lienzo viejo, escalado o no
    const k = scale ? Math.min(w / old.w, h / old.h) : 1;
    const cw = old.w * k;
    const ch = old.h * k;

    const [ax, ay] = anchorAt(anchor);
    const dx = Math.round((w - cw) * ax);
    const dy = Math.round((h - ch) * ay);

    for (const l of this.layers) {
      const prev = l.canvas;
      l.canvas = makeCanvas(w, h);
      l.ctx = l.canvas.getContext('2d', { willReadFrequently: true });
      if (scale) {
        // al achicar, el remuestreo barato deja escalones; esto es una sola
        // operacion por capa y por redimensionado, asi que la calidad sale gratis
        l.ctx.imageSmoothingEnabled = true;
        l.ctx.imageSmoothingQuality = 'high';
        l.ctx.drawImage(prev, dx, dy, Math.round(cw), Math.round(ch));
      } else {
        l.ctx.drawImage(prev, dx, dy);
      }
      l.rev++;
    }

    this.#buildBuffers();
  }

  // ── serializacion ─────────────────────────────────────────────────────────

  toJSON() {
    return {
      format: 'scrawl',
      version: 1,
      width: this.width,
      height: this.height,
      /* Campos opcionales: un .scrawl viejo no los trae y se abre igual, con los
       * 96 DPI de pantalla. Por eso no suben la version del formato — no hay
       * nada que un lector viejo pueda leer mal, solo algo que no va a mirar. */
      dpi: this.dpi,
      paper: this.paper,
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
    const doc = new ScrawlDoc(obj.width, obj.height, obj.dpi ?? 96);
    doc.paper = obj.paper ?? null;
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

/* Los nueve anclajes, como fraccion del espacio sobrante que va antes del
 * contenido. 'c' reparte mitad y mitad; 'nw' no deja nada antes y todo despues.
 * La misma cuenta sirve para crecer y para recortar: cuando el lienzo se achica
 * el sobrante es negativo y la fraccion decide que borde se come. */
const ANCHORS = {
  nw: [0, 0],   n: [0.5, 0],   ne: [1, 0],
  w:  [0, 0.5], c: [0.5, 0.5], e:  [1, 0.5],
  sw: [0, 1],   s: [0.5, 1],   se: [1, 1],
};

export function anchorAt(anchor) {
  if (anchor === 'keep') return ANCHORS.nw;
  if (anchor === 'center') return ANCHORS.c;
  return ANCHORS[anchor] || ANCHORS.nw;
}

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

/* Rectangulo que ocupa lo pintado en una capa — el bounding box de sus pixeles
 * con alfa — o null si esta vacia.
 *
 * Es lo que hace que copiar una capa mande solo el dibujo y no la hoja entera:
 * un garabato de 300x200 en una A4 viaja como 300x200, y la caja con la que
 * despues se acomoda abraza el trazo en vez de medir todo el lienzo.
 *
 * Se recorre por filas desde arriba y desde abajo, y despues por columnas solo
 * dentro de esas filas: sobre un lienzo de 2480x3508 son ocho millones de
 * pixeles y mirar cada uno cuatro veces se nota. El alfa se lee como el byte
 * alto de un Uint32, que en little-endian es donde queda. */
export function layerBounds(layer) {
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const px = new Uint32Array(layer.ctx.getImageData(0, 0, w, h).data.buffer);

  const rowHas = (y) => {
    const end = (y + 1) * w;
    for (let i = y * w; i < end; i++) if (px[i] & 0xff000000) return true;
    return false;
  };

  let top = 0;
  while (top < h && !rowHas(top)) top++;
  if (top === h) return null;
  let bottom = h - 1;
  while (bottom > top && !rowHas(bottom)) bottom--;

  const colHas = (x) => {
    for (let y = top; y <= bottom; y++) if (px[y * w + x] & 0xff000000) return true;
    return false;
  };
  let left = 0;
  while (left < w && !colHas(left)) left++;
  let right = w - 1;
  while (right > left && !colHas(right)) right--;

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
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
