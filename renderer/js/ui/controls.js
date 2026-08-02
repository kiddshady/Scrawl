/* Primitivos de interfaz propios.
 *
 * Todo lo de aca existe porque el equivalente nativo de Chromium se nota. Un
 * <input type=range> se puede re-pintar hasta cierto punto, pero su thumb no se
 * puede animar como uno quiere y su comportamiento con shift o con la rueda no
 * es configurable; un <select> abre directamente un menu del sistema operativo,
 * ajeno a la app y sin estilar. Y estos dos controles son los que mas se tocan
 * en una app de dibujo, asi que vale tenerlos propios. */

import { icon } from './icons.js';

export function el(tag, cls, attrs = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('data-') || k === 'tabindex') n.setAttribute(k, v);
    else n[k] = v;
  }
  return n;
}

// ── slider ──────────────────────────────────────────────────────────────────

/* opts: { min, max, step, value, curve, fmt, label, onInput, tip }
 *
 * 'curve' es el detalle que lo vuelve usable de verdad. El tamano de pincel va
 * de 1 a 400, pero los valores que uno usa el 90% del tiempo estan entre 2 y 40.
 * Con un recorrido lineal, todo ese rango util cae en el primer 10% del slider y
 * elegir un 6 se vuelve un ejercicio de punteria. Con curve=2 la posicion se
 * eleva al cuadrado antes de mapearse al valor, asi que la mitad izquierda cubre
 * los pinceles finos y la derecha los gruesos. */
export function makeSlider(opts) {
  const {
    min = 0, max = 1, step = 0.01, curve = 1,
    fmt = (v) => String(v), label = '', tip = null,
  } = opts;
  let value = opts.value ?? min;

  const wrap = el('div', 'sc-field');
  const top = el('div', 'sc-field__top');
  const lab = el('span', 'sc-field__label', { text: label });
  const val = el('span', 'sc-field__val');
  top.append(lab, val);

  const slider = el('div', 'sc-slider', { tabindex: '0' });
  if (tip) slider.setAttribute('data-tip', tip);
  const track = el('div', 'sc-slider__track');
  const fill = el('div', 'sc-slider__fill');
  const thumb = el('div', 'sc-slider__thumb');
  track.append(fill);
  slider.append(track, thumb);
  wrap.append(top, slider);

  const toT = (v) => {
    const norm = (v - min) / (max - min);
    return curve === 1 ? norm : Math.pow(Math.max(0, norm), 1 / curve);
  };
  const toV = (t) => {
    const norm = curve === 1 ? t : Math.pow(Math.max(0, Math.min(1, t)), curve);
    return min + norm * (max - min);
  };
  const snap = (v, fine = false) => {
    const s = fine ? step / 10 : step;
    const q = Math.round(v / s) * s;
    // el redondeo saca los 0.30000000000000004 que ensucian el texto
    return Math.max(min, Math.min(max, Number(q.toFixed(6))));
  };

  function paint() {
    const t = toT(value);
    fill.style.width = `${t * 100}%`;
    thumb.style.left = `${t * 100}%`;
    val.textContent = fmt(value);
  }

  function set(v, notify = false) {
    const next = snap(v);
    if (next === value) { paint(); return; }
    value = next;
    paint();
    if (notify) opts.onInput?.(value);
  }

  function fromEvent(e, fine) {
    const r = track.getBoundingClientRect();
    const t = (e.clientX - r.left) / r.width;
    set(snap(toV(Math.max(0, Math.min(1, t))), fine), true);
  }

  slider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('drag');
    fromEvent(e, e.shiftKey);
  });
  slider.addEventListener('pointermove', (e) => {
    if (!slider.classList.contains('drag')) return;
    fromEvent(e, e.shiftKey);
  });
  const stop = (e) => {
    if (!slider.classList.contains('drag')) return;
    slider.classList.remove('drag');
    try { slider.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
  };
  slider.addEventListener('pointerup', stop);
  slider.addEventListener('pointercancel', stop);

  // la rueda sobre el slider ajusta: es mas rapido que apuntar y arrastrar
  slider.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    // el paso sigue la curva: mueve una fraccion del recorrido, no del valor,
    // asi se siente igual de fino en los dos extremos
    const t = toT(value) + dir * (e.shiftKey ? 0.005 : 0.025);
    set(snap(toV(t), e.shiftKey), true);
  }, { passive: false });

  slider.addEventListener('keydown', (e) => {
    const fine = e.shiftKey;
    let dir = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
    else if (e.key === 'Home') { set(min, true); e.preventDefault(); return; }
    else if (e.key === 'End') { set(max, true); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    const t = toT(value) + dir * (fine ? 0.005 : 0.025);
    set(snap(toV(t), fine), true);
  });

  paint();
  return { el: wrap, set: (v) => set(v, false), get: () => value, slider };
}

