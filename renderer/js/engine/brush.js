/* Pinceles y rasterizado del trazo.
 *
 * ── La capa "wet" ─────────────────────────────────────────────────────────
 * El trazo en curso NO se pinta sobre la capa: se pinta en un canvas aparte
 * (el wet) y recien al soltar el stylus se compone sobre la capa con la
 * opacidad del pincel. Esto no es un detalle de implementacion, es la
 * diferencia entre un trazo que se ve bien y uno que se ve mal: si pintaras
 * directo con opacidad 40%, cada vez que el trazo se cruza consigo mismo (una
 * curva cerrada, un garabato) esa zona quedaria al 64% y verias manchas oscuras
 * en cada cruce. Con el wet, el trazo entero recibe su opacidad UNA vez.
 *
 * ── Los tres caracteres ───────────────────────────────────────────────────
 * 'hard'  — lapiz, marcador, linea. Se rasteriza como una banda de ancho
 *           variable: un solo path por segmento (los dos circulos de las puntas
 *           mas el trapecio que los une) y un solo fill. Un solo fill importa:
 *           si dibujaras el circulo y el trapecio por separado, el antialiasing
 *           de sus bordes internos se sumaria y dejaria costuras visibles a lo
 *           largo del trazo.
 * 'soft'  — pincel. Se estampa una punta con degradado radial a lo largo del
 *           camino. La punta se pre-renderiza una sola vez y se reusa escalada;
 *           generar un createRadialGradient por estampa (cientos por trazo)
 *           tiraria los fps al piso.
 * 'spray' — aerografo. Igual que soft pero con la punta mucho mas difusa, flow
 *           bajo y dispersion, asi que acumula pigmento en vez de cubrir. */

export const BRUSH_KIND = { HARD: 'hard', SOFT: 'soft', SPRAY: 'spray' };

/* Cada preset declara que controles muestra el panel: asi la UI se arma sola a
 * partir del pincel y no hay que tocarla al agregar uno nuevo. */
export const BRUSHES = {
  brush: {
    id: 'brush', name: 'Paintbrush', kind: BRUSH_KIND.SOFT,
    size: 26, opacity: 1, flow: 0.5, hardness: 0.4,
    spacing: 0.055, minSize: 0.1, jitter: 0,
    sizePressure: 1, flowPressure: 0.55, smoothing: 0.45,
    blend: 'source-over',
    /* 'fields' son los controles que uno toca todo el tiempo y viven siempre a
     * la vista; 'dynamics' son los que se calibran una vez por pincel y se
     * esconden en una seccion plegable. Sin esa separacion el panel del pincel
     * crece tanto que se come el panel de capas. */
    fields: ['size', 'opacity', 'flow', 'hardness'],
    dynamics: ['sizePressure', 'flowPressure', 'smoothing'],
  },
  pencil: {
    id: 'pencil', name: 'Pencil', kind: BRUSH_KIND.HARD,
    size: 4, opacity: 1, flow: 1, hardness: 1,
    spacing: 0.12, minSize: 0.35, jitter: 0,
    sizePressure: 0.7, flowPressure: 0.35, smoothing: 0.3,
    blend: 'source-over',
    fields: ['size', 'opacity'],
    dynamics: ['sizePressure', 'flowPressure', 'smoothing'],
  },
  marker: {
    id: 'marker', name: 'Marker', kind: BRUSH_KIND.HARD,
    size: 22, opacity: 0.45, flow: 1, hardness: 1,
    spacing: 0.1, minSize: 0.85, jitter: 0,
    // un marcador da el mismo ancho apretando fuerte o flojo: la punta es de
    // fieltro rigido, no cede. de ahi que la presion casi no lo afecte.
    sizePressure: 0.15, flowPressure: 0, smoothing: 0.4,
    // multiply es lo que hace que dos pasadas se oscurezcan como un resaltador
    // de verdad, en vez de quedar planas
    blend: 'multiply',
    fields: ['size', 'opacity'],
    dynamics: ['sizePressure', 'smoothing'],
  },
  airbrush: {
    id: 'airbrush', name: 'Airbrush', kind: BRUSH_KIND.SPRAY,
    size: 60, opacity: 1, flow: 0.1, hardness: 0,
    spacing: 0.035, minSize: 0.55, jitter: 0.18,
    sizePressure: 0.35, flowPressure: 0.85, smoothing: 0.5,
    blend: 'source-over',
    fields: ['size', 'opacity', 'flow', 'jitter'],
    dynamics: ['sizePressure', 'flowPressure', 'smoothing'],
  },
  eraser: {
    id: 'eraser', name: 'Eraser', kind: BRUSH_KIND.SOFT,
    size: 36, opacity: 1, flow: 1, hardness: 0.85,
    spacing: 0.06, minSize: 0.3, jitter: 0,
    sizePressure: 0.6, flowPressure: 0.3, smoothing: 0.35,
    blend: 'source-over',
    erase: true,
    fields: ['size', 'opacity', 'hardness'],
    dynamics: ['sizePressure', 'smoothing'],
  },
};

