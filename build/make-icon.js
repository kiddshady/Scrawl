'use strict';
/**
 * Regenera el icono de Scrawl desde la curva de la marca.
 *
 *   npm run icons
 *
 * Se renderiza a traves de Chromium para que el resultado sea identico a lo que
 * dibuja la app. La forma NO se redibuja a mano: se muestrea el mismo path SVG
 * que usan la titlebar y el splash (getPointAtLength sobre un <path> real), asi
 * que marca e icono no pueden divergir.
 *
 * El trazo se rasteriza con ancho variable igual que un trazo del motor: fino en
 * las puntas, grueso en el medio. El icono es, literalmente, una pincelada de la
 * app.
 *
 * Salen dos archivos:
 *   icon.png  el master de 1024, del que npm run icons saca icon.ico
 *   tray.ico  el de la bandeja: el mismo dibujo, rasterizado a cada tamano real
 *             (16/20/24/32 = 100/125/150/200 % de escala de Windows). No se
 *             achica el master: a 16 px su trazo queda en medio pixel y la
 *             pincelada se lee como una mancha gris. Ver traySpec mas abajo.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const TRAY_SIZES = [16, 20, 24, 32];

// misma d que renderer/js/ui/icons.js -> ICONS.mark y el splash de index.html
const MARK = 'M3 16C4.5 9 7.5 20 9.5 13S14 17 16 10.5 19.5 9 21 7';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
  canvas{display:block}
  svg{position:absolute;width:0;height:0;visibility:hidden}
</style></head><body>
<svg viewBox="0 0 24 24"><path id="mark" d="${MARK}"/></svg>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script>
/* S       lado del lienzo, en pixeles reales
 * span    cuanto ocupa el dibujo de punta a punta
 * floor   radio minimo del trazo, en pixeles reales (0 = sin piso)
 * shadow  la elevacion del trazo; a tamano de bandeja es solo barro */
function draw(c, S, { span, floor, shadow }) {
  // ── fondo ──
  // gris neutro puro, como el chrome de la app: el icono tambien evita el tinte
  const bg = c.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#242424');
  bg.addColorStop(1, '#0e0e0e');
  const R = 232 * (S / 1024);
  c.beginPath();
  c.roundRect(0, 0, S, S, R);
  c.fillStyle = bg;
  c.fill();

  // ── muestreo de la curva de la marca ──
  const p = document.getElementById('mark');
  const L = p.getTotalLength();
  const N = 480;
  const raw = [];
  for (let i = 0; i <= N; i++) {
    const q = p.getPointAtLength((L * i) / N);
    raw.push({ x: q.x, y: q.y, t: i / N });
  }

  // encuadre: se calcula del bbox real en vez de asumir el viewBox, porque el
  // trazo no llena los 24x24 y quedaria descentrado
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of raw) {
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  }
  const bw = x1 - x0, bh = y1 - y0;
  const target = S * span;
  const k = Math.min(target / bw, target / bh);
  const offX = (S - bw * k) / 2 - x0 * k;
  const offY = (S - bh * k) / 2 - y0 * k;
  const pts = raw.map((q) => ({ x: q.x * k + offX, y: q.y * k + offY, t: q.t }));

  // ── ancho variable: la misma campana de presion del preview del pincel ──
  const BASE = S * 0.042;
  const radius = (t) => Math.max(floor, BASE * (0.30 + 0.70 * Math.pow(Math.sin(Math.PI * t), 0.62)));

  /* Se rasteriza segmento por segmento — trapecio mas las dos puntas en un mismo
   * path, igual que el motor — y NO como un contorno offseteado de punta a
   * punta. El contorno parece mas elegante pero se auto-interseca en cuanto el
   * grosor del trazo supera el radio de curvatura, y con winding nonzero esas
   * intersecciones se cancelan y abren agujeros en las curvas cerradas. Por
   * segmentos no puede pasar: cada uno es convexo. */
  const shape = document.createElement('canvas');
  shape.width = S; shape.height = S;
  const s = shape.getContext('2d');

  const stroke = s.createLinearGradient(0, S * 0.2, 0, S * 0.8);
  stroke.addColorStop(0, '#f0b862');
  stroke.addColorStop(1, '#d08a34');
  s.fillStyle = stroke;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const r0 = radius(a.t), r1 = radius(b.t);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    s.beginPath();
    if (len < 1e-4) {
      s.arc(b.x, b.y, r1, 0, Math.PI * 2);
    } else {
      const nx = -dy / len, ny = dx / len;
      s.moveTo(a.x + nx * r0, a.y + ny * r0);
      s.lineTo(b.x + nx * r1, b.y + ny * r1);
      s.lineTo(b.x - nx * r1, b.y - ny * r1);
      s.lineTo(a.x - nx * r0, a.y - ny * r0);
      s.closePath();
      s.moveTo(a.x + r0, a.y);
      s.arc(a.x, a.y, r0, 0, Math.PI * 2);
      s.moveTo(b.x + r1, b.y);
      s.arc(b.x, b.y, r1, 0, Math.PI * 2);
    }
    s.fill();
  }

  /* La silueta ya terminada se compone de una sola vez con la sombra. Si se
   * dibujara cada segmento con sombra activada, los cientos de sombras
   * superpuestas darian una mancha negra en vez de una elevacion suave. */
  c.save();
  if (shadow) {
    c.shadowColor = 'rgba(0,0,0,.55)';
    c.shadowBlur = S * 0.04;
    c.shadowOffsetY = S * 0.014;
  }
  c.drawImage(shape, 0, 0);
  c.restore();
}

draw(document.getElementById('c').getContext('2d'), ${SIZE}, { span: 0.62, floor: 0, shadow: true });

/* La bandeja: el mismo objeto, ajustado a lo chico. El dibujo crece al 68 % del
 * lienzo y el trazo lleva un piso de ~1.2 px de ancho en pixeles reales — sin
 * eso, a 16 px las puntas quedan en 0.4 px y la curva se corta en pedazos. Se
 * exporta con toDataURL y no con una captura de la ventana: una captura sale
 * escalada por el DPI del monitor, y aca cada pixel tiene que ser uno. */
window.__tray = ${JSON.stringify(TRAY_SIZES)}.map((S) => {
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  draw(cv.getContext('2d'), S, { span: 0.68, floor: 0.6, shadow: false });
  return { size: S, png: cv.toDataURL('image/png') };
});

window.__ready = true;
</script>
</body></html>`;

/* Un .ico es una cabecera, una entrada de 16 bytes por tamano y los PNG pegados
 * atras. Windows acepta PNG adentro del .ico desde Vista, asi que no hace falta
 * pasar por BMP ni por ImageMagick. */
function packIco(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);                 // 1 = icono
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);              // sin paleta
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);           // planos
    head.writeUInt16LE(32, e + 6);          // bits por pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 400));   // margen para que Chromium pinte la sombra
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  process.stdout.write(`wrote ${out} (${img.getSize().width}x${img.getSize().height})\n`);

  const tray = await win.webContents.executeJavaScript('window.__tray');
  const frames = tray.map(({ size, png }) => ({
    size, data: Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'),
  }));
  const trayOut = path.join(__dirname, 'tray.ico');
  fs.writeFileSync(trayOut, packIco(frames));
  process.stdout.write(`wrote ${trayOut} (${TRAY_SIZES.join('/')})\n`);

  win.destroy();
  app.quit();
});
