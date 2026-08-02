/* Titlebar propia y menus.
 *
 * La ventana va con frame:false, asi que la barra entera es nuestra: arrastre por
 * -webkit-app-region, botones de ventana dibujados y menus propios.
 *
 * Los menus se definen afuera (en app.js, que es quien conoce las acciones) y
 * aca solo se renderizan. Un unico nodo de menu se reusa para los cuatro: no hay
 * razon para tener cuatro popovers montados cuando solo uno puede estar abierto. */

import { el } from './controls.js';
import { icon } from './icons.js';

export function initTitlebar({ menus, onAction, isEnabled }) {
  const menu = el('div', 'sc-menu');
  document.body.append(menu);

  let openId = null;
  let openBtn = null;

  const buttons = [...document.querySelectorAll('[data-menu]')];

  function build(id) {
    menu.replaceChildren();
    for (const item of menus[id] || []) {
      if (item.rule) { menu.append(el('div', 'sc-menu__rule')); continue; }

      const b = el('button', 'sc-menu__item');
      b.append(item.icon ? icon(item.icon, 15) : el('span', null, { style: 'width:15px' }));
      b.append(el('span', null, { text: item.label }));
      if (item.key) b.append(el('span', 'sc-menu__key', { text: item.key }));

      const enabled = item.action ? (isEnabled?.(item.action) ?? true) : true;
      if (!enabled) {
        b.disabled = true;
        b.style.opacity = '.4';
        b.style.cursor = 'default';
      } else {
        b.addEventListener('click', () => {
          close();
          onAction?.(item.action);
        });
      }
      menu.append(b);
    }
  }

  function open(id, btn) {
    build(id);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 3)}px`;

    openId = id;
    openBtn = btn;
    for (const b of buttons) b.classList.toggle('open', b === btn);
    requestAnimationFrame(() => menu.classList.add('show'));

    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!openId) return;
    openId = null;
    openBtn = null;
    menu.classList.remove('show');
    for (const b of buttons) b.classList.remove('open');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(e) {
    if (!menu.contains(e.target) && !e.target.closest?.('[data-menu]')) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const id = b.dataset.menu;
      if (openId === id) close();
      else open(id, b);
    });
    /* Con un menu ya abierto, pasar por encima de otro titulo cambia de menu sin
     * clickear — es como se comporta una barra de menu de escritorio. */
    b.addEventListener('pointerenter', () => {
      if (openId && openId !== b.dataset.menu) open(b.dataset.menu, b);
    });
  }

  // ── botones de ventana ────────────────────────────────────────────────────

  const maxBtn = document.getElementById('sc-max');

  document.getElementById('sc-min').addEventListener('click', () => window.scrawl.win.minimize());
  maxBtn.addEventListener('click', () => window.scrawl.win.toggleMaximize());
  document.getElementById('sc-close').addEventListener('click', () => window.scrawl.win.close());

  function paintMaxIcon(maximized) {
    maxBtn.replaceChildren(icon(maximized ? 'winRestore' : 'winMax', 12));
    maxBtn.setAttribute('data-tip', maximized ? 'Restore' : 'Maximize');
  }

  window.scrawl.win.onState(({ maximized }) => paintMaxIcon(maximized));
  window.scrawl.win.isMaximized().then(paintMaxIcon);

  return { close };
}