/* Rangos y formato de cada control. Vive aca y no en la UI porque es una
 * propiedad del parametro, no de como se dibuja el slider. */
export const FIELD_SPEC = {
  size:         { label: 'Size',           min: 1,  max: 400, step: 1,    fmt: (v) => `${Math.round(v)} px`, curve: 2 },
  opacity:      { label: 'Opacity',        min: 0,  max: 1,   step: .01,  fmt: pct },
  flow:         { label: 'Flow',           min: .01, max: 1,  step: .01,  fmt: pct },
  hardness:     { label: 'Hardness',       min: 0,  max: 1,   step: .01,  fmt: pct },
  jitter:       { label: 'Scatter',        min: 0,  max: 1,   step: .01,  fmt: pct },
  sizePressure: { label: 'Pressure → size', min: 0, max: 1,   step: .01,  fmt: pct },
  flowPressure: { label: 'Pressure → flow', min: 0, max: 1,   step: .01,  fmt: pct },
  smoothing:    { label: 'Smoothing',      min: 0,  max: .9,  step: .01,  fmt: pct },
  tolerance:    { label: 'Tolerance',      min: 0,  max: 1,   step: .01,  fmt: pct, curve: 1.6 },
};

/* Ajustes de las herramientas que no son pinceles. Comparten la forma de un
 * preset (name + fields) para que el mismo panel las sepa dibujar sin casos
 * especiales, pero no tienen 'kind': eso es lo que las distingue de algo que
 * pinta trazos. */
export const TOOL_SETTINGS = {
  fill: { id: 'fill', name: 'Flood Fill', tolerance: 0.18, fields: ['tolerance'] },
};

function pct(v) { return `${Math.round(v * 100)}%`; }

export function makeBrush(id) { return { ...BRUSHES[id] }; }

// ── punta pre-renderizada ───────────────────────────────────────────────────

/* La punta se cachea por (color, dureza, tipo). Se re-genera solo cuando alguno
 * cambia, no en cada estampa. */
class Tip {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.key = null;
    this.R = 96;   // resolucion canonica: se dibuja escalada a cualquier radio
  }

  get(color, hardness, kind) {
    const key = `${color}|${hardness.toFixed(3)}|${kind}`;
    if (key === this.key) return this.canvas;

    const R = this.R;
    this.canvas.width = R * 2;
    this.canvas.height = R * 2;
    const c = this.canvas.getContext('2d');
    c.clearRect(0, 0, R * 2, R * 2);

    const { r, g, b } = parseHex(color);
    const grad = c.createRadialGradient(R, R, 0, R, R, R);

    /* El nucleo opaco llega hasta 'hardness' del radio y desde ahi cae a cero.
     * El falloff es cuadratico y no lineal porque una rampa lineal de alpha se
     * percibe como un anillo gris con borde: el ojo detecta la derivada, no el
     * valor. Con exponente 2 la caida se siente como pintura de verdad. */
    const core = kind === BRUSH_KIND.SPRAY ? 0 : Math.min(hardness, 0.97);
    const STEPS = 14;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const stop = core + (1 - core) * t;
      const a = Math.pow(1 - t, kind === BRUSH_KIND.SPRAY ? 2.6 : 2);
      grad.addColorStop(Math.min(1, stop), `rgba(${r},${g},${b},${a})`);
    }

    c.fillStyle = grad;
    c.beginPath();
    c.arc(R, R, R, 0, Math.PI * 2);
    c.fill();

    this.key = key;
    return this.canvas;
  }
}

// ── el pintor ───────────────────────────────────────────────────────────────

