/* Barra de la imagen que se esta colocando.
 *
 * Cuando se pega una captura, la imagen no aterriza sola: queda flotando sobre
 * el lienzo hasta que uno la deja donde quiere. Esta barra es el otro extremo de
 * ese gesto — dice cuanto mide lo que se esta acomodando y ofrece las dos
 * salidas, dejarla o descartarla.
 *
 * ── Por que una barra y no solo Enter/Escape ────────────────────────────────
 * La app se usa con tablet. Un estado que solo se puede cerrar con el teclado
 * obliga a soltar el lapiz justo cuando la otra mano esta ocupada sosteniendo la
 * tableta, y encima es invisible: nada en pantalla diria que hay algo pendiente.
 * Los atajos siguen estando — la barra los muestra en su tooltip — pero no son
 * la unica puerta.
 *
 * ── Se corre sola ───────────────────────────────────────────────────────────
 * Va pegada abajo de la caja y la sigue. Cuando la caja esta tan abajo que la
 * barra se saldria de la ventana, salta arriba; y mientras se arrastra se
 * desvanece, porque en ese momento estorba justo donde esta la mano. */

import { el } from './controls.js';
import { icon } from './icons.js';

const GAP = 14;    // aire entre la caja y la barra
const EDGE = 10;   // margen minimo contra los bordes del viewport

/* Monta la barra dentro del contenedor del lienzo. Las coordenadas que recibe
 * son px CSS relativos a ese contenedor, el mismo sistema del puck. */
export function initPlaceBar(parent, { onPlace, onCancel, onReset }) {
  const host = el('div', 'sc-place');

  /* El tamano en vivo. Es un boton porque tambien es el camino de vuelta: el
   * mismo gesto que el porcentaje del HUD de zoom, que al tocarlo vuelve al
   * 100%. Ahi el numero es lo unico que dice a que escala quedo la imagen, asi
   * que es el lugar natural para deshacerla. */
  const size = el('button', 'sc-place__size', {
    'data-tip': 'Back to its real size',
  });
  const sizeNum = el('span', 'sc-place__num');
  const sizePct = el('span', 'sc-place__pct');
  size.append(sizeNum, sizePct);
  size.addEventListener('click', onReset);

  const go = el('button', 'sc-place__btn sc-place__btn--go', {
    'data-tip': 'Drop it into a new layer', 'data-key': 'Enter',
  });
  go.append(icon('check', 14), el('span', null, { text: 'Place' }));
  go.addEventListener('click', onPlace);

  const cancel = el('button', 'sc-place__btn', {
    'data-tip': 'Discard it', 'data-key': 'Esc',
  });
  cancel.append(icon('winClose', 13));
  cancel.addEventListener('click', onCancel);

  host.append(size, el('span', 'sc-place__sep'), go, cancel);
  parent.append(host);

  return {
    show() { host.classList.add('show'); },

    hide() {
      host.classList.remove('show');
      host.classList.remove('busy');
    },

    /* Mientras el arrastre corre la barra se aparta: sigue a la caja, asi que si
     * no se apagara terminaria justo abajo de la mano que esta moviendo. */
    setBusy(on) { host.classList.toggle('busy', on); },

    setSize(w, h, ratio) {
      const pct = Math.round(ratio * 100);
      sizeNum.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      /* El porcentaje solo aparece cuando dice algo: al 100% seria ruido, y de
       * paso su ausencia es la senal de que la captura esta a tamano real. */
      sizePct.textContent = pct === 100 ? '' : `${pct}%`;
    },

    /* r es el rect de la caja en pantalla; vw/vh el tamano del viewport. */
    place(r, vw, vh) {
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      let x = r.x + r.w / 2 - w / 2;
      let y = r.y + r.h + GAP;
      // no entra abajo de la caja: va arriba, que es el unico otro lado que no
      // tapa lo que uno esta mirando
      if (y + h > vh - EDGE) y = r.y - h - GAP;
      x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
      y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
      host.style.left = `${Math.round(x)}px`;
      host.style.top = `${Math.round(y)}px`;
    },
  };
}
