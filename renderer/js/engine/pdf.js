/* Escritor de PDF, a mano.
 *
 * Un PDF de una pagina con una imagen adentro es un archivo chico y enteramente
 * descriptible: seis objetos, una tabla de posiciones y un trailer. Meter una
 * libreria (jsPDF, pdf-lib) por esto seria la primera dependencia de runtime del
 * proyecto — unos cientos de KB empaquetados — para escribir las dos pantallas de
 * bytes que hay aca abajo.
 *
 * Los pixeles van sin perdida: DEFLATE sobre el RGB crudo, la misma compresion
 * que usa un PNG. El canal alfa, cuando el dibujo tiene alguno, viaja aparte como
 * /SMask — un segundo objeto imagen en escala de grises que el visor aplica como
 * mascara — porque un stream de imagen de PDF no sabe guardar RGBA junto. */

/* La pagina mide lo que mide la imagen a la densidad del documento: 2480 px a
 * 300 DPI son 8.27 pulgadas, o sea el ancho de una A4. Un lienzo sin tamano de
 * impresion queda en los 96 DPI con los que Windows y el navegador miden todo,
 * asi que sale del tamano al que estabas viendo el dibujo al 100%.
 *
 * El PDF mide en puntos (1/72"), de ahi las dos conversiones. */
const PT_PER_IN = 72;
const MM_PER_IN = 25.4;

const enc = new TextEncoder();

/* Acumulador de bytes que lleva la cuenta del largo. La cuenta no es comodidad:
 * la tabla xref del final es una lista de posiciones absolutas en bytes, y una
 * sola mal contada hace que el archivo no abra en ningun visor. */
class Bytes {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(part) {
    // los strings del PDF son ASCII; los streams, binario crudo
    const b = typeof part === 'string' ? enc.encode(part) : part;
    this.chunks.push(b);
    this.length += b.length;
    return this;
  }

  join() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/* DEFLATE por la API del navegador. El modo 'deflate' entrega un stream zlib, que
 * es exactamente lo que espera el filtro /FlateDecode del PDF. */
async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Separa un canal (RGB o alfa) del buffer RGBA y le aplica el filtro PNG "Up":
 * cada byte se guarda como su diferencia con el de la fila de arriba.
 *
 * Suena a poco y cambia el peso del archivo por completo. En una captura de
 * pantalla o un degradado las filas contiguas son casi identicas, asi que las
 * diferencias dan casi todas cero y DEFLATE las aplasta; sin el filtro, exportar
 * una captura da un PDF varias veces mas pesado. El PDF lo deshace solo si se lo
 * declara con /Predictor 15 y el mismo ancho de fila, y el 2 que abre cada fila es
 * la etiqueta de PNG que dice "esta fila viene con Up". */
function filterRows(rgba, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let at = 0;

  for (let y = 0; y < height; y++) {
    const base = y * width * 4;
    if (channels === 3) {
      for (let x = 0; x < width; x++) {
        const s = base + x * 4;
        const d = x * 3;
        cur[d] = rgba[s];
        cur[d + 1] = rgba[s + 1];
        cur[d + 2] = rgba[s + 2];
      }
    } else {
      for (let x = 0; x < width; x++) cur[x] = rgba[base + x * 4 + 3];
    }

    out[at++] = 2;
    for (let i = 0; i < stride; i++) out[at++] = (cur[i] - prev[i]) & 0xff;
    prev.set(cur);
  }

  return out;
}

// PDF quiere la fecha en su propio formato: D:AAAAMMDDHHMMSS
function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* Recibe un ImageData (o cualquier cosa con width/height/data en RGBA) y devuelve
 * los bytes de un PDF de una sola pagina con esa imagen a tamano completo.
 *
 *   dpi     densidad del documento: cuantos de esos pixeles entran en una pulgada
 *           de papel.
 *   pageMm  [ancho, alto] en milimetros para forzar la medida EXACTA de la hoja.
 *           Va cuando el lienzo se armo sobre un papel concreto, y existe por el
 *           redondeo: una A4 a 300 DPI son 2480 px, que vueltos a puntos dan
 *           595.2 en vez de los 595.28 de la norma. La diferencia es de tres
 *           centesimas de milimetro y ningun ojo la ve, pero es la diferencia
 *           entre que el visor anuncie "A4" y que anuncie "personalizado", y de
 *           ahi que la impresora ofrezca ajustar a la hoja. La imagen se estira
 *           esas tres centesimas para llenarla. */
export async function buildPDF(image, { dpi = 96, pageMm = null } = {}) {
  const { width, height } = image;
  const rgba = image.data;

  /* El /SMask solo se escribe si hace falta: un dibujo sin transparencia no tiene
   * por que cargar con un segundo stream del tamano de la imagen. */
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { opaque = false; break; }
  }

