/* Panel del pincel.
 *
 * Los controles no estan escritos en el HTML: se generan a partir de la lista
 * 'fields' del preset. Asi el panel es un reflejo del pincel y agregar un pincel
 * nuevo con otros parametros no obliga a tocar la interfaz.
 *
 * El preview dibuja una pincelada de verdad con el motor real (mismo Painter,
 * mismo rasterizado), con una presion que sube y baja a lo largo del trazo. No
 * es una ilustracion aproximada: es exactamente lo que va a salir en el lienzo,
 * incluida la respuesta a la presion, que es lo que uno quiere comprobar antes
 * de tirar el primer trazo. */

import { FIELD_SPEC, Painter } from '../engine/brush.js';
import { makeSlider, el } from './controls.js';
import { icon } from './icons.js';

export function initBrushPanel({ host, titleEl, previewCanvas, onChange }) {
  let brush = null;
  let color = '#ffffff';
  const sliders = new Map();
  // el estado abierto/cerrado de la seccion plegable sobrevive al cambio de
  // pincel: si la abriste para calibrar, no queremos que se cierre sola
  let dynamicsOpen = false;

  // Painter propio para el preview, con un documento ficticio del tamano del
  // canvas de muestra. El motor no necesita mas que ancho y alto.
  let preview = null;

  function makeField(key) {
    const spec = FIELD_SPEC[key];
    if (!spec) return null;
    const s = makeSlider({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      curve: spec.curve || 1,
      value: brush[key],
      fmt: spec.fmt,
      onInput: (v) => {
        brush[key] = v;
        drawPreview();
        onChange?.(brush, key, v);
      },
    });
    sliders.set(key, s);
    return s;
  }

  function setBrush(next) {
    brush = next;
    if (titleEl) titleEl.textContent = next.name;

    host.replaceChildren();
    sliders.clear();

    for (const key of next.fields || []) {
      const f = makeField(key);
      if (f) host.append(f.el);
    }

    const dyn = next.dynamics || [];
    if (dyn.length) host.append(buildDynamics(dyn));

    drawPreview();
  }

  /* Seccion plegable. El alto se anima con grid-template-rows de 0fr a 1fr en vez
   * de animar 'height': height necesitaria medir el contenido en JS y volver a
   * medirlo cada vez que cambia, y animarla genera relayout en cada frame. */
  function buildDynamics(keys) {
    const disc = el('div', 'sc-disc');
    if (dynamicsOpen) disc.classList.add('open');

    const btn = el('button', 'sc-disc__btn');
    btn.append(
      el('span', null, { text: 'Dynamics' }),
      el('span', 'sc-disc__line'),
      icon('chevronDown', 12),
    );
    btn.setAttribute('data-tip', 'How pressure and smoothing shape the stroke');

    const body = el('div', 'sc-disc__body');
    const inner = el('div', 'sc-disc__inner');
    for (const key of keys) {
      const f = makeField(key);
      if (f) inner.append(f.el);
    }
    body.append(inner);

    btn.addEventListener('click', () => {
      dynamicsOpen = !dynamicsOpen;
      disc.classList.toggle('open', dynamicsOpen);
    });

    disc.append(btn, body);
    return disc;
  }

  /* Cuando el valor cambia desde afuera (atajos de teclado, corchetes de tamano)
   * el slider tiene que seguirlo sin volver a disparar onChange. */
  function syncField(key) {
    const s = sliders.get(key);
    if (s && brush) s.set(brush[key]);
    drawPreview();
  }

  function setColor(next) {
    color = next;
    drawPreview();
  }

  function drawPreview() {
    if (!previewCanvas || !brush) return;

    const rect = previewCanvas.getBoundingClientRect();
    if (rect.width < 8) return;      // el panel todavia no tiene layout
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (previewCanvas.width !== w || previewCanvas.height !== h) {
      previewCanvas.width = w;
      previewCanvas.height = h;
      preview = null;
    }

    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* Fondo en degradado de oscuro a claro: un trazo blanco se lee contra la
     * izquierda y uno negro contra la derecha, asi que ningun color queda
     * invisible en el preview. */
    const bg = ctx.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, '#141414');
    bg.addColorStop(1, '#3c3c3c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    /* Las herramientas que no pintan trazos (el relleno) no tienen 'kind' y no
     * hay pincelada que mostrar: se muestra el color que van a volcar. */
    if (!brush.kind) {
      const pad = Math.round(7 * dpr);
      ctx.fillStyle = color;
      ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);
      return;
    }

    if (!preview) preview = new Painter({ width: w, height: h });
    preview.doc.width = w;
    preview.doc.height = h;
    preview.syncSize();

    /* El pincel del preview es una copia con el tamano escalado por el dpr: si
     * no, en una pantalla con escalado el trazo saldria a la mitad del tamano
     * relativo al recuadro. */
    const shown = { ...brush, size: brush.size * dpr };
    preview.begin(shown, color);

    // pincelada de muestra: onda suave con la presion subiendo y bajando
    const pad = Math.max(6 * dpr, shown.size * 0.55);
    const x0 = pad, x1 = w - pad;
    const mid = h / 2;
    const amp = Math.min(h * 0.24, (h / 2 - shown.size * 0.5) * 0.9);
    const STEPS = 90;
    let prev = null;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const pt = {
        x: x0 + (x1 - x0) * t,
        y: mid + Math.sin(t * Math.PI * 2) * amp,
        // presion de campana: nace fina, engorda en el medio, muere fina
        p: Math.max(0.03, Math.sin(t * Math.PI)),
      };
      if (prev) preview.segment(prev, pt);
      else preview.dot(pt);
      prev = pt;
    }

    const wl = preview.wetLayer;
    ctx.save();
    if (brush.erase) {
      /* El borrador sobre un fondo vacio no mostraria nada. Se pinta una banda
       * de muestra y se borra con el trazo real: asi el preview muestra lo que
       * el borrador hace, no lo que dibuja. */
      ctx.globalCompositeOperation = 'source-over';
      const band = ctx.createLinearGradient(0, 0, w, 0);
      band.addColorStop(0, '#8a8a8a');
      band.addColorStop(1, '#d8d8d8');
      ctx.fillStyle = band;
      ctx.fillRect(0, h * 0.22, w, h * 0.56);
      ctx.globalAlpha = wl.alpha;
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalAlpha = wl.alpha;
      ctx.globalCompositeOperation = wl.mode;
    }
    ctx.drawImage(preview.wet, 0, 0);
    ctx.restore();
  }

  window.addEventListener('resize', drawPreview);

  return { setBrush, setColor, syncField, drawPreview, get brush() { return brush; } };
}