// ── select ──────────────────────────────────────────────────────────────────

/* opts: { options: [{id, name}], value, onChange, tip }
 * El popover va con position:fixed y se ancla en el momento de abrir, asi que
 * ningun overflow:hidden de panel lo recorta. */
export function makeSelect(host, opts) {
  const { options, onChange, tip = null } = opts;
  let value = opts.value ?? options[0]?.id;
  let open = false;

  host.classList.add('sc-select');
  const btn = el('button', 'sc-select__btn');
  if (tip) btn.setAttribute('data-tip', tip);
  const label = el('span');
  btn.append(label, icon('chevronDown', 13));

  const pop = el('div', 'sc-select__pop');
  const items = new Map();
  for (const o of options) {
    const item = el('button', 'sc-option');
    const check = el('span', 'sc-option__check');
    check.append(icon('check', 12));
    const name = el('span', null, { text: o.name });
    item.append(check, name);
    item.addEventListener('click', () => {
      setValue(o.id, true);
      close();
    });
    items.set(o.id, item);
    pop.append(item);
  }

  host.replaceChildren(btn);
  document.body.append(pop);

  function paint() {
    label.textContent = options.find((o) => o.id === value)?.name ?? '';
    for (const [id, item] of items) item.classList.toggle('on', id === value);
  }

  function setValue(v, notify = false) {
    if (v === value) return;
    value = v;
    paint();
    if (notify) onChange?.(value);
  }

  function place() {
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${r.width}px`;
    // medir con el popover ya visible pero transparente; sin esto la altura da 0
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 4}px`;
    const ph = pop.offsetHeight;
    // si no cabe abajo, se abre hacia arriba
    if (r.bottom + 4 + ph > window.innerHeight - 8) {
      pop.style.top = `${Math.max(8, r.top - ph - 4)}px`;
      pop.style.transformOrigin = 'bottom center';
    } else {
      pop.style.transformOrigin = 'top center';
    }
  }

  function openPop() {
    if (open) return;
    open = true;
    host.classList.add('open');
    place();
    // un frame de margen para que la transicion de entrada corra desde el estado
    // inicial en vez de saltar al final
    requestAnimationFrame(() => pop.classList.add('show'));
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!open) return;
    open = false;
    host.classList.remove('open');
    pop.classList.remove('show');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(e) {
    if (!pop.contains(e.target) && !host.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  btn.addEventListener('click', () => (open ? close() : openPop()));
  window.addEventListener('resize', () => open && place());

  paint();
  return {
    set: (v) => setValue(v, false),
    get: () => value,
    close,
    setOptions(next) {
      // no se usa todavia, pero deja el control reutilizable sin reescribirlo
      pop.replaceChildren();
      items.clear();
      for (const o of next) {
        const item = el('button', 'sc-option');
        const check = el('span', 'sc-option__check');
        check.append(icon('check', 12));
        item.append(check, el('span', null, { text: o.name }));
        item.addEventListener('click', () => { setValue(o.id, true); close(); });
        items.set(o.id, item);
        pop.append(item);
      }
      paint();
    },
  };
}

// ── toasts ──────────────────────────────────────────────────────────────────

let toastHost = null;

export function toast(message, iconName = null, ms = 2200) {
  toastHost = toastHost || document.getElementById('sc-toasts');
  if (!toastHost) return;
  const t = el('div', 'sc-toast');
  if (iconName) t.append(icon(iconName, 15));
  t.append(el('span', null, { text: message }));
  toastHost.append(t);

  setTimeout(() => {
    // se anima la salida y recien despues se saca del DOM: nada desaparece de golpe
    t.classList.add('leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 400);   // red de seguridad
  }, ms);
}
