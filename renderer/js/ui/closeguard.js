/* ¿Guardar antes de cerrar?
 *
 * Cerrar una ventana con un dibujo sin guardar — la X, Alt+F4, Ctrl+W, la barra
 * de tareas, o reiniciar para actualizar — no cierra: pregunta. Es el unico
 * lugar de la app donde un gesto de un segundo puede tirar horas de trabajo, y
 * con la tableta en la mano ese gesto pasa mas seguido de lo que uno quisiera.
 *
 * El cierre lo intercepta el proceso principal (es el unico que ve TODOS los
 * caminos por los que una ventana se cierra) y se lo manda a esta ventana, que
 * es la unica que sabe si hay algo que perder y como guardarlo. Recien con la
 * respuesta el principal la cierra de verdad. Cancelar — o Escape, o el velo —
 * la deja abierta y no pasa nada mas.
 *
 * Los tres botones van en el orden que evita el error caro: "Don't save"
 * apartado a la izquierda, lejos de "Save", que es el primario y el que Enter
 * dispara. Nadie deberia poder descartar un dibujo por apretar un pixel al
 * lado de guardarlo. */

import { openModal } from './modal.js';
import { el } from './controls.js';

/* isDirty()   si hay algo que perder
 * docName()   como se llama el dibujo, para decirlo por su nombre
 * save()      guarda; resuelve true si quedo guardado, false si se cancelo */
export function initCloseGuard({ isDirty, docName, save }) {
  let dialog = null;   // el modal, mientras este abierto

  function ask() {
    // ya se esta preguntando: un segundo Alt+F4 no abre otro dialogo encima
    if (dialog) return;
    // el principal pregunta por lo ultimo que supo; si en el camino se guardo, adelante
    if (!isDirty()) { window.scrawl.win.confirmClose(); return; }

    dialog = openModal({
      title: 'Unsaved changes',
      iconName: 'alert',
      width: 380,
      onEnter: saveAndClose,
      onClose: () => { dialog = null; },
    });

    dialog.body.append(
      el('p', 'sc-close__msg', { text: `“${docName()}” has changes that aren’t saved.` }),
      el('p', 'sc-modal__hint sc-modal__hint--block', {
        text: 'Save keeps everything. Don’t save closes the window and throws the changes away.',
      }),
    );

    dialog.button('Don’t save', 'danger', (close) => {
      close('discard');
      window.scrawl.win.confirmClose();
    });
    dialog.button('Cancel', 'ghost', (close) => close('cancel'));
    dialog.button('Save', 'primary', saveAndClose);
  }

  /* El modal se cierra ANTES de guardar: el dialogo de archivo es del sistema y
   * flota encima igual, pero si se lo cancela hay que volver a la app sin un
   * velo colgado. Guardado a medias — cancelado — la ventana se queda. */
  async function saveAndClose() {
    dialog?.close('save');
    if (await save()) window.scrawl.win.confirmClose();
  }

  window.scrawl.win.onConfirmClose(ask);
}
