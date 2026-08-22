/* Dialogo de tamano del lienzo.
 *
 * Existe para una sola frase: "quiero dibujar sabiendo que esto es una A4 y que
 * al imprimirlo no voy a tener que reajustar nada". Eso son tres decisiones que
 * el dialogo junta en una:
 *
 *   el papel      de donde salen los milimetros
 *   la densidad   cuantos pixeles entran en cada pulgada de esos milimetros
 *   el contenido  que pasa con lo que ya estaba dibujado
 *
 * Las dos primeras dan los pixeles del lienzo; las tres viajan con el documento
 * y son las que despues hacen que el PDF salga del tamano exacto de la hoja.
 *
 * Ancho y alto NO son un cuarto ajuste independiente: son la misma medida vista
 * en la otra unidad. Tocarlos pasa el preset a Custom, porque una A4 de 2000 px
 * de ancho no es una A4. */

import { openModal } from './modal.js';
import { el, makeSelect, makeSegment } from './controls.js';
import { icon } from './icons.js';
import { PAPERS, DPIS, MAX_SIDE, paperPixels, formatMm } from '../engine/paper.js';

/* Los nueve anclajes, en la grilla en la que se eligen. Cada uno dice donde
 * queda el dibujo actual dentro del lienzo nuevo. */
const ANCHOR_GRID = [
  ['nw', 'n', 'ne'],
  ['w',  'c', 'e'],
  ['sw', 's', 'se'],
];

const ANCHOR_NAME = {
  nw: 'top left',    n: 'top',    ne: 'top right',
  w:  'left',        c: 'center', e:  'right',
  sw: 'bottom left', s: 'bottom', se: 'bottom right',
};

/* A partir de aca conviene avisar: son ~160 MB de RAM por capa, y el paso de
 * historial se queda con una copia del lienzo anterior. */
const HEAVY_MP = 40;

export function openCanvasSize({ doc, onApply }) {
  const state = {
    preset: doc.paper?.id ?? 'custom',
    orientation: doc.paper?.orientation ?? (doc.width > doc.height ? 'landscape' : 'portrait'),
    dpi: doc.dpi,
    w: doc.width,
    h: doc.height,
    anchor: 'c',
    scale: false,
  };

  /* Elegir un papel por primera vez sube la densidad a 300 si el documento
   * todavia esta en los 96 de pantalla. No es magia escondida: el campo de
   * resolucion cambia a la vista y con el los pixeles, y se puede volver a bajar.
   * Es un default, y el correcto — una A4 a 96 DPI da 794 px de ancho, que
   * impresa se ve blanda, y nadie que pide "tamano A4" esta pidiendo eso. Pasa
   * una sola vez: si despues la bajas a mano, cambiar de papel la respeta. */
  let bumped = false;

  const modal = openModal({
    title: 'Canvas Size',
    iconName: 'resize',
    width: 372,
    onEnter: () => apply(),
    onClose: () => { preset.destroy(); dpi.destroy(); },
  });

  // ── campos ────────────────────────────────────────────────────────────────

  const presetHost = el('div');
  const preset = makeSelect(presetHost, {
    options: [{ id: 'custom', name: 'Custom' }, ...PAPERS.map((p) => ({ id: p.id, name: p.name }))],
    value: state.preset,
    tip: 'Paper the canvas is measured against',
    onChange: (id) => {
      state.preset = id;
      if (id !== 'custom' && state.dpi === 96 && !bumped) {
        bumped = true;
        state.dpi = 300;
        dpi.set(300);
      }
      sync();
    },
  });

  const orientation = makeSegment({
    options: [
      { id: 'portrait', name: 'Portrait', iconName: 'portrait' },
      { id: 'landscape', name: 'Landscape', iconName: 'landscape' },
    ],
    value: state.orientation,
    onChange: (o) => {
      state.orientation = o;
      // en Custom no hay papel del que sacar medidas: la orientacion es,
      // literalmente, dar vuelta la hoja
      if (state.preset === 'custom') [state.w, state.h] = [state.h, state.w];
      sync();
    },
  });

  const dpiHost = el('div');
  const dpi = makeSelect(dpiHost, {
    options: DPIS.map((d) => ({ id: d, name: `${d} DPI` })),
    value: state.dpi,
    tip: 'Pixels per inch of paper — 300 is print quality',
    onChange: (d) => {
      /* Con un papel elegido, la densidad reescribe los pixeles: la hoja sigue
       * midiendo lo mismo y se rellena mas fina o mas gruesa. En Custom no mueve
       * nada — los pixeles son los que son, y el DPI solo dice cuanto miden. */
      state.dpi = d;
      sync();
    },
  });

  const width = numberField('Width', () => state.w, (v) => setSize('w', v));
  const height = numberField('Height', () => state.h, (v) => setSize('h', v));

  const note = el('div', 'sc-modal__note');

  const anchor = buildAnchor((a) => { state.anchor = a; sync(); });

  const content = makeSegment({
    options: [{ id: 'keep', name: 'Keep size' }, { id: 'scale', name: 'Scale to fit' }],
    value: 'keep',
    tip: 'Whether the drawing keeps its pixels or is resized with the canvas',
    onChange: (m) => { state.scale = m === 'scale'; sync(); },
  });

  const contentHint = el('p', 'sc-modal__hint');

  const warn = el('div', 'sc-warn');
  const warnInner = el('div', 'sc-warn__inner');
  const warnRow = el('div', 'sc-warn__row');
  const warnText = el('span');
  warnRow.append(icon('alert', 14), warnText);
  warnInner.append(warnRow);
  warn.append(warnInner);

  modal.body.append(
    field('Preset', presetHost),
    pair(field('Orientation', orientation.el), field('Resolution', dpiHost)),
    pair(width.el, height.el),
    note,
    el('div', 'sc-modal__rule'),
    pair(anchor.el, stack(field('Existing content', content.el), contentHint), 'anchor'),
    warn,
  );

  modal.button('Cancel', 'ghost', (close) => close('cancel'));
  const applyBtn = modal.button('Apply', 'primary', () => apply());

  // ── sincronizacion ────────────────────────────────────────────────────────

  function setSize(key, v) {
    state[key] = v;
    // una medida escrita a mano ya no es un papel de la lista
    if (state.preset !== 'custom') {
      state.preset = 'custom';
      preset.set('custom');
    }
    if (state.w !== state.h) {
      state.orientation = state.w > state.h ? 'landscape' : 'portrait';
      orientation.set(state.orientation);
    }
    sync();
  }

  /* Una sola funcion repinta TODO el dialogo desde el estado. Con seis controles
   * que se afectan entre si — el papel manda sobre los pixeles, la densidad
   * tambien, los pixeles mandan sobre la orientacion — actualizar de a pares
   * seria la forma segura de que dos campos terminen contando cosas distintas. */
  function sync() {
    if (state.preset !== 'custom') {
      const px = paperPixels(state.preset, state.orientation, state.dpi);
      state.w = px.w;
      state.h = px.h;
    }
    width.sync();
    height.sync();

    const paperName = PAPERS.find((p) => p.id === state.preset)?.name;
    const measure = `${formatMm(state.w, state.h, state.dpi)} at ${state.dpi} DPI`;
    note.textContent = paperName ? `${paperName} ${state.orientation} · ${measure}` : measure;

    contentHint.textContent = state.scale
      ? `Resized to fit, sitting ${ANCHOR_NAME[state.anchor]}.`
      : `Kept at its pixel size, sitting ${ANCHOR_NAME[state.anchor]}.`;

    const mp = (state.w * state.h) / 1e6;
    const crops = !state.scale && (state.w < doc.width || state.h < doc.height);
    if (mp > HEAVY_MP) {
      showWarn(`${mp.toFixed(0)} megapixels per layer — big, and it will feel it.`);
    } else if (crops) {
      showWarn('Anything past the new edges gets cropped. Ctrl+Z brings it back.');
    } else {
      warn.classList.remove('on');
    }

    applyBtn.disabled = !changed();
  }

  function showWarn(text) {
    warnText.textContent = text;
    warn.classList.add('on');
  }

  function paperOf() {
    return state.preset === 'custom'
      ? null
      : { id: state.preset, orientation: state.orientation };
  }

  function changed() {
    return state.w !== doc.width
      || state.h !== doc.height
      || state.dpi !== doc.dpi
      || JSON.stringify(paperOf()) !== JSON.stringify(doc.paper);
  }

  function apply() {
    if (!changed()) return;
    onApply({
      w: state.w,
      h: state.h,
      dpi: state.dpi,
      paper: paperOf(),
      anchor: state.anchor,
      scale: state.scale,
    });
    modal.close('apply');
  }

  sync();
  width.input.focus();
  width.input.select();
  return modal;
}

