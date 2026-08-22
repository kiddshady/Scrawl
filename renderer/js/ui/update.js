/* Aviso de actualizacion.
 *
 * La regla que ordena todo lo de aca: una actualizacion nunca interrumpe. No hay
 * modal que aparezca solo, ni descarga que arranque sin permiso, ni reinicio que
 * llegue de sorpresa. Lo unico que pasa por su cuenta es que una pastilla se
 * enciende en la barra de estado; el resto lo decide quien esta dibujando.
 *
 * El estado vive en el proceso principal (es el que habla con GitHub) y llega
 * por IPC. Aca solo se pinta:
 *
 *   idle         no hay nada — la pastilla no existe
 *   available    hay version nueva, todavia no se bajo nada
 *   downloading  bajando, con porcentaje
 *   ready        bajada y lista: se aplica al reiniciar, o sola al cerrar la app
 *
 * Al montar se PREGUNTA el estado ademas de escuchar los cambios: el primer
 * chequeo puede haberse resuelto antes de que la interfaz existiera, y ahi el
 * mensaje ya paso de largo. */

import { openModal } from './modal.js';
import { el, toast } from './controls.js';
import { icon } from './icons.js';

export function initUpdate({ isDirty, save }) {
  const chip = document.getElementById('sc-update');
  const chipIcon = document.getElementById('sc-update-icon');
  const chipLabel = document.getElementById('sc-update-label');

  let state = { status: 'idle' };
  let dialog = null;        // el modal, mientras este abierto

  // ── pastilla ──────────────────────────────────────────────────────────────

  function paintChip() {
    const { status, version, percent } = state;

    if (status === 'idle') {
      /* Se apaga con su transicion y recien despues sale del layout: quitarle el
       * display de una deja el fade sin correr. */
      chip.classList.remove('on');
      setTimeout(() => { if (state.status === 'idle') chip.hidden = true; }, 260);
      return;
    }

    chipIcon.replaceChildren(icon(status === 'ready' ? 'restart' : 'download', 12));
    chipLabel.textContent = status === 'downloading'
      ? `Downloading ${percent ?? 0}%`
      : status === 'ready' ? 'Restart to update' : `Update ${version}`;
    chip.setAttribute('data-tip', status === 'ready'
      ? `Scrawl ${version} is ready — it installs when you restart`
      : status === 'downloading' ? `Downloading Scrawl ${version}` : `Scrawl ${version} is available`);

    if (chip.hidden) {
      chip.hidden = false;
      // un frame de margen para que la transicion de entrada corra desde el
      // estado inicial en vez de saltar al final
      requestAnimationFrame(() => chip.classList.add('on'));
    }
  }

  // ── dialogo ───────────────────────────────────────────────────────────────

  function openDialog() {
    if (dialog || state.status === 'idle') return;

    dialog = openModal({
      title: state.status === 'ready' ? 'Ready to update' : 'Update available',
      iconName: state.status === 'ready' ? 'restart' : 'download',
      width: 400,
      onClose: () => { dialog = null; },
    });

    paintDialog();
  }

  /* El dialogo se repinta entero con cada cambio de estado. Puede estar abierto
   * mientras la descarga avanza — de hecho es lo esperable, uno aprieta Download
   * y se queda mirando — asi que la barra de progreso y los botones tienen que
   * seguir al estado sin que nadie lo cierre y lo vuelva a abrir. */
  function paintDialog() {
    if (!dialog) return;
    const { status, version, current, notes, percent, portable } = state;

    dialog.setTitle(
      status === 'ready' ? 'Ready to update'
        : status === 'downloading' ? `Downloading ${version}` : 'Update available',
      status === 'ready' ? 'restart' : 'download',
    );

    const body = [];

    const head = el('div', 'sc-upd__head');
    head.append(el('span', 'sc-upd__ver', { text: `Scrawl ${version}` }));
    head.append(el('span', 'sc-upd__now', { text: `you have ${current}` }));
    body.push(head);

    if (notes) body.push(el('div', 'sc-notes sc-selectable', { text: notes }));

    if (status === 'downloading') {
      const bar = el('div', 'sc-progress');
      const fill = el('div', 'sc-progress__fill');
      fill.style.width = `${percent ?? 0}%`;
      bar.append(fill);
      body.push(bar);
    }

    if (status === 'ready') {
      body.push(hintRow(portable
        ? 'Open the download page to get it.'
        : 'It installs when you restart — or on its own the next time you close Scrawl.'));
    }

    /* Con un dibujo sin guardar, reiniciar lo perderia. No se bloquea el boton:
     * se dice, y se ofrece guardar primero, que es lo que uno queria hacer. */
    const dirty = status === 'ready' && isDirty();
    if (dirty) {
      const warn = el('div', 'sc-warn on');
      const inner = el('div', 'sc-warn__inner');
      const row = el('div', 'sc-warn__row');
      row.append(icon('alert', 14), el('span', null, { text: 'This drawing has unsaved changes.' }));
      inner.append(row);
      warn.append(inner);
      body.push(warn);
    }

    dialog.body.replaceChildren(...body);
    dialog.foot.replaceChildren();

    if (status === 'downloading') {
      dialog.button('Hide', 'ghost', (close) => close());
      return;
    }

    if (status === 'ready') {
      if (dirty) {
        dialog.button('Restart anyway', 'ghost', () => window.scrawl.update.install());
        dialog.button('Save and restart', 'primary', async () => {
          await save();
          window.scrawl.update.install();
        });
      } else {
        dialog.button('Later', 'ghost', (close) => close());
        dialog.button('Restart now', 'primary', () => window.scrawl.update.install());
      }
      return;
    }

    dialog.button('Later', 'ghost', (close) => close());
    dialog.button(portable ? 'Open download page' : 'Download', 'primary', (close) => {
      window.scrawl.update.download();
      // el portable no baja nada por su cuenta: el navegador se lleva el trabajo
      if (portable) close();
    });
  }

  function hintRow(text) {
    return el('p', 'sc-modal__hint sc-modal__hint--block', { text });
  }

  // ── estado ────────────────────────────────────────────────────────────────

  function apply(next) {
    state = next || { status: 'idle' };
    paintChip();
    if (state.status === 'idle') dialog?.close();
    else paintDialog();
    // un error de red no se le grita a nadie: la pastilla simplemente no aparece
    if (state.error) console.warn(`[update] ${state.error}`);
  }

  /* Chequeo a pedido, desde el menu. A diferencia del automatico, este SI
   * contesta cuando no hay nada: alguien que pregunta espera una respuesta. */
  async function checkNow() {
    const res = await window.scrawl.update.check();
    if (!res.ok) {
      toast(res.reason === 'dev'
        ? 'Updates only work in the installed app'
        : 'Could not reach GitHub', 'alert', 3200);
      return;
    }
    // el estado llega en la respuesta, no se espera al mensaje que viaja aparte
    apply(res.state);
    if (state.status === 'idle') {
      toast(state.current ? `Scrawl ${state.current} is up to date` : 'Scrawl is up to date', 'check');
    } else {
      openDialog();
    }
  }

  chip.addEventListener('click', openDialog);
  window.scrawl.update.onState(apply);
  window.scrawl.update.state().then(apply);

  return { checkNow };
}
