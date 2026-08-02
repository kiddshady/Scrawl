/* Selector de color: anillo de matiz mas cuadrado de saturacion/valor.
 *
 * Dibujado en canvas a mano. Un <input type="color"> abriria el dialogo de color
 * de Windows, que rompe por completo la ilusion de instrumento propio, y no
 * permite el flujo que uno quiere mientras dibuja: cambiar de matiz sin perder
 * la saturacion y el brillo que ya elegiste. Con anillo + cuadrado, los dos ejes
 * son independientes. */

import { toHex, parseHex } from '../engine/brush.js';

export const DEFAULT_SWATCHES = [
  '#000000', '#3a3a3a', '#6e6e6e', '#a5a5a5', '#ffffff',
  '#b23c2e', '#e05a3c', '#f0913a', '#f5c944', '#b9d24a',
  '#5aa84a', '#3fa88f', '#3d8fd6', '#3a5fc0', '#6b45c4',
  '#a840b0', '#d94a86', '#8a5a3c', '#4a3a2e', '#14161a',
];

const RING = 0.16;      // grosor del anillo, como fraccion del radio
const RING_GAP = 0.045; // aire entre el anillo y el cuadrado

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const map = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  const [r, g, b] = map[i % 6];
  return { r: r * 255, g: g * 255, b: b * 255 };
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function initColor({ canvas, chip, hexInput, swatchHost, onChange }) {
  let h = 0, s = 0, v = 0.91;      // arranca en un gris claro neutro
  let previous = '#e8e8e8';
  let dragging = null;             // 'ring' | 'square'
  const recents = [];

  const ctx = canvas.getContext('2d');
  let size = 0, cx = 0, cy = 0, R = 0;

  function metrics() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    size = Math.max(40, Math.min(rect.width, rect.height));
    const px = Math.round(size * dpr);
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    cx = size / 2; cy = size / 2;
    R = size / 2 - 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // el cuadrado inscrito en el circulo interior: lado = radio interior * √2
  function squareRect() {
    const inner = R * (1 - RING - RING_GAP);
    const side = inner * Math.SQRT1_2 * 2;
    return { x: cx - side / 2, y: cy - side / 2, w: side, h: side };
  }

  function draw() {
    metrics();
    ctx.clearRect(0, 0, size, size);

    // ── anillo de matiz ──
    const rOut = R;
    const rIn = R * (1 - RING);
    /* createConicGradient da el anillo continuo de una sola pasada. La
     * alternativa (cientos de cunas con fillStyle distinto) deja costuras
     * visibles entre segmentos. Arranca en -90deg para que el rojo quede arriba. */
    const cone = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const { r, g, b } = hsvToRgb(t, 1, 1);
      cone.addColorStop(t, `rgb(${r | 0},${g | 0},${b | 0})`);
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.arc(cx, cy, rIn, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = cone;
    ctx.fill();
    ctx.restore();

    // ── cuadrado saturacion / valor ──
    const q = squareRect();
    const pure = hsvToRgb(h, 1, 1);
    const gx = ctx.createLinearGradient(q.x, 0, q.x + q.w, 0);
    gx.addColorStop(0, '#ffffff');
    gx.addColorStop(1, `rgb(${pure.r | 0},${pure.g | 0},${pure.b | 0})`);
    ctx.fillStyle = gx;
    ctx.fillRect(q.x, q.y, q.w, q.h);

    const gy = ctx.createLinearGradient(0, q.y, 0, q.y + q.h);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(1, '#000000');
    ctx.fillStyle = gy;
    ctx.fillRect(q.x, q.y, q.w, q.h);

    // ── manijas ──
    // en el anillo: una marca radial sobre el matiz elegido
    const a = h * Math.PI * 2 - Math.PI / 2;
    const rm = (rOut + rIn) / 2;
    handle(ctx, cx + Math.cos(a) * rm, cy + Math.sin(a) * rm, 5.5);

    // en el cuadrado: el punto de saturacion y valor
    handle(ctx, q.x + s * q.w, q.y + (1 - v) * q.h, 6);
  }

  /* Doble anillo, oscuro afuera y claro adentro: una manija de un solo color
   * desaparece justo en la mitad de la rueda donde el fondo la iguala. */
  function handle(c, x, y, r) {
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(0,0,0,.6)';
    c.beginPath(); c.arc(x, y, r + 1, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 1.6;
    c.strokeStyle = '#ffffff';
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
  }

  // ── estado ────────────────────────────────────────────────────────────────

  function hex() {
    const { r, g, b } = hsvToRgb(h, s, v);
    return toHex(r, g, b);
  }

  function paintOut(notify) {
    const value = hex();
    if (chip) chip.style.background = value;
    if (hexInput && document.activeElement !== hexInput) hexInput.value = value;
    draw();
    if (notify) onChange?.(value);
  }

  function setHex(value, notify = true) {
    const clean = normalizeHex(value);
    if (!clean) return false;
    const { r, g, b } = parseHex(clean);
    const hsv = rgbToHsv(r, g, b);
    /* Si el color es un gris o un negro puro, su matiz es indefinido (0 por
     * convencion). Conservar el matiz anterior evita que la rueda salte al rojo
     * cada vez que pasas por el blanco o el negro. */
    if (hsv.s > 0.001) h = hsv.h;
    s = hsv.s; v = hsv.v;
    paintOut(notify);
    return true;
  }

  // ── interaccion ───────────────────────────────────────────────────────────

  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pickRing(pt) {
    h = (Math.atan2(pt.y - cy, pt.x - cx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
    paintOut(true);
  }

  function pickSquare(pt) {
    const q = squareRect();
    s = clamp01((pt.x - q.x) / q.w);
    v = 1 - clamp01((pt.y - q.y) / q.h);
    paintOut(true);
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const pt = local(e);
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    if (d > R * (1 - RING) - 3) { dragging = 'ring'; pickRing(pt); }
    else { dragging = 'square'; pickSquare(pt); }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pt = local(e);
    if (dragging === 'ring') pickRing(pt);
    else pickSquare(pt);
  });

  const release = (e) => {
    if (!dragging) return;
    dragging = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    remember(hex());
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  if (hexInput) {
    const commit = () => {
      if (!setHex(hexInput.value)) hexInput.value = hex();
      else remember(hex());
    };
    hexInput.addEventListener('change', commit);
    hexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); hexInput.blur(); }
      if (e.key === 'Escape') { hexInput.value = hex(); hexInput.blur(); }
      // el canvas escucha atajos de una letra; sin esto, escribir un hex
      // dispararia herramientas
      e.stopPropagation();
    });
    hexInput.addEventListener('focus', () => hexInput.select());
  }

  // ── swatches ──────────────────────────────────────────────────────────────

  function renderSwatches() {
    if (!swatchHost) return;
    swatchHost.replaceChildren();
    // los recientes primero: es lo que uno vuelve a buscar
    const list = [...recents, ...DEFAULT_SWATCHES.filter((c) => !recents.includes(c))].slice(0, 20);
    for (const c of list) {
      const b = document.createElement('button');
      b.className = 'sc-swatch';
      b.style.background = c;
      b.setAttribute('data-tip', c);
      b.addEventListener('click', () => { previous = hex(); setHex(c); remember(c); });
      swatchHost.append(b);
    }
  }

  function remember(value) {
    const i = recents.indexOf(value);
    if (i >= 0) recents.splice(i, 1);
    recents.unshift(value);
    if (recents.length > 10) recents.length = 10;
    renderSwatches();
  }

  // ── init ──────────────────────────────────────────────────────────────────

  renderSwatches();
  paintOut(false);
  // la rueda se redibuja al cambiar el tamano de la ventana: es un canvas, no
  // escala solo sin verse borroso
  window.addEventListener('resize', () => paintOut(false));

  return {
    get hex() { return hex(); },
    set(value) { previous = hex(); setHex(value); },
    setSilent(value) { setHex(value, false); },
    pick(value) { previous = hex(); setHex(value); remember(value); },
    swap() {
      const now = hex();
      setHex(previous);
      previous = now;
    },
    redraw: () => paintOut(false),
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function normalizeHex(value) {
  let v = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return `#${v.toLowerCase()}`;
}
