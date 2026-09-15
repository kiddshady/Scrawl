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

/* Tiradores de la imagen que se esta colocando. Miden lo mismo en pantalla a
 * cualquier zoom: son controles del puntero, no parte del dibujo. Si escalaran
 * con el documento, al 20% serian invisibles y al 800% cubririan la imagen. El
 * area de agarre es mas grande que lo pintado — con lapiz uno apunta al cuadrado
 * que ve y le erra por dos o tres pixeles. */
const HANDLE = 11;
const HANDLE_HIT = 20;

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

    /* Imagen flotando sobre el lienzo mientras se la acomoda, o null, que es lo
     * normal. Es { img, x, y, w, h, handle, active } en coordenadas de
     * DOCUMENTO: el viewport la pinta y resuelve su geometria en pantalla, pero
     * quien la mueve es app.js. */
    this.placement = null;

    /* Rectangulo elegido con la herramienta de seleccion, en coordenadas de
     * DOCUMENTO. Es un overlay: nunca entra en doc.flat ni en una exportacion. */
    this.selection = null;

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

  /* Rect de la imagen que se esta colocando, en pixeles de pantalla. */
  get placeRect() {
    const p = this.placement;
    if (!p) return null;
    const a = this.toScreen(p.x, p.y);
    return { x: a.x, y: a.y, w: p.w * this.scale, h: p.h * this.scale };
  }

  /* Que agarra un punto de pantalla: 'nw' | 'ne' | 'se' | 'sw' cuando cae sobre
   * un tirador, 'move' en cualquier otro lado, null si no hay nada colocandose.
   *
   * Afuera de la caja tambien devuelve 'move' a proposito. Una zona muerta
   * alrededor solo serviria para que un arrastre que empezo dos pixeles afuera
   * no haga nada, y en una app de tablet ese error se comete todo el tiempo. */
  placementHitAt(sx, sy) {
    const r = this.placeRect;
    if (!r) return null;
    for (const [id, hx, hy] of corners(r)) {
      if (Math.abs(sx - hx) <= HANDLE_HIT / 2 && Math.abs(sy - hy) <= HANDLE_HIT / 2) return id;
    }
    return 'move';
  }

  // ── navegacion ────────────────────────────────────────────────────────────

  fit(margin = 0.94) { this.fitRect(this.doc.bounds, margin); }

  /* Encaja un rect del DOCUMENTO en la ventana y lo centra. El lienzo entero es
   * el caso comun, pero pegar una captura mas grande que el lienzo necesita
   * encuadrar la union de los dos: si la caja de la imagen cae afuera de la
   * ventana, sus tiradores quedan fuera de alcance y no hay como achicarla. */
  fitRect(r, margin = 0.94) {
    const s = Math.min(this.cssW / r.w, this.cssH / r.h) * margin;
    this.scale = clamp(s, ZOOM_MIN, ZOOM_MAX);
    this.tx = this.cssW / 2 - (r.x + r.w / 2) * this.scale;
    this.ty = this.cssH / 2 - (r.y + r.h / 2) * this.scale;
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

    if (this.placement) this.#drawPlacement();
    if (this.selection) this.#drawSelection();
    if (this.cursor) this.#drawCursor();
  }

  /* Dos trazos discontinuos desfasados hacen una "hormiga" legible sobre claro
   * y oscuro sin obligar a mantener un loop de animacion prendido. El ambar
   * apenas lavado identifica el area sin tapar el dibujo que se esta eligiendo. */
  #drawSelection() {
    const s = this.selection;
    const a = this.toScreen(s.x, s.y);
    const r = { x: a.x, y: a.y, w: s.w * this.scale, h: s.h * this.scale };
    const c = this.ctx;

    c.save();
    c.fillStyle = 'rgba(224,160,74,.08)';
    c.fillRect(r.x, r.y, r.w, r.h);
    c.lineWidth = 1;
    c.setLineDash([5, 5]);
    c.strokeStyle = 'rgba(0,0,0,.9)';
    c.lineDashOffset = 0;
    c.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    c.strokeStyle = 'rgba(255,255,255,.95)';
    c.lineDashOffset = 5;
    c.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    c.restore();
  }

  /* La imagen que todavia no aterrizo, con su caja y sus cuatro tiradores.
   *
   * Se dibuja DOS veces: una entera y fantasma, otra recortada al lienzo y
   * opaca. Lo que sobresale del lienzo es justo lo que se va a perder al
   * soltar, asi que mostrarlo apagado es la unica forma de decidir el encuadre
   * — recortarlo de una obligaria a adivinar cuanto quedo afuera. La opaca va
   * encima, asi que adentro del lienzo la imagen se ve tal cual va a quedar. */
  #drawPlacement() {
    const p = this.placement;
    const r = this.placeRect;
    const doc = this.docRect;
    const c = this.ctx;

    /* El suavizado se decide por el aumento REAL de los pixeles de origen, que
     * con una imagen escalada no es el zoom: una captura al 40% vista al 300%
     * sigue mostrando cada pixel de origen mas chico que uno de pantalla. */
    const mag = r.w / p.img.width;

    c.save();
    c.globalAlpha = .28;
    c.imageSmoothingEnabled = mag < 2.5;
    c.imageSmoothingQuality = 'high';
    c.drawImage(p.img, r.x, r.y, r.w, r.h);
    c.restore();

    c.save();
    c.beginPath();
    c.rect(doc.x, doc.y, doc.w, doc.h);
    c.clip();
    c.imageSmoothingEnabled = mag < 2.5;
    c.imageSmoothingQuality = 'high';
    c.drawImage(p.img, r.x, r.y, r.w, r.h);
    c.restore();

    /* Caja de doble trazo, igual que el anillo del pincel: una captura puede ser
     * blanca o negra y un contorno de un solo color desaparece en la mitad de
     * los casos. */
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.strokeRect(r.x - .5, r.y - .5, r.w + 1, r.h + 1);
    c.strokeStyle = 'rgba(255,255,255,.85)';
    c.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);

    for (const [id, hx, hy] of corners(r)) {
      const on = p.active ? p.active === id : p.handle === id;
      c.beginPath();
      c.roundRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE, 2);
      c.fillStyle = on ? '#e0a04a' : '#e8e8e8';
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,.75)';
      c.stroke();
    }
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

/* Las cuatro esquinas de un rect de pantalla, con su nombre cardinal. El nombre
 * es lo que despues dice cual es la esquina ANCLA — la opuesta, la que no se
 * mueve mientras se escala. */
function corners(r) {
  return [
    ['nw', r.x, r.y],
    ['ne', r.x + r.w, r.y],
    ['se', r.x + r.w, r.y + r.h],
    ['sw', r.x, r.y + r.h],
  ];
}

function cross(c, x, y, s) {
  c.beginPath();
  c.moveTo(x - s, y); c.lineTo(x + s, y);
  c.moveTo(x, y - s); c.lineTo(x, y + s);
  c.stroke();
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
