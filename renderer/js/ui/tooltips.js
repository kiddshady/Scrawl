/* Tooltips propios.
 *
 * El title= nativo es amarillo, tarda un segundo fijo que no se puede cambiar,
 * no se puede estilar y aparece de golpe. Este se dispara con un data-tip, vive
 * portaleado en el body — asi ningun overflow:hidden de panel lo recorta — y
 * entra y sale con transicion.
 *
 * Es UN solo controller delegado en document, no un componente por boton: con
 * delegacion, cualquier nodo que aparezca despues (un item de capa nuevo, un
 * boton en un popover) ya tiene tooltip sin registrar nada. */

import { el } from './controls.js';

const DELAY = 380;    // aparecer cuesta un momento: un tooltip instantaneo molesta
const GAP = 8;

let tip = null;
let node = null;      // trigger actual
let timer = null;
let visible = false;

export function initTooltips() {
  tip = el('div', 'sc-tip');
  document.body.append(tip);

  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t === node) return;
    if (t) show(t);
    else hide();
  });

  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    // solo con foco de teclado: si no, cada click mostraria el tooltip al soltar
    if (t && t.matches(':focus-visible')) show(t);
  });
  document.addEventListener('focusout', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
}

function show(target) {
  node = target;
  clearTimeout(timer);

  const render = () => {
    if (node !== target || !target.isConnected) return;
    const text = target.dataset.tip;
    if (!text) return;

    tip.replaceChildren(document.createTextNode(text));
    const key = target.dataset.key;
    if (key) tip.append(el('span', 'sc-tip__key', { text: key }));

    place(target);
    tip.classList.add('show');
    visible = true;
  };

  // si ya hay uno visible, moverse al vecino no vuelve a esperar el delay
  if (visible) render();
  else timer = setTimeout(render, DELAY);
}

function hide() {
  clearTimeout(timer);
  node = null;
  visible = false;
  if (tip) tip.classList.remove('show');
}

function place(target) {
  const r = target.getBoundingClientRect();
  // medir con el nodo ya poblado pero todavia invisible
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const pos = target.dataset.tipPos || 'auto';

  let x, y;

  /* 'auto' decide por geometria: los botones de la barra de herramientas estan
   * pegados al borde izquierdo, donde un tooltip centrado abajo se saldria de la
   * ventana; ahi va a la derecha. El resto va abajo. */
  const side = pos === 'auto' ? (r.left < 90 ? 'right' : 'bottom') : pos;

  if (side === 'right') {
    x = r.right + GAP;
    y = r.top + (r.height - th) / 2;
  } else if (side === 'left') {
    x = r.left - tw - GAP;
    y = r.top + (r.height - th) / 2;
  } else if (side === 'top') {
    x = r.left + (r.width - tw) / 2;
    y = r.top - th - GAP;
  } else {
    x = r.left + (r.width - tw) / 2;
    y = r.bottom + GAP;
  }

  // no dejar que se salga de la ventana por ningun lado
  x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
  if (y + th > window.innerHeight - 6) y = r.top - th - GAP;
  y = Math.max(6, y);

  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
}