  const rgb = await deflate(filterRows(rgba, width, height, 3));
  const alpha = opaque ? null : await deflate(filterRows(rgba, width, height, 1));

  // dos decimales alcanzan: es 1/3600 de pulgada
  const pw = Number((pageMm ? (pageMm[0] / MM_PER_IN) * PT_PER_IN : (width / dpi) * PT_PER_IN).toFixed(2));
  const ph = Number((pageMm ? (pageMm[1] / MM_PER_IN) * PT_PER_IN : (height / dpi) * PT_PER_IN).toFixed(2));

  /* El contenido de la pagina entero: la matriz 'cm' estira la imagen (que en PDF
   * siempre mide 1x1) hasta cubrir la pagina, y 'Do' la pinta. */
  const content = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q\n`);

  const parms = (colors) => '/DecodeParms << /Predictor 15 '
    + `/Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`;

  const IMG = 5;
  const SMASK = 6;
  const INFO = alpha ? 7 : 6;

  // el indice en este arreglo + 1 es el numero de objeto
  const objs = [
    { head: '<< /Type /Catalog /Pages 2 0 R >>' },
    { head: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      head: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] `
        + `/Resources << /XObject << /Im0 ${IMG} 0 R >> >> /Contents 4 0 R >>`,
    },
    { head: `<< /Length ${content.length} >>`, stream: content },
    {
      head: '<< /Type /XObject /Subtype /Image '
        + `/Width ${width} /Height ${height} /ColorSpace /DeviceRGB `
        + `/BitsPerComponent 8 /Filter /FlateDecode ${parms(3)} `
        + (alpha ? `/SMask ${SMASK} 0 R ` : '')
        + `/Length ${rgb.length} >>`,
      stream: rgb,
    },
  ];

  if (alpha) {
    objs.push({
      head: '<< /Type /XObject /Subtype /Image '
        + `/Width ${width} /Height ${height} /ColorSpace /DeviceGray `
        + `/BitsPerComponent 8 /Filter /FlateDecode ${parms(1)} `
        + `/Length ${alpha.length} >>`,
      stream: alpha,
    });
  }

  objs.push({ head: `<< /Producer (Scrawl) /CreationDate (${pdfDate()}) >>` });

  const out = new Bytes();
  out.push('%PDF-1.4\n');
  /* Un comentario con bytes altos en la segunda linea. Es la senal convenida para
   * que cualquier cosa que mueva el archivo lo trate como binario y no le ande
   * "arreglando" los saltos de linea, que romperia los streams. */
  out.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out.push(`${i + 1} 0 obj\n${o.head}\n`);
    if (o.stream) out.push('stream\n').push(o.stream).push('\nendstream\n');
    out.push('endobj\n');
  });

  /* La tabla xref: una linea por objeto con su posicion, todas de exactamente 20
   * bytes de ancho (por eso el relleno con ceros y el espacio antes del salto),
   * porque el visor la lee por aritmetica y no parseando. */
  const xrefAt = out.length;
  out.push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) out.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  out.push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${INFO} 0 R >>\n`);
  out.push(`startxref\n${xrefAt}\n%%EOF\n`);

  return out.join();
}
