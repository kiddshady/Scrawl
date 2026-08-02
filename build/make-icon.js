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
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;

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
(() => {
  const S = ${SIZE};
  const c = document.getElementById('c').getContext('2d');

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
  const target = S * 0.62;
  const k = Math.min(target / bw, target / bh);
  const offX = (S - bw * k) / 2 - x0 * k;
  const offY = (S - bh * k) / 2 - y0 * k;
  const pts = raw.map((q) => ({ x: q.x * k + offX, y: q.y * k + offY, t: q.t }));

  // ── ancho variable: la misma campana de presion del preview del pincel ──
  const BASE = S * 0.042;
  const radius = (t) => BASE * (0.30 + 0.70 * Math.pow(Math.sin(Math.PI * t), 0.62));

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
  c.shadowColor = 'rgba(0,0,0,.55)';
  c.shadowBlur = S * 0.04;
  c.shadowOffsetY = S * 0.014;
  c.drawImage(shape, 0, 0);
  c.restore();

  window.__ready = true;
})();
</script>
</body></html>`;

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
  win.destroy();
  process.stdout.write(`wrote ${out} (${img.getSize().width}x${img.getSize().height})\n`);
  app.quit();
});
