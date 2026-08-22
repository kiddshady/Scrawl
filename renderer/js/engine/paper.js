/* Tamanos de papel y resolucion de impresion.
 *
 * Un lienzo pensado para imprimir son DOS numeros, no uno: los milimetros de la
 * hoja y los pixeles por pulgada con los que se rellena. La misma A4 son
 * 794x1123 px a 96 DPI o 2480x3508 a 300; lo que no cambia es cuanto mide al
 * salir de la impresora, y eso es lo unico que importa cuando uno dibuja para
 * imprimir.
 *
 * Por eso el DPI viaja con el documento y no con el dialogo: es lo que el
 * exportador de PDF necesita para escribir una pagina del tamano fisico
 * correcto. Sin el, una A4 a 300 DPI saldria como una pagina de 66x93 cm — la
 * imagen medida a los 96 DPI de la pantalla — y habria que reescalarla a mano al
 * imprimir, que es exactamente lo que este modulo existe para evitar. */

export const MM_PER_IN = 25.4;

/* Milimetros [lado corto, lado largo]. Vertical es como estan listados; el
 * horizontal es el mismo papel con los lados dados vuelta. Las medidas en
 * pulgadas (Letter y companía) se guardan igual en mm y salen exactas, porque
 * 25.4 divide sin resto: 215.9 mm son 8.5" clavadas. */
export const PAPERS = [
  { id: 'a3',      name: 'A3',      mm: [297, 420] },
  { id: 'a4',      name: 'A4',      mm: [210, 297] },
  { id: 'a5',      name: 'A5',      mm: [148, 210] },
  { id: 'a6',      name: 'A6',      mm: [105, 148] },
  { id: 'b5',      name: 'B5',      mm: [176, 250] },
  { id: 'letter',  name: 'Letter',  mm: [215.9, 279.4] },
  { id: 'legal',   name: 'Legal',   mm: [215.9, 355.6] },
  { id: 'tabloid', name: 'Tabloid', mm: [279.4, 431.8] },
];

/* Las cuatro densidades que se usan de verdad: las dos de pantalla (72 es el
 * punto tipografico, 96 es con lo que Windows mide todo) y las dos de papel
 * (150 alcanza para un borrador, 300 es calidad de imprenta). Mas arriba de 300
 * el archivo se duplica de peso sin que el ojo note la diferencia. */
export const DPIS = [72, 96, 150, 300];

/* Tope de lado. Chromium no garantiza un canvas mas grande que esto en GPU: al
 * pasarse deja de dibujar y devuelve un lienzo en blanco, sin avisar. */
export const MAX_SIDE = 16384;

export function paperById(id) { return PAPERS.find((p) => p.id === id) || null; }

export function mmToPx(mm, dpi) { return Math.round((mm / MM_PER_IN) * dpi); }
export function pxToMm(px, dpi) { return (px / dpi) * MM_PER_IN; }

export function paperMm(id, orientation = 'portrait') {
  const p = paperById(id);
  if (!p) return null;
  const [short, long] = p.mm;
  return orientation === 'landscape' ? [long, short] : [short, long];
}

/* Pixeles de un papel a una densidad dada. A4 a 300 da 2480x3508, que es la
 * medida que devuelve cualquier otra herramienta: la coincidencia no es casual,
 * sale de redondear los mismos milimetros. */
export function paperPixels(id, orientation, dpi) {
  const mm = paperMm(id, orientation);
  if (!mm) return null;
  return { w: mmToPx(mm[0], dpi), h: mmToPx(mm[1], dpi) };
}

/* Que papel es un lienzo de wxh a dpi, si es alguno.
 *
 * Compara contra los PIXELES calculados y no contra los milimetros: 2480 px a
 * 300 DPI son 209.97 mm, no 210, asi que ir de vuelta a milimetros y comparar
 * contra la tabla no reconoceria como A4 al lienzo que este mismo modulo acaba
 * de generar. Redondear una sola vez, del lado de los pixeles, cierra el
 * circulo. */
export function matchPaper(w, h, dpi) {
  for (const p of PAPERS) {
    for (const orientation of ['portrait', 'landscape']) {
      const px = paperPixels(p.id, orientation, dpi);
      if (px.w === w && px.h === h) return { id: p.id, name: p.name, orientation };
    }
  }
  return null;
}

/* "210 × 297 mm" — la medida fisica de un lienzo en pixeles. Un decimal: por
 * debajo de eso el numero deja de significar nada en una hoja. */
export function formatMm(w, h, dpi) {
  const r = (v) => String(Math.round(v * 10) / 10);
  return `${r(pxToMm(w, dpi))} × ${r(pxToMm(h, dpi))} mm`;
}
