/* Relleno por region (flood fill).
 *
 * Scanline con pila explicita, no recursion. Un flood fill recursivo sobre un
 * lienzo de 1920x1200 desborda la pila de JavaScript en cuanto la region es
 * grande — son mas de dos millones de llamadas anidadas en el peor caso. La
 * version por lineas recorre cada tramo horizontal completo de una vez y solo
 * apila los tramos vecinos, asi que la pila queda en el orden de la cantidad de
 * tramos, no de pixeles.
 *
 * La muestra se toma del canvas COMPUESTO pero se pinta en la capa activa. Es lo
 * que uno espera: rellenas dentro de las lineas que ves, aunque esas lineas
 * vivan en otra capa. */

/* Compara dos pixeles con tolerancia. La distancia incluye el alpha porque si no
 * el relleno se escaparia por las zonas transparentes tratandolas como iguales a
 * cualquier color. */
function near(data, i, r, g, b, a, tol) {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  const da = data[i + 3] - a;
  return (dr * dr + dg * dg + db * db + da * da) <= tol;
}

/* Rellena la region conectada que contiene (sx, sy).
 *
 * sample: canvas de donde leer los limites (normalmente el compuesto)
 * target: capa donde pintar
 * Devuelve el bbox afectado, o null si no se toco nada. */
export function floodFill({ sample, target, x: sx, y: sy, color, tolerance = 0.15, contiguous = true }) {
  const w = sample.width;
  const h = sample.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

  const src = sample.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;

  const si = (sy * w + sx) * 4;
  const r0 = src[si], g0 = src[si + 1], b0 = src[si + 2], a0 = src[si + 3];

  // la tolerancia entra 0..1 y se usa como distancia al cuadrado sobre 4 canales
  const tol = (tolerance * 255) * (tolerance * 255) * 4;

  const mask = new Uint8Array(w * h);
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  let touched = 0;

  if (!contiguous) {
    // modo global: pinta todo pixel parecido, conectado o no
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (near(src, p, r0, g0, b0, a0, tol)) {
        mask[i] = 1;
        touched++;
        const y = (i / w) | 0, x = i - y * w;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  } else {
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      const row = y * w;
      if (mask[row + x]) continue;

      // extender el tramo hacia la izquierda y la derecha
      let left = x;
      while (left > 0 && !mask[row + left - 1] && near(src, (row + left - 1) * 4, r0, g0, b0, a0, tol)) left--;
      let right = x;
      while (right < w - 1 && !mask[row + right + 1] && near(src, (row + right + 1) * 4, r0, g0, b0, a0, tol)) right++;

      for (let i = left; i <= right; i++) {
        mask[row + i] = 1;
        touched++;
      }
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      /* Apilar solo un punto por tramo vecino contiguo, no cada pixel: es lo que
       * mantiene la pila chica. */
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let i = left;
        while (i <= right) {
          if (!mask[nrow + i] && near(src, (nrow + i) * 4, r0, g0, b0, a0, tol)) {
            stack.push(i, ny);
            // saltar el resto de este tramo vecino: ya quedo representado
            while (i <= right && near(src, (nrow + i) * 4, r0, g0, b0, a0, tol)) i++;
          } else i++;
        }
      }
    }
  }

  if (!touched) return null;

  const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  /* Se pinta a traves de un canvas intermedio del tamano del bbox y se compone
   * con drawImage, en vez de escribir con putImageData sobre la capa: putImageData
   * REEMPLAZA los pixeles y borraria lo que hubiera debajo dentro del bbox pero
   * fuera de la region rellenada. */
  const patch = document.createElement('canvas');
  patch.width = rect.w;
  patch.height = rect.h;
  const pctx = patch.getContext('2d');
  const pimg = pctx.createImageData(rect.w, rect.h);
  const pd = pimg.data;

  const cr = parseInt(color.slice(1, 3), 16);
  const cg = parseInt(color.slice(3, 5), 16);
  const cb = parseInt(color.slice(5, 7), 16);

  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[(y + rect.y) * w + (x + rect.x)]) continue;
      const p = (y * rect.w + x) * 4;
      pd[p] = cr; pd[p + 1] = cg; pd[p + 2] = cb; pd[p + 3] = 255;
    }
  }
  pctx.putImageData(pimg, 0, 0);

  target.ctx.drawImage(patch, rect.x, rect.y);
  target.rev++;

  return rect;
}