// ── piezas ──────────────────────────────────────────────────────────────────

function field(label, control) {
  const wrap = el('div', 'sc-cell');
  wrap.append(el('span', 'sc-cell__label', { text: label }), control);
  return wrap;
}

function pair(a, b, mod = '') {
  const row = el('div', `sc-row${mod ? ` sc-row--${mod}` : ''}`);
  row.append(a, b);
  return row;
}

function stack(...nodes) {
  const wrap = el('div', 'sc-stack');
  wrap.append(...nodes);
  return wrap;
}

/* Campo numerico propio. No es <input type=number>: sus flechitas son de
 * Chromium, no se pueden estilar, y ademas el control nativo responde a la rueda
 * del mouse sin pedirlo — pasar el puntero por encima mientras se hace scroll
 * cambiaria el tamano del lienzo sin que nadie lo haya tocado. */
function numberField(label, get, set) {
  const box = el('div', 'sc-num');
  const input = el('input', null, { spellcheck: false, maxLength: 5, inputMode: 'numeric' });
  box.append(input, el('span', 'sc-num__unit', { text: 'px' }));

  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D/g, '').slice(0, 5);
    if (clean !== input.value) input.value = clean;
    const n = Number(clean);
    // vacio a mitad de escribir: el estado no se toca hasta que haya un numero
    if (!n) return;
    set(Math.min(n, MAX_SIDE));
  });

  /* Al salir, el campo vuelve a mostrar el valor real: un vacio o un 0 que quedo
   * a mitad de escribir no es un tamano, y dejarlo escrito mentiria sobre lo que
   * el boton Apply va a hacer. */
  input.addEventListener('blur', () => { input.value = String(get()); });

  return {
    el: field(label, box),
    input,
    /* No se pisa el campo que se esta escribiendo: reescribirlo mientras alguien
     * teclea le manda el cursor al final en cada tecla. */
    sync() { if (document.activeElement !== input) input.value = String(get()); },
  };
}

function buildAnchor(onPick) {
  const grid = el('div', 'sc-anchor', {
    'data-tip': 'Where the current drawing sits in the new canvas',
  });
  const cells = new Map();
  for (const row of ANCHOR_GRID) {
    for (const id of row) {
      const b = el('button', 'sc-anchor__cell');
      b.setAttribute('aria-label', ANCHOR_NAME[id]);
      b.append(el('span'));
      b.addEventListener('click', () => {
        for (const [k, n] of cells) n.classList.toggle('on', k === id);
        onPick(id);
      });
      cells.set(id, b);
      grid.append(b);
    }
  }
  cells.get('c').classList.add('on');
  return { el: grid };
}
