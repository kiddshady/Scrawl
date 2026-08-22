/* Modal propio.
 *
 * Es el primer dialogo de la app, asi que vale explicar por que no es un
 * <dialog> nativo: el ::backdrop de Chromium no se puede animar de entrada y de
 * salida como el resto de las superficies de Scrawl, el foco lo maneja el
 * navegador a su manera y el Escape lo cierra de golpe, sin transicion. Todo eso
 * es justo lo que el resto de la interfaz hace a mano.
 *
 * El velo y la caja se animan por separado — el fondo se funde, la caja ademas
 * sube y se acerca — y la salida se ESPERA antes de desmontar: nada aparece ni
 * desaparece de golpe, tampoco el dialogo. */

import { el } from './controls.js';
import { icon } from './icons.js';

let open = 0;

/* Los atajos globales de la app preguntan por esto: con un dialogo arriba, una
 * 'b' es una letra que alguien esta escribiendo, no el atajo del pincel. */
export function modalOpen() { return open > 0; }

/* opts: { title, iconName, width, onEnter, onClose }
 * Devuelve { body, foot, button, close } — el contenido lo arma quien llama. */
export function openModal({ title, iconName = null, width = 360, onEnter = null, onClose = null }) {
  // a donde vuelve el foco al cerrar: donde estaba antes de abrir
  const returnTo = document.activeElement;

  const veil = el('div', 'sc-veil');
  const box = el('div', 'sc-modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  box.style.width = `${width}px`;

  const head = el('div', 'sc-modal__head');
  const headIcon = el('span', 'sc-modal__icon');
  if (iconName) headIcon.append(icon(iconName, 15));
  const headTitle = el('span', 'sc-modal__title', { text: title });
  head.append(headIcon, headTitle);
  const closeBtn = el('button', 'sc-iconbtn', { 'data-tip': 'Close', 'data-key': 'Esc' });
  closeBtn.append(icon('winClose', 12));
  head.append(closeBtn);

  const body = el('div', 'sc-modal__body');
  const foot = el('div', 'sc-modal__foot');

  box.append(head, body, foot);
  veil.append(box);
  document.body.append(veil);
  open++;

  // un frame de margen para que la transicion de entrada corra desde el estado
  // inicial en vez de saltar al final
  requestAnimationFrame(() => veil.classList.add('show'));

  let closed = false;

  function close(reason = 'dismiss') {
    if (closed) return;
    closed = true;
    open--;
    document.removeEventListener('keydown', onKey, true);
    veil.classList.remove('show');
    /* Se anima la salida y recien despues sale del DOM. El timeout es la red de
     * seguridad por si el transitionend no llega (la ventana se oculto a mitad
     * de la animacion y Chromium no la corrio). */
    veil.addEventListener('transitionend', () => veil.remove(), { once: true });
    setTimeout(() => veil.remove(), 500);
    returnTo?.focus?.();
    onClose?.(reason);
  }

  // el foco no se escapa del dialogo mientras esta abierto
  function focusables() {
    return [...box.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close('cancel');
      return;
    }
    if (e.key === 'Enter' && onEnter) {
      /* Enter confirma, salvo que el foco este en un boton: ahi el click nativo
       * ya hace lo suyo y adelantarse dispararia la accion primaria cuando lo
       * que el usuario apreto era Cancelar. */
      if (document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      onEnter();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !box.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }
  }

  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => close('cancel'));
  // clic en el velo cierra; adentro de la caja no, aunque el evento burbujee
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close('cancel'); });

  /* Agrega un boton al pie. kind: 'primary' | 'ghost'. */
  function button(label, kind, onClick) {
    const b = el('button', `sc-btn sc-btn--${kind}`, { text: label });
    b.addEventListener('click', () => onClick(close));
    foot.append(b);
    return b;
  }

  /* Un dialogo que sigue a un proceso en curso cambia de nombre a mitad de
   * camino: el mismo modal es "hay una actualizacion" y despues "bajando". */
  function setTitle(next, nextIcon = null) {
    headTitle.textContent = next;
    box.setAttribute('aria-label', next);
    if (nextIcon) headIcon.replaceChildren(icon(nextIcon, 15));
  }

  return { veil, box, body, foot, button, setTitle, close };
}
