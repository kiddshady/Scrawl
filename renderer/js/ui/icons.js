/* Iconos.
 *
 * Todo simbolo de la interfaz vive aca como un path SVG propio. Ni un emoji ni
 * un glifo unicode: un glifo se renderiza distinto en cada maquina, no podes
 * controlar su peso ni su alineacion, y rompe el trazo consistente del set. Un
 * path se tine con currentColor, se anima y es identico en toda maquina.
 *
 * Todos comparten viewBox 24x24, stroke de 2, puntas redondeadas. Esa
 * uniformidad es lo que hace que el set se lea como un solo set. */

export const ICONS = {
  // la marca: un garabato de un solo trazo. el nombre de la app, dibujado.
  mark: 'M3 16C4.5 9 7.5 20 9.5 13S14 17 16 10.5 19.5 9 21 7',

  // ── herramientas ────────────────────────────────────────────────────────
  // pincel visto de frente: mango, virola y cerdas que cierran en punta
  brush: 'M12 3v6.5 M9.4 9.5h5.2 M9.4 9.5c0 4.2.9 7 2.6 11 1.7-4 2.6-6.8 2.6-11',
  pencil: 'M16.5 4.5l3 3-12 12-4 1 1-4z M14.5 6.5l3 3',
  // igual esqueleto que la goma, pero con el trazo de resaltado abajo: es la
  // sena que lo vuelve inconfundiblemente un marcador
  marker: 'M16.5 3.5l4 4-9 9H7l-1.5-4z M4 20.5h16',
  // los puntitos son subpaths de longitud cero: con linecap redondo, un punto
  airbrush: 'M9.5 9h5v11.5h-5z M11 9V6h2v3 M17.5 6.5h.01 M20 4.5h.01 M20 9h.01 M17.5 11.5h.01 M22.5 7h.01',
  eraser: 'M15.5 3.5l5 5-8 8h-5l-2.5-2.5z M9.5 9.5l5 5',
  line: 'M4.5 19.5L19.5 4.5',
  fill: 'M10.5 2.5l8.5 8.5-7 7-8.5-8.5z M19 13.5c1.4 1.9 2 3 2 4a2 2 0 0 1-4 0c0-1 .6-2.1 2-4z',
  picker: 'M17 3.5l3.5 3.5-2.5 2.5-3.5-3.5z M14.5 6L5 15.5V19h3.5L18 9.5',
  hand: 'M8 13V5.6a1.6 1.6 0 0 1 3.2 0V12 M11.2 12V4.6a1.6 1.6 0 0 1 3.2 0V12 M14.4 12.4V6.4a1.6 1.6 0 0 1 3.2 0V13 M17.6 10.4a1.6 1.6 0 0 1 3.2 0V16a6 6 0 0 1-6 6h-2.4a7 7 0 0 1-5-2.1l-3.1-3.2a1.7 1.7 0 0 1 2.4-2.4L8.4 16',

  // ── historial ───────────────────────────────────────────────────────────
  undo: 'M7.5 4.5L3 9l4.5 4.5 M3 9h11a5.5 5.5 0 0 1 0 11H8',
  redo: 'M16.5 4.5L21 9l-4.5 4.5 M21 9H10a5.5 5.5 0 0 0 0 11h6',

  // ── generales ───────────────────────────────────────────────────────────
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V5a1 1 0 0 1 1-1h4 M20 9V5a1 1 0 0 0-1-1h-4 M4 15v4a1 1 0 0 0 1 1h4 M20 15v4a1 1 0 0 1-1 1h-4',
  swap: 'M4 8.5h13 M13.5 5l3.5 3.5-3.5 3.5 M20 15.5H7 M10.5 12L7 15.5l3.5 3.5',
  check: 'M4.5 12.5l5 5 10-11',
  chevronDown: 'M6 9.5l6 6 6-6',
  crosshair: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  canvas: 'M3.5 5.5h17v13h-17z',
  history: 'M12 7.5V12l3.5 2 M4 12a8 8 0 1 0 2.9-6.2 M3.5 4.5V9H8',

  // ── capas ───────────────────────────────────────────────────────────────
  duplicate: 'M8.5 8.5h12v12h-12z M5.5 15.5h-2v-12h12v2',
  merge: 'M12 3.5v10.5 M7.5 9.5l4.5 4.5 4.5-4.5 M4 19.5h16',
  trash: 'M3.5 6.5h17 M9 4h6 M6 6.5l1 13.5h10l1-13.5 M10 10.5v6.5 M14 10.5v6.5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z',
  eyeOff: 'M4 4l16 16 M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.4 17.4 0 0 1-2.5 3.4 M6.7 7.7A17.4 17.4 0 0 0 2.5 12S6 18.5 12 18.5c1.1 0 2.1-.2 3-.5 M10 10a2.8 2.8 0 0 0 4 4',

  // ── archivo ─────────────────────────────────────────────────────────────
  newDoc: 'M6.5 3.5h7l5 5v12h-12z M13.5 3.5v5h5',
  // una ventana — marco con su barra de titulo — con el mas adentro: otra igual
  newWindow: 'M3.5 5.5h17v13h-17z M3.5 9h17 M12 11.5v4.5 M9.75 13.75h4.5',
  save: 'M5.5 4.5h10l4 4v11h-14z M8.5 4.5v5h6v-5 M8 19.5v-5h8v5',
  open: 'M3.5 6.5h5l2 2.5h9.5v10h-16.5z',
  exportImage: 'M12 15.5V3.5 M8 7.5l4-4 4 4 M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15',
  // hoja con esquina doblada y una flecha hacia adentro: sale un documento, no una imagen
  exportPdf: 'M6.5 3.5h7l5 5v12h-12z M13.5 3.5v5h5 M12 10.5v6 M9.5 14l2.5 2.5 2.5-2.5',
  image: 'M3.5 4.5h17v15h-17z M8.5 11.2a1.85 1.85 0 1 0 0-3.7 1.85 1.85 0 0 0 0 3.7z M4 17l5-5 3.5 3.5 3-2.5 4.5 4',
  clipboard: 'M9 4.5H7A1.5 1.5 0 0 0 5.5 6v13A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 17 4.5h-2 M9 3h6v3.5H9z',
  clear: 'M4.5 4.5h15v15h-15z M9 9l6 6 M15 9l-6 6',
  flipH: 'M12 3v18 M8.5 7.5L4.5 12l4 4.5 M15.5 7.5l4 4.5-4 4.5',
  resize: 'M3.5 3.5h17v17h-17z M14 10h6.5 M14 10V3.5',
  // las dos orientaciones: la misma hoja, dada vuelta
  portrait: 'M6.5 3.5h11v17h-11z',
  landscape: 'M3.5 6.5h17v11h-17z',
  alert: 'M12 4.5L21 20H3z M12 10.5v4 M12 17.3h.01',
  // baja algo a la maquina; el de exportar sale al reves y no son lo mismo
  download: 'M12 3.5v11.5 M7.5 10.5l4.5 4.5 4.5-4.5 M4 20.5h16',
  // flecha que da la vuelta: reiniciar para aplicar
  restart: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1 M20.5 3.5V9h-5.5',

  // ── controles de ventana ────────────────────────────────────────────────
  winMin: 'M4 12h16',
  winMax: 'M4.5 4.5h15v15h-15z',
  winRestore: 'M7.5 7.5h12v12h-12z M4.5 16.5V4.5h12',
  winClose: 'M5 5l14 14 M19 5L5 19',
};

/* Devuelve un <svg> nuevo. Hereda color por currentColor, asi que el mismo
 * icono sirve en cualquier estado sin duplicarlo. */
export function icon(name, size = 18) {
  const d = ICONS[name];
  if (!d) {
    console.warn(`[icons] no existe "${name}"`);
    return document.createDocumentFragment();
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

/* Rellena todo [data-icon] de un subarbol. Deja el markup declarativo:
 * <button data-icon="brush" data-size="18"> y listo. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    const size = Number(el.dataset.size) || 18;
    el.replaceChildren(icon(name, size));
    // marcado para no re-hidratar en un segundo pase
    delete el.dataset.icon;
    el.dataset.iconDone = name;
  }
}