export class Painter {
  constructor(doc) {
    this.doc = doc;
    this.wet = document.createElement('canvas');
    this.wet.width = doc.width;
    this.wet.height = doc.height;
    this.ctx = this.wet.getContext('2d');
    this.tip = new Tip();

    this.active = false;
    this.brush = null;
    this.color = '#ffffff';
    this.dirty = null;       // bbox de todo el trazo (lo que el historial guarda)
    /* bbox de lo pintado desde el ultimo frame. Existe separado de 'dirty' por
     * una razon concreta: el bbox de un trazo largo crece hasta abarcar media
     * pantalla, y recomponer ESE rectangulo en cada frame haria que dibujar se
     * volviera mas lento cuanto mas largo el trazo. Recomponiendo solo el tramo
     * nuevo, el costo por frame es constante. */
    this.frameDirty = null;
    this.leftover = 0;       // resto de distancia para que el spacing no se corte
    this.last = null;        // ultimo punto estampado
    // semilla propia para la dispersion del aerografo: reproducible, asi un
    // mismo trazo re-renderizado da el mismo resultado
    this.seed = 1;
  }

  /* El wet vive al tamano del documento, asi que hay que seguirlo si el lienzo
   * cambia de tamano. */
  syncSize() {
    if (this.wet.width === this.doc.width && this.wet.height === this.doc.height) return;
    this.wet.width = this.doc.width;
    this.wet.height = this.doc.height;
  }

  get erasing() { return !!(this.brush && this.brush.erase); }

  /* Como se compone el wet, tanto en el preview en vivo como en el commit
   * final. Que sea UNA sola fuente de verdad es lo que garantiza que el trazo se
   * vea igual mientras lo dibujas y despues de soltarlo. */
  get wetLayer() {
    if (!this.brush) return null;
    return {
      canvas: this.wet,
      alpha: this.brush.opacity,
      mode: this.brush.erase ? 'destination-out' : this.brush.blend,
    };
  }

  begin(brush, color) {
    this.syncSize();
    this.brush = brush;
    this.color = color;
    this.active = true;
    this.dirty = null;
    this.leftover = 0;
    this.last = null;
    this.seed = 1;
    this.frameDirty = null;
    this.ctx.clearRect(0, 0, this.wet.width, this.wet.height);
  }

  /* Radio en pixeles de documento para una presion dada. */
  radiusAt(p) {
    const b = this.brush;
    const k = 1 - b.sizePressure * (1 - p);          // sizePressure=0 -> siempre 1
    return Math.max(0.35, (b.size / 2) * Math.max(b.minSize, k));
  }

  flowAt(p) {
    const b = this.brush;
    return b.flow * (1 - b.flowPressure * (1 - p));
  }

  /* Estampa el segmento a->b. Los puntos ya vienen suavizados y en coordenadas
   * de documento; aca solo se rasteriza. */
  segment(a, b) {
    if (!this.active) return;
    if (this.brush.kind === BRUSH_KIND.HARD) this.#hardBand(a, b);
    else this.#stampAlong(a, b);
    this.last = b;
  }

  /* Un punto solo (un toque sin arrastre) tiene que dejar marca igual. */
  dot(p) {
    if (!this.active) return;
    if (this.brush.kind === BRUSH_KIND.HARD) this.#hardBand(p, p);
    else this.#stamp(p.x, p.y, this.radiusAt(p.p), this.flowAt(p.p));
  }

