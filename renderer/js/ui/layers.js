/* Panel de capas.
 *
 * La lista se muestra al revés del array: la capa de arriba del apilado va
 * primero. Es la convencion de toda app de capas y coincide con como uno piensa
 * en ellas ("la de arriba tapa a la de abajo").
 *
 * El reordenamiento es por arrastre y con movimiento real: el item agarrado
 * sigue al puntero y los demas se corren para abrir el hueco. Una linea de
 * insercion sola seria mas facil de programar, pero se siente muerta — no
 * comunica que las capas se estan moviendo. */

import { el } from './controls.js';
import { icon } from './icons.js';
import { drawThumb } from '../engine/doc.js';

const DRAG_THRESHOLD = 4;   // px antes de considerar que es un arrastre y no un click

export function initLayers({ host, doc, callbacks }) {
  let rows = [];              // { node, index, thumbCanvas, rev }
  let drag = null;
  let entering = new Set();   // indices que deben animar su entrada

  function render() {
    const prevScroll = host.scrollTop;
    host.replaceChildren();
    rows = [];

    // de arriba hacia abajo del apilado
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const row = buildRow(layer, i);
      host.append(row.node);
      rows.push(row);
    }
    host.scrollTop = prevScroll;
    entering.clear();
    refreshThumbs(true);
  }

  function buildRow(layer, index) {
    const node = el('div', 'sc-layer');
    node.dataset.index = String(index);
    if (index === doc.activeIndex) node.classList.add('on');
    if (!layer.visible) node.classList.add('hidden');
    if (entering.has(layer.id)) node.classList.add('entering');

    // ojo: alterna visibilidad sin seleccionar la capa
    const eye = el('button', 'sc-iconbtn sc-layer__eye');
    eye.setAttribute('data-tip', layer.visible ? 'Hide layer' : 'Show layer');
    eye.append(icon(layer.visible ? 'eye' : 'eyeOff', 15));
    eye.addEventListener('pointerdown', (e) => e.stopPropagation());
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onToggleVisible?.(index);
    });

    const thumbWrap = el('div', 'sc-layer__thumb');
    const thumbCanvas = el('canvas');
    thumbCanvas.width = 68;    // 2x del tamano css, para que no se vea borrosa
    thumbCanvas.height = 52;
    thumbWrap.append(thumbCanvas);

    const meta = el('div', 'sc-layer__meta');
    const name = el('div', 'sc-layer__name', { text: layer.name });
    const sub = el('div', 'sc-layer__sub', { text: subtitle(layer) });
    meta.append(name, sub);

    node.append(eye, thumbWrap, meta);

    // doble click en el nombre: renombrar en el lugar
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(name, layer, index);
    });

    node.addEventListener('pointerdown', (e) => beginDrag(e, node, index));

    return { node, index, layer, thumbCanvas, rev: -1 };
  }

  function subtitle(layer) {
    const op = `${Math.round(layer.opacity * 100)}%`;
    return layer.blend === 'source-over' ? op : `${op} · ${blendName(layer.blend)}`;
  }

  function blendName(id) {
    return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function startRename(nameNode, layer, index) {
    const input = el('input', null, { value: layer.name, spellcheck: false });
    nameNode.replaceChildren(input);
    input.focus();
    input.select();
    const finish = (commit) => {
      const value = input.value.trim();
      nameNode.textContent = commit && value ? value : layer.name;
      if (commit && value && value !== layer.name) callbacks.onRename?.(index, value);
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { finish(true); input.blur(); }
      if (e.key === 'Escape') { finish(false); input.blur(); }
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // ── arrastre ──────────────────────────────────────────────────────────────

  function beginDrag(e, node, index) {
    if (e.button !== 0) return;
    // seleccionar es inmediato: esperar a saber si es arrastre haria sentir la
    // seleccion lenta
    callbacks.onSelect?.(index);

    const startY = e.clientY;
    const visualFrom = rows.findIndex((r) => r.node === node);
    const step = node.offsetHeight + 3;   // alto del item mas el gap del flex

    drag = { node, index, startY, visualFrom, step, moved: false, visualTo: visualFrom };
    node.setPointerCapture(e.pointerId);
    node.addEventListener('pointermove', onDragMove);
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.node.style.zIndex = '5';
      drag.node.style.transition = 'none';
      drag.node.style.boxShadow = 'var(--sc-sh2)';
      drag.node.style.background = 'var(--sc-s4)';
    }

    const shift = Math.round(dy / drag.step);
    const to = Math.max(0, Math.min(rows.length - 1, drag.visualFrom + shift));
    drag.visualTo = to;

    drag.node.style.transform = `translateY(${dy}px)`;

    /* Los otros items se corren un lugar para abrir el hueco. Con transicion,
     * asi que el reacomodo se ve moverse en vez de saltar. */
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.node === drag.node) continue;
      let off = 0;
      if (drag.visualFrom < to && i > drag.visualFrom && i <= to) off = -drag.step;
      else if (drag.visualFrom > to && i >= to && i < drag.visualFrom) off = drag.step;
      r.node.style.transform = off ? `translateY(${off}px)` : '';
    }
  }

  function endDrag(e) {
    if (!drag) return;
    const { node, visualFrom, visualTo, moved } = drag;
    try { node.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    node.removeEventListener('pointermove', onDragMove);
    node.removeEventListener('pointerup', endDrag);
    node.removeEventListener('pointercancel', endDrag);

    for (const r of rows) {
      r.node.style.transform = '';
      r.node.style.transition = '';
      r.node.style.zIndex = '';
      r.node.style.boxShadow = '';
      r.node.style.background = '';
    }
    drag = null;

    if (!moved || visualFrom === visualTo) return;

    // de indices visuales (invertidos) a indices del array
    const n = doc.layers.length;
    const from = n - 1 - visualFrom;
    const to = n - 1 - visualTo;
    callbacks.onReorder?.(from, to);
  }

  // ── miniaturas ────────────────────────────────────────────────────────────

  /* Se redibujan solo si el contador de revision de la capa cambio. Sin ese
   * chequeo, cada frame de un trazo re-escalaria el lienzo entero a 68x52 para
   * cada capa, que es justo el tipo de trabajo invisible que come fps. */
  function refreshThumbs(force = false) {
    for (const r of rows) {
      if (!force && r.rev === r.layer.rev) continue;
      drawThumb(r.thumbCanvas, r.layer, doc.width, doc.height);
      r.rev = r.layer.rev;
    }
  }

  /* Actualiza seleccion, visibilidad y subtitulos sin reconstruir el DOM: al
   * mover un slider de opacidad esto corre en cada frame. */
  function sync() {
    for (const r of rows) {
      const active = r.index === doc.activeIndex;
      r.node.classList.toggle('on', active);
      r.node.classList.toggle('hidden', !r.layer.visible);
      const sub = r.node.querySelector('.sc-layer__sub');
      if (sub) sub.textContent = subtitle(r.layer);
      const eye = r.node.querySelector('.sc-layer__eye');
      if (eye) {
        const want = r.layer.visible ? 'eye' : 'eyeOff';
        if (eye.dataset.state !== want) {
          eye.dataset.state = want;
          eye.replaceChildren(icon(want, 15));
          eye.setAttribute('data-tip', r.layer.visible ? 'Hide layer' : 'Show layer');
        }
      }
    }
  }

  function markEntering(layerId) { entering.add(layerId); }

  return { render, sync, refreshThumbs, markEntering };
}
