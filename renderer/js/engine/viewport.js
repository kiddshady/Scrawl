/* Viewport: la ventana por la que se mira el documento.
 *
 * Mantiene escala y desplazamiento, traduce entre coordenadas de pantalla y de
 * documento, y pinta el canvas de presentacion. Es la unica parte que sabe de
 * pixeles de pantalla; el resto del motor trabaja siempre en coordenadas de
 * documento. */

// pasos de zoom de los botones: multiplicativos, porque el zoom se percibe en
// proporcion, no en incrementos fijos
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 32;

export class Viewport {
  constructor(canvas, doc) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.doc = doc;

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;

    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 0;
    this.cssH = 0;

    // cursor del pincel: se dibuja como anillo en la posicion del puntero
    this.cursor = null;   // { x, y, r } en coordenadas de pantalla (css px)

    this.#buildChecker();
  }

  /* Damero de transparencia. Se dibuja en espacio de PANTALLA, no de documento:
   * asi los cuadros conservan su tamano al hacer zoom, que es lo que uno espera
   * (si escalaran, a 800% cada cuadro seria una pared gris). */
  #buildChecker() {
    const s = 8;
    const c = document.createElement('canvas');
    c.width = s * 2;
    c.height = s * 2;
    const x = c.getContext('2d');
    x.fillStyle = '#1a1a1a';
    x.fillRect(0, 0, s * 2, s * 2);
    x.fillStyle = '#222222';
    x.fillRect(0, 0, s, s);
    x.fillRect(s, s, s, s);
    this.checker = this.ctx.createPattern(c, 'repeat');
  }

  // ── medidas ───────────────────────────────────────────────────────────────

  /* Ajusta el buffer del canvas al tamano CSS por el device pixel ratio. Sin
   * esto el lienzo se ve borroso en pantallas con escalado de Windows. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ── coordenadas ───────────────────────────────────────────────────────────

  /* Pantalla (css px relativos al canvas) -> documento. */
  toDoc(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  /* Documento -> pantalla. */
  toScreen(dx, dy) {
    return { x: dx * this.scale + this.tx, y: dy * this.scale + this.ty };
  }

  /* Rect del documento en pixeles de pantalla. */
  get docRect() {
    return {
      x: this.tx,
      y: this.ty,
      w: this.doc.width * this.scale,
      h: this.doc.height * this.scale,
    };
  }

  // ── navegacion ────────────────────────────────────────────────────────────

  fit(margin = 0.94) {
    const s = Math.min(this.cssW / this.doc.width, this.cssH / this.doc.height) * margin;
    this.scale = clamp(s, ZOOM_MIN, ZOOM_MAX);
    this.center();
  }

  center() {
    this.tx = (this.cssW - this.doc.width * this.scale) / 2;
    this.ty = (this.cssH - this.doc.height * this.scale) / 2;
  }

  /* Zoom manteniendo fijo el punto del documento que esta bajo (ax, ay). Es lo
   * que hace que el zoom con la rueda se sienta natural: el pixel que estas
   * mirando no se te escapa. */
  zoomTo(scale, ax = this.cssW / 2, ay = this.cssH / 2) {
    const next = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    if (next === this.scale) return;
    const before = this.toDoc(ax, ay);
    this.scale = next;
    this.tx = ax - before.x * this.scale;
    this.ty = ay - before.y * this.scale;
  }

  zoomBy(factor, ax, ay) { this.zoomTo(this.scale * factor, ax, ay); }
  zoomIn(ax, ay)  { this.zoomBy(ZOOM_STEP, ax, ay); }
  zoomOut(ax, ay) { this.zoomBy(1 / ZOOM_STEP, ax, ay); }

  pan(dx, dy) { this.tx += dx; this.ty += dy; }

  // ── dibujado ──────────────────────────────────────────────────────────────

  draw() {
    const c = this.ctx;
    // trabajar en css px y dejar que el transform maneje el dpr mantiene toda la
    // aritmetica de coordenadas en una sola unidad
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cssW, this.cssH);

    const r = this.docRect;

    // El lienzo FLOTA sobre el vacio: sombra suave para separar los planos, no
    // un borde marcado.
    c.save();
    c.shadowColor = 'rgba(0,0,0,.6)';
    c.shadowBlur = 26;
    c.shadowOffsetY = 6;
    c.fillStyle = '#0d0d0d';
    c.fillRect(r.x, r.y, r.w, r.h);
    c.restore();

    // damero, recortado al lienzo
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.fillStyle = this.checker;
    c.fillRect(r.x, r.y, r.w, r.h);
    c.restore();

    /* Con mucho zoom el suavizado convierte los pixeles en un borron; apagarlo
     * los muestra nitidos, que es lo que uno quiere cuando se acerca a mirar el
     * detalle. Al alejar, en cambio, el suavizado evita el aliasing. */
    c.imageSmoothingEnabled = this.scale < 2.5;
    c.imageSmoothingQuality = 'high';
    c.drawImage(this.doc.flat, r.x, r.y, r.w, r.h);
    c.imageSmoothingEnabled = true;

    // hairline del borde del lienzo: define el limite sin competir
    c.strokeStyle = 'rgba(255,255,255,.09)';
    c.lineWidth = 1;
    c.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);

    if (this.cursor) this.#drawCursor();
  }

  /* Anillo del tamano real del pincel. Doble trazo (oscuro afuera, claro
   * adentro) para que se vea sobre negro y sobre blanco por igual — un anillo de
   * un solo color desaparece contra la mitad de los fondos. */
  #drawCursor() {
    const { x, y, r } = this.cursor;
    const c = this.ctx;
    // por debajo de este radio el anillo tapa mas de lo que ayuda; se pasa a cruz
    if (r < 2.5) {
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,.7)';
      cross(c, x, y, 5.5);
      c.strokeStyle = 'rgba(255,255,255,.9)';
      cross(c, x, y, 4.5);
      return;
    }
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.beginPath();
    c.arc(x, y, r + 1, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.85)';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
  }
}

function cross(c, x, y, s) {
  c.beginPath();
  c.moveTo(x - s, y); c.lineTo(x + s, y);
  c.moveTo(x, y - s); c.lineTo(x, y + s);
  c.stroke();
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
