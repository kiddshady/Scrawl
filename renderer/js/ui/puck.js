/* Puck de navegacion.
 *
 * Con la barra espaciadora apretada aparece un disco bajo el puntero: apoyar en
 * el nucleo hace zoom, apoyar en el anillo — o en cualquier otro lado — desplaza.
 * Es el gesto de Sketchbook, y con tablet vale la pena porque deja las dos
 * navegaciones bajo la misma mano: cuando estas dibujando con el lapiz, la rueda
 * del mouse esta a un brazo de distancia y soltar el lapiz para alcanzarla te
 * corta el trazo mental.
 *
 * ── El puck no recibe eventos ───────────────────────────────────────────────
 * Va con pointer-events:none y el reparto entre zonas es aritmetica sobre su
 * ancla: distancia al centro. Podria hacerse con dos elementos que escuchen sus
 * propios pointerdown, pero entonces habria que pelear con la captura de puntero
 * del lienzo — la que sostiene el gesto cuando el lapiz se sale del canvas a
 * mitad de un arrastre — y el puck se quedaria con eventos que el lienzo
 * necesita. Siendo puro afiche, el lienzo sigue siendo el unico que escucha.
 *
 * ── Por que se queda quieto ─────────────────────────────────────────────────
 * El disco se ancla donde la barra lo dejo y no sigue al puntero. Si siguiera,
 * el puntero estaria siempre en el centro y no habria manera de apuntarle al
 * anillo: las dos zonas dejarian de significar nada. Para moverlo se suelta y se
 * vuelve a apretar la barra, que es un toque de la mano que ya esta ahi. */

import { el } from './controls.js';

const R_OUT = 54;               // borde exterior del disco
const R_IN = 24;                // borde del nucleo: la zona de zoom
const PAD = 2;                  // aire para el hairline y el antialias
const BOX = R_OUT + PAD;        // medio lado del lienzo del svg

const NS = 'http://www.w3.org/2000/svg';

function node(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/* Todo el disco es un solo SVG, con las mismas convenciones que icons.js (trazo
 * de 2, puntas redondeadas) para que se lea como parte del mismo set.
 *
 * El anillo se dibuja como un stroke grueso y no como un disco con otro disco
 * encima: asi el nucleo queda libre y cada zona se pinta por separado. Con
 * superficies translucidas, un disco debajo del otro sumaria opacidades y el
 * centro saldria mas oscuro que el borde sin que nadie lo haya pedido. */
function buildArt() {
  const art = node('svg', {
    class: 'sc-puck__art',
    width: BOX * 2,
    height: BOX * 2,
    viewBox: `${-BOX} ${-BOX} ${BOX * 2} ${BOX * 2}`,
  });

  art.append(
    node('circle', {
      class: 'sc-puck__ring',
      r: (R_OUT + R_IN) / 2,
      'stroke-width': R_OUT - R_IN,
    }),
    node('circle', { class: 'sc-puck__core', r: R_IN }),
    // hairlines: el de afuera cierra el disco, el de adentro es el limite entre
    // las dos zonas — el unico borde que hay que poder leer de un vistazo
    node('circle', { class: 'sc-puck__edge', r: R_OUT - 0.5 }),
    node('circle', { class: 'sc-puck__edge', r: R_IN }),
  );

  /* Radios en las diagonales: parten el anillo en cuatro y le dan al disco
   * lectura de instrumento en vez de mancha. Se dibujan verticales y se rotan,
   * que sale mas claro que calcular senos a mano. */
  for (const a of [45, 135, 225, 315]) {
    art.append(node('line', {
      class: 'sc-puck__spoke',
      x1: 0, y1: -(R_IN + 3),
      x2: 0, y2: -(R_OUT - 3),
      transform: `rotate(${a})`,
    }));
  }

  // cuatro puntas hacia afuera, una por cuadrante: el simbolo de desplazar
  const mid = (R_OUT + R_IN) / 2;
  for (const a of [0, 90, 180, 270]) {
    art.append(node('path', {
      class: 'sc-puck__glyph sc-puck__arrow',
      d: `M-5.5 ${-(mid - 4.5)}L0 ${-(mid + 4.5)}L5.5 ${-(mid - 4.5)}`,
      transform: `rotate(${a})`,
    }));
  }

  // lupa en el nucleo: el simbolo de zoom
  art.append(
    node('circle', { class: 'sc-puck__glyph sc-puck__lens', cx: 2.5, cy: -2.5, r: 7 }),
    node('path', { class: 'sc-puck__glyph sc-puck__lens', d: 'M-2.4 2.4L-8.8 8.8' }),
  );

  return art;
}

/* Monta el disco dentro del contenedor del lienzo y devuelve el control.
 *
 * Las coordenadas que entran y salen son px CSS relativos a ese contenedor, que
 * es el mismo sistema en el que StrokeInput entrega los puntos: el canvas ocupa
 * el contenedor entero. */
export function initPuck(parent) {
  const host = el('div', 'sc-puck');
  // el vidrio va aparte del svg porque backdrop-filter es de elementos, no de
  // formas svg: es un circulo de css puesto justo debajo del dibujo
  host.append(el('div', 'sc-puck__glass'), buildArt());
  parent.append(host);

  let visible = false;
  let cx = 0;
  let cy = 0;

  return {
    get visible() { return visible; },
    get x() { return cx; },
    get y() { return cy; },

    show(x, y) {
      cx = x;
      cy = y;
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      visible = true;
      host.classList.add('show');
    },

    hide() {
      visible = false;
      host.classList.remove('show');
      host.dataset.hover = '';
      host.dataset.active = '';
    },

    /* 'core' | 'ring' | null. El null es "fuera del disco", que para quien
     * pregunta significa lo mismo que el anillo (desplaza) pero se distingue
     * porque el resaltado no tiene a quien iluminar. */
    zoneAt(x, y) {
      if (!visible) return null;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R_IN) return 'core';
      if (d <= R_OUT) return 'ring';
      return null;
    },

    setHover(zone) { host.dataset.hover = zone || ''; },
    setActive(zone) { host.dataset.active = zone || ''; },
  };
}
