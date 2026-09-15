/* Seleccion rectangular sobre una capa.
 *
 * La geometria vive en coordenadas del documento y se lleva a pixeles enteros
 * hacia afuera: si el gesto roza aunque sea una fraccion de pixel, ese pixel
 * forma parte de la seleccion. Copiar y borrar comparten exactamente ese rect,
 * asi no aparece el clasico borde de un pixel que se copia pero no se corta. */

import { clampRect, makeCanvas } from './doc.js';

export function selectionRect(from, to, docW, docH) {
  const raw = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
  };
  const rect = clampRect(raw, docW, docH);
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

/* Un rect transparente no es un fragmento util. Mirar solo alfa conserva hasta
 * el residuo tenue de un aerografo, igual que layerBounds(). */
export function selectionHasPixels(layer, rect) {
  if (!layer || !rect) return false;
  const data = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
  return false;
}

export function copySelectionPixels(layer, rect) {
  const crop = makeCanvas(rect.w, rect.h);
  crop.getContext('2d').drawImage(
    layer.canvas,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, rect.w, rect.h,
  );
  return crop;
}

export function eraseSelectionPixels(layer, rect) {
  layer.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
  layer.rev++;
}