  // ── rasterizado: banda de ancho variable ────────────────────────────────
  #hardBand(a, b) {
    const c = this.ctx;
    const r0 = this.radiusAt(a.p);
    const r1 = this.radiusAt(b.p);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);

    c.save();
    c.fillStyle = this.color;
    /* flow multiplica dentro del wet; con flow=1 (el default de lapiz y
     * marcador) es alpha 1 y no hay acumulacion posible entre estampas */
    c.globalAlpha = Math.min(1, this.flowAt(b.p));
    c.beginPath();

    if (len < 0.01) {
      c.arc(a.x, a.y, r1, 0, Math.PI * 2);
    } else {
      // normal unitaria al segmento: los cuatro vertices del trapecio salen de
      // desplazar cada punta por su propio radio
      const nx = -dy / len, ny = dx / len;
      c.moveTo(a.x + nx * r0, a.y + ny * r0);
      c.lineTo(b.x + nx * r1, b.y + ny * r1);
      c.lineTo(b.x - nx * r1, b.y - ny * r1);
      c.lineTo(a.x - nx * r0, a.y - ny * r0);
      c.closePath();
      // las puntas redondas, en el MISMO path: un solo fill = una sola cobertura
      c.moveTo(a.x + r0, a.y);
      c.arc(a.x, a.y, r0, 0, Math.PI * 2);
      c.moveTo(b.x + r1, b.y);
      c.arc(b.x, b.y, r1, 0, Math.PI * 2);
    }

    c.fill();
    c.restore();

    this.#grow(Math.min(a.x - r0, b.x - r1), Math.min(a.y - r0, b.y - r1),
               Math.max(a.x + r0, b.x + r1), Math.max(a.y + r0, b.y + r1));
  }

  // ── rasterizado: estampado a lo largo del camino ────────────────────────
  #stampAlong(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { this.dot(b); return; }

    const rMid = (this.radiusAt(a.p) + this.radiusAt(b.p)) / 2;
    /* El paso es proporcional al diametro: un pincel grande no necesita estampar
     * cada pixel. El minimo de 0.5px evita que un pincel de 1px genere miles de
     * estampas en el mismo lugar. */
    const step = Math.max(0.5, rMid * 2 * this.brush.spacing);

    // 'leftover' arrastra el resto del segmento anterior: sin eso, cada segmento
    // arrancaria una estampa nueva en su origen y se acumularian grumos en cada
    // union de segmentos
    let d = this.leftover;
    while (d <= len) {
      const t = d / len;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const p = a.p + (b.p - a.p) * t;
      let sx = x, sy = y;
      if (this.brush.jitter > 0) {
        const jr = this.radiusAt(p) * this.brush.jitter;
        sx += (this.#rand() * 2 - 1) * jr;
        sy += (this.#rand() * 2 - 1) * jr;
      }
      this.#stamp(sx, sy, this.radiusAt(p), this.flowAt(p));
      d += step;
    }
    this.leftover = d - len;
  }

  #stamp(x, y, r, alpha) {
    if (r <= 0 || alpha <= 0) return;
    const c = this.ctx;
    const img = this.tip.get(this.color, this.brush.hardness, this.brush.kind);
    c.globalAlpha = Math.min(1, alpha);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(img, x - r, y - r, r * 2, r * 2);
    this.#grow(x - r, y - r, x + r, y + r);
  }

  // generador congruencial propio: barato y determinista
  #rand() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  #grow(x0, y0, x1, y1) {
    // 2px de margen para no recortar el antialiasing del borde
    const r = { x: x0 - 2, y: y0 - 2, w: (x1 - x0) + 4, h: (y1 - y0) + 4 };
    this.dirty = grown(this.dirty, r);
    this.frameDirty = grown(this.frameDirty, r);
  }

  /* Devuelve lo pintado desde la ultima llamada y reinicia el acumulador. */
  takeFrameDirty() {
    const r = this.frameDirty;
    this.frameDirty = null;
    return r;
  }

  /* Borra el trazo en curso sin cerrarlo. Lo usa la herramienta de linea recta,
   * que redibuja su trazo entero en cada movimiento del puntero. */
  clearWet() {
    this.ctx.clearRect(0, 0, this.wet.width, this.wet.height);
    const had = this.dirty;
    this.dirty = null;
    this.frameDirty = null;
    this.leftover = 0;
    return had;
  }

  /* Vuelca el wet sobre una capa. Devuelve el rect tocado, que es lo que el
   * historial usa para guardar solo esa region. */
  commit(layer) {
    const r = this.dirty;
    if (!r || r.w <= 0 || r.h <= 0) { this.active = false; return null; }
    const wl = this.wetLayer;
    const c = layer.ctx;
    c.save();
    c.globalAlpha = wl.alpha;
    c.globalCompositeOperation = wl.mode;
    c.drawImage(this.wet, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    c.restore();
    layer.rev++;
    this.active = false;
    return r;
  }

  cancel() {
    this.active = false;
    this.dirty = null;
  }
}

// ── color ───────────────────────────────────────────────────────────────────

export function parseHex(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* Union de dos rects, devolviendo siempre un objeto nuevo. Que sea nuevo importa:
 * 'dirty' y 'frameDirty' crecen con los mismos rects y si compartieran objeto,
 * reiniciar uno vaciaria el otro. */
function grown(a, b) {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function toHex(r, g, b) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
