// @gcu/menu — Menu primitive: positioned, dismissable list of actions.
// Used for context menus, dropdowns, submenus, and as the engine behind
// MenuBar. See SPEC.md for full design.

import {
  evaluateItems, isSeparator, isEnabled, hasSubmenu,
  firstEnabledIdx, lastEnabledIdx, nextEnabledIdx, findByPrefix,
} from './helpers.js';

const TYPEAHEAD_RESET_MS = 600;
const SUBMENU_HOVER_OPEN_MS = 250;

// Module-level state. One root menu open at a time; submenus stack within it.
let _root = null;       // { el, items, resolve, opener, anchorOpts, onDocDown, onKey, onCtxOutside }
let _stack = [];        // [{ el, items, parent }] — submenus including root
let _typeahead = '';
let _typeaheadTimer = null;
let _focused = null;    // { stackIdx, itemIdx }

// Public namespace API.
export const Menu = {
  show,
  dismiss,
  dropdown,
  isOpen,
};

// ── Menu.show ──────────────────────────────────────────────────────────────

export function isOpen() {
  return _root !== null;
}

export function show(items, opts = {}) {
  return new Promise(resolve => {
    if (_root) {
      // Dismiss the existing menu (resolves its pending promise to null).
      const prev = _root;
      teardown();
      prev.resolve(null);
    }

    const evaluated = evaluateItems(items);
    // Empty-items short-circuit: no popup shown, resolve null immediately.
    // Consumers that want a "no items" placeholder should add a single
    // disabled item ({ label: '(none)', disabled: true }).
    if (evaluated.length === 0) {
      resolve(null);
      return;
    }

    const host = opts.host || document.body;
    const el = buildMenuEl(evaluated, /*depth*/ 0);
    host.appendChild(el);

    _stack = [{ el, items: evaluated, parent: null, trigger: null }];
    _root = {
      el,
      items: evaluated,
      resolve,
      opener: opts.opener || document.activeElement,
      host,
    };

    positionMenu(el, opts);

    // Initial highlight: first enabled item.
    setFocus(0, firstEnabledIdx(evaluated));

    attachGlobalListeners();
  });
}

export function dismiss() {
  if (!_root) return;
  const r = _root;
  teardown();
  r.resolve(null);
}

// ── Menu.dropdown ──────────────────────────────────────────────────────────

export function dropdown(button, items, options = {}) {
  if (!button || !button.nodeType) {
    throw new Error('Menu.dropdown: button must be an HTMLElement');
  }

  let isOpen = false;
  let pendingPromise = null;

  function open() {
    if (isOpen) return;
    isOpen = true;
    button.setAttribute('aria-expanded', 'true');
    pendingPromise = show(items, {
      anchor: button,
      placement: options.placement || 'bottom-start',
      opener: button,
    });
    pendingPromise.then(action => {
      isOpen = false;
      button.setAttribute('aria-expanded', 'false');
      pendingPromise = null;
      if (action != null && options.onAction) {
        try { options.onAction(action); } catch (e) { console.error('Menu.dropdown onAction threw', e); }
      }
      // Return focus to button.
      try { button.focus(); } catch {}
    });
  }

  function close() {
    if (!isOpen) return;
    dismiss();
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) close();
    else open();
  }

  function onKey(e) {
    if (isOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  }

  button.addEventListener('click', onClick);
  button.addEventListener('keydown', onKey);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  return {
    open,
    close,
    isOpen() { return isOpen; },
    destroy() {
      button.removeEventListener('click', onClick);
      button.removeEventListener('keydown', onKey);
      button.removeAttribute('aria-haspopup');
      button.removeAttribute('aria-expanded');
      if (isOpen) close();
    },
  };
}

// ── DOM building ───────────────────────────────────────────────────────────

function buildMenuEl(items, depth) {
  const el = document.createElement('div');
  el.className = 'gcu-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-orientation', 'vertical');
  el.tabIndex = -1;
  if (depth > 0) el.classList.add('gcu-menu-submenu');

  items.forEach((item, idx) => {
    el.appendChild(buildItemEl(item, idx));
  });

  return el;
}

function buildItemEl(item, idx) {
  if (isSeparator(item)) {
    const sep = document.createElement('div');
    sep.className = 'gcu-menu-sep';
    sep.setAttribute('role', 'separator');
    return sep;
  }

  const itemEl = document.createElement('div');
  itemEl.className = 'gcu-menu-item';
  itemEl.dataset.idx = idx;
  if (item.disabled) {
    itemEl.classList.add('gcu-menu-disabled');
    itemEl.setAttribute('aria-disabled', 'true');
  }
  if (item.danger) itemEl.classList.add('gcu-menu-danger');
  if (item.checked) itemEl.classList.add('gcu-menu-checked');

  // Role variant: checkbox vs radio vs plain item.
  if (item.group) {
    itemEl.setAttribute('role', 'menuitemradio');
    itemEl.setAttribute('aria-checked', item.checked ? 'true' : 'false');
  } else if (item.checked != null) {
    itemEl.setAttribute('role', 'menuitemcheckbox');
    itemEl.setAttribute('aria-checked', item.checked ? 'true' : 'false');
  } else {
    itemEl.setAttribute('role', 'menuitem');
  }

  // Check / radio glyph slot (always present, hidden when not applicable).
  const check = document.createElement('span');
  check.className = 'gcu-menu-check';
  check.textContent = item.checked
    ? (item.group ? '\u25cf' : '\u2713') // ● or ✓
    : '';
  itemEl.appendChild(check);

  // Icon slot.
  const icon = document.createElement('span');
  icon.className = 'gcu-menu-icon';
  if (item.icon) {
    if (item.icon.startsWith('/') || item.icon.startsWith('http') || item.icon.endsWith('.svg')) {
      const img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.textContent = item.icon;
    }
  }
  itemEl.appendChild(icon);

  // Label.
  const label = document.createElement('span');
  label.className = 'gcu-menu-label';
  label.textContent = item.label;
  itemEl.appendChild(label);

  // Shortcut.
  const sc = document.createElement('span');
  sc.className = 'gcu-menu-shortcut';
  sc.textContent = item.shortcut || '';
  itemEl.appendChild(sc);

  // Submenu indicator.
  const arrow = document.createElement('span');
  arrow.className = 'gcu-menu-arrow';
  arrow.textContent = hasSubmenu(item) ? '\u25b8' : ''; // ▸
  itemEl.appendChild(arrow);

  if (hasSubmenu(item)) {
    itemEl.setAttribute('aria-haspopup', 'menu');
    itemEl.setAttribute('aria-expanded', 'false');
  }

  // Pointer interactions. The element reference is what locates the right
  // layer at event time — multiple layers can hold an item with the same idx.
  itemEl.addEventListener('mouseenter', () => onItemHover(idx, itemEl));
  itemEl.addEventListener('mouseleave', () => onItemUnhover(idx));
  itemEl.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    onItemActivate(idx, itemEl);
  });

  return itemEl;
}

// ── positioning ────────────────────────────────────────────────────────────

function positionMenu(el, opts) {
  // Force layout to read dimensions.
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  el.style.visibility = 'hidden';

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 4;

  let x, y;
  let r;       // anchor rect (real or synthesized)
  let place;

  if (opts.anchor && opts.anchor.getBoundingClientRect) {
    r = opts.anchor.getBoundingClientRect();
    place = opts.placement || 'bottom-start';
  } else {
    // (x, y) form: treat the point as a zero-size anchor so placement still
    // applies. Default placement keeps backward-compat: top-left of the menu
    // lands at (x, y) — same as `bottom-start` against a 0×0 rect at (x, y).
    const px = opts.x ?? 0;
    const py = opts.y ?? 0;
    r = { left: px, right: px, top: py, bottom: py, width: 0, height: 0 };
    place = opts.placement || 'bottom-start';
  }
  ({ x, y } = computeAnchored(r, w, h, place));
  // Flip if no room.
  if (place.startsWith('bottom') && y + h > vh - margin && r.top - h - margin >= 0) {
    y = r.top - h;
  } else if (place.startsWith('top') && y < margin && r.bottom + h + margin <= vh) {
    y = r.bottom;
  } else if (place.startsWith('right') && x + w > vw - margin && r.left - w - margin >= 0) {
    x = r.left - w;
  } else if (place.startsWith('left') && x < margin && r.right + w + margin <= vw) {
    x = r.right;
  }

  // Clamp to viewport.
  if (x + w > vw - margin) x = vw - w - margin;
  if (y + h > vh - margin) y = vh - h - margin;
  if (x < margin) x = margin;
  if (y < margin) y = margin;

  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.style.visibility = '';
}

function computeAnchored(r, w, h, placement) {
  switch (placement) {
    case 'bottom-start': return { x: r.left,           y: r.bottom };
    case 'bottom-end':   return { x: r.right - w,      y: r.bottom };
    case 'bottom':       return { x: r.left + (r.width - w) / 2, y: r.bottom };
    case 'top-start':    return { x: r.left,           y: r.top - h };
    case 'top-end':      return { x: r.right - w,      y: r.top - h };
    case 'top':          return { x: r.left + (r.width - w) / 2, y: r.top - h };
    case 'right-start':  return { x: r.right,          y: r.top };
    case 'left-start':   return { x: r.left - w,       y: r.top };
    case 'cursor':       return { x: r.left,           y: r.top };
    default:             return { x: r.left,           y: r.bottom };
  }
}

function positionSubmenu(submenuEl, triggerEl) {
  submenuEl.style.position = 'fixed';
  submenuEl.style.left = '0px';
  submenuEl.style.top = '0px';
  submenuEl.style.visibility = 'hidden';

  // Measure offset of first item within submenu container so submenu's first
  // item top aligns with the trigger row top — accounting for the menu's
  // own padding-top + border.
  const firstItem = submenuEl.querySelector('.gcu-menu-item');
  let firstItemOffset = 0;
  if (firstItem) {
    const sr = submenuEl.getBoundingClientRect();
    const fr = firstItem.getBoundingClientRect();
    firstItemOffset = fr.top - sr.top;
  }

  const sw = submenuEl.offsetWidth;
  const sh = submenuEl.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = triggerEl.getBoundingClientRect();
  const margin = 4;

  let x = r.right;
  let y = r.top - firstItemOffset;

  // Flip horizontally if no room.
  if (x + sw > vw - margin && r.left - sw - margin >= 0) x = r.left - sw;
  // Clamp vertically.
  if (y + sh > vh - margin) y = vh - sh - margin;
  if (y < margin) y = margin;

  submenuEl.style.left = `${Math.round(x)}px`;
  submenuEl.style.top = `${Math.round(y)}px`;
  submenuEl.style.visibility = '';
}

// ── focus / highlight ──────────────────────────────────────────────────────

function setFocus(stackIdx, itemIdx) {
  // Clear all current highlights.
  for (const layer of _stack) {
    for (const el of layer.el.querySelectorAll('.gcu-menu-item')) {
      el.classList.remove('gcu-menu-active');
      el.removeAttribute('aria-current');
    }
  }
  _focused = null;
  if (stackIdx < 0 || stackIdx >= _stack.length) return;
  const layer = _stack[stackIdx];
  if (itemIdx < 0 || itemIdx >= layer.items.length) return;
  if (!isEnabled(layer.items[itemIdx])) return;
  const itemEl = layer.el.querySelector(`.gcu-menu-item[data-idx="${itemIdx}"]`);
  if (itemEl) {
    itemEl.classList.add('gcu-menu-active');
    itemEl.setAttribute('aria-current', 'true');
    _focused = { stackIdx, itemIdx };
  }
}

// ── pointer ────────────────────────────────────────────────────────────────

let _hoverTimer = null;

function onItemHover(idx, itemEl) {
  const layerIdx = findLayerForEl(itemEl);
  if (layerIdx < 0) return;

  // While a drag is in progress, only update focus highlight; don't auto-open submenus.
  const dragging = isDragging();

  // Clear any pending submenu-hover-open and any deeper layers when hovering a shallower item.
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  while (_stack.length > layerIdx + 1) {
    closeTopSubmenu();
  }

  setFocus(layerIdx, idx);

  if (dragging) return;

  const item = _stack[layerIdx].items[idx];
  if (hasSubmenu(item) && layerIdx === _stack.length - 1) {
    _hoverTimer = setTimeout(() => {
      _hoverTimer = null;
      openSubmenuFromIdx(layerIdx, idx, /*focusFirstChild*/ false);
    }, SUBMENU_HOVER_OPEN_MS);
  }
}

function onItemUnhover(_idx) {
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
}

function findLayerForEl(itemEl) {
  // Locate the layer that physically contains the given item element.
  for (let i = 0; i < _stack.length; i++) {
    if (_stack[i].el.contains(itemEl)) return i;
  }
  return -1;
}

function onItemActivate(idx, itemEl) {
  const layerIdx = findLayerForEl(itemEl);
  if (layerIdx < 0) return;
  const layer = _stack[layerIdx];
  const item = layer.items[idx];
  if (!isEnabled(item)) return;

  if (hasSubmenu(item)) {
    if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
    // Close any deeper layers and open this submenu.
    while (_stack.length > layerIdx + 1) closeTopSubmenu();
    openSubmenuFromIdx(layerIdx, idx);
    return;
  }

  // Leaf: resolve.
  const action = item.action;
  const r = _root;
  teardown();
  r.resolve(action !== undefined ? action : null);
}

function openSubmenuFromIdx(parentLayerIdx, idx, focusFirstChild = true) {
  const parent = _stack[parentLayerIdx];
  const item = parent.items[idx];
  if (!hasSubmenu(item)) return;

  const childItems = evaluateItems(item.children);
  const submenuEl = buildMenuEl(childItems, parentLayerIdx + 1);
  _root.host.appendChild(submenuEl);

  const triggerEl = parent.el.querySelector(`.gcu-menu-item[data-idx="${idx}"]`);
  if (triggerEl) triggerEl.setAttribute('aria-expanded', 'true');

  positionSubmenu(submenuEl, triggerEl);

  _stack.push({ el: submenuEl, items: childItems, parent: parentLayerIdx, trigger: triggerEl });
  // Hover-open keeps focus on the parent trigger; the submenu's first item
  // only highlights when the user moves the cursor into it (matches native).
  // Keyboard/click open passes focusFirstChild=true to highlight immediately.
  if (focusFirstChild) {
    setFocus(_stack.length - 1, firstEnabledIdx(childItems));
  }
}

function closeTopSubmenu() {
  if (_stack.length <= 1) return;
  const top = _stack.pop();
  if (top.trigger) top.trigger.setAttribute('aria-expanded', 'false');
  top.el.remove();
}

// ── keyboard ───────────────────────────────────────────────────────────────

function onDocKey(e) {
  if (!_root) return;

  // Tab: dismiss without swallowing.
  if (e.key === 'Tab') {
    const r = _root;
    teardown();
    r.resolve(null);
    return; // do NOT preventDefault — tab moves focus naturally
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (_stack.length > 1) {
      closeTopSubmenu();
      // Re-focus parent's trigger item.
      const parent = _stack[_stack.length - 1];
      const parentTriggerIdx = parent.items.findIndex(it => !isSeparator(it) && it.children === parent.items);
      // Use _focused if possible; else default to last focused item before opening submenu.
      // Simpler: just keep focus on the parent layer's previously highlighted item.
      // We don't track that, so leave current focus alone; just remove highlight on the now-closed layer.
      // Actually: re-focus the parent layer's last item idx — which was the trigger we opened from.
      // We can find it as the item with aria-expanded that's now false. Simpler: search for the
      // submenu trigger item (children === closed layer's items)... no, lost reference.
      // Practical: re-highlight first enabled in parent.
      const stackIdx = _stack.length - 1;
      // Try to keep highlight on the same idx if still valid; else first enabled.
      const cur = _focused?.stackIdx === stackIdx ? _focused.itemIdx : firstEnabledIdx(parent.items);
      setFocus(stackIdx, cur);
      return;
    }
    const r = _root;
    teardown();
    r.resolve(null);
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveFocus(+1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveFocus(-1);
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    if (_focused) setFocus(_focused.stackIdx, firstEnabledIdx(_stack[_focused.stackIdx].items));
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    if (_focused) setFocus(_focused.stackIdx, lastEnabledIdx(_stack[_focused.stackIdx].items));
    return;
  }
  if (e.key === 'ArrowRight') {
    if (!_focused) return;
    const layer = _stack[_focused.stackIdx];
    const item = layer.items[_focused.itemIdx];
    if (!hasSubmenu(item)) return;
    e.preventDefault();
    if (_focused.stackIdx === _stack.length - 1) {
      // No submenu open below us — open it and focus first child.
      openSubmenuFromIdx(_focused.stackIdx, _focused.itemIdx, /*focusFirstChild*/ true);
    } else {
      // Submenu already open (hover-opened) — move focus into it.
      const childLayer = _focused.stackIdx + 1;
      setFocus(childLayer, firstEnabledIdx(_stack[childLayer].items));
    }
    return;
  }
  if (e.key === 'ArrowLeft') {
    if (_stack.length > 1) {
      e.preventDefault();
      closeTopSubmenu();
      setFocus(_stack.length - 1, _focused ? _focused.itemIdx : firstEnabledIdx(_stack[_stack.length - 1].items));
    }
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (!_focused) return;
    e.preventDefault();
    onItemActivate(_focused.itemIdx);
    return;
  }

  // Typeahead: single printable character.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    typeaheadAdvance(e.key);
  }
}

function moveFocus(dir) {
  if (!_focused) {
    // Nothing focused — fall back to first/last in deepest layer.
    const stackIdx = _stack.length - 1;
    const items = _stack[stackIdx].items;
    setFocus(stackIdx, dir > 0 ? firstEnabledIdx(items) : lastEnabledIdx(items));
    return;
  }
  const layer = _stack[_focused.stackIdx];
  setFocus(_focused.stackIdx, nextEnabledIdx(layer.items, _focused.itemIdx, dir));
}

function typeaheadAdvance(ch) {
  if (_typeaheadTimer) clearTimeout(_typeaheadTimer);
  _typeahead += ch.toLowerCase();
  _typeaheadTimer = setTimeout(() => {
    _typeahead = '';
    _typeaheadTimer = null;
  }, TYPEAHEAD_RESET_MS);

  const stackIdx = _focused ? _focused.stackIdx : _stack.length - 1;
  const items = _stack[stackIdx].items;
  const startIdx = _focused ? _focused.itemIdx : -1;
  const found = findByPrefix(items, _typeahead, startIdx);
  if (found >= 0) setFocus(stackIdx, found);
}

// ── outside-pointer / context ──────────────────────────────────────────────

function onDocPointerDown(e) {
  if (!_root) return;
  if (insideAnyMenu(e.target)) return;

  const isRightClick = e.button === 2;
  const r = _root;
  teardown();
  r.resolve(null);

  if (!isRightClick) {
    // Suppress the click that would otherwise activate the underlying element.
    // Self-removes on first click; also cleared on the next macrotask in case
    // pointerdown isn't followed by a click (e.g. drag-out, pointerup-elsewhere).
    const suppress = (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      document.removeEventListener('click', suppress, true);
    };
    document.addEventListener('click', suppress, true);
    setTimeout(() => document.removeEventListener('click', suppress, true), 0);
  }
  // Right-click: let the contextmenu event fire on the underlying element so
  // the consumer can re-open a context menu at the new position.
}

function insideAnyMenu(target) {
  for (const layer of _stack) {
    if (layer.el.contains(target)) return true;
  }
  return false;
}

// ── drag detection ─────────────────────────────────────────────────────────

function isDragging() {
  return document.body.classList.contains('rails-dragging')
      || document.body.classList.contains('gcu-dragging');
}

// ── lifecycle helpers ──────────────────────────────────────────────────────

function attachGlobalListeners() {
  _root.onDocDown = onDocPointerDown;
  _root.onKey = onDocKey;
  document.addEventListener('pointerdown', _root.onDocDown, true);
  document.addEventListener('keydown', _root.onKey, true);
  window.addEventListener('blur', dismissOnBlur);
  window.addEventListener('resize', dismiss);
  window.addEventListener('scroll', dismiss, true);
}

function detachGlobalListeners() {
  if (!_root) return;
  document.removeEventListener('pointerdown', _root.onDocDown, true);
  document.removeEventListener('keydown', _root.onKey, true);
  window.removeEventListener('blur', dismissOnBlur);
  window.removeEventListener('resize', dismiss);
  window.removeEventListener('scroll', dismiss, true);
}

function dismissOnBlur() {
  // Only dismiss on focus leaving the window entirely; not on transient
  // pointer-down focus shifts.
  setTimeout(() => {
    if (document.hasFocus()) return;
    dismiss();
  }, 0);
}

function teardown() {
  if (!_root) return;
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  if (_typeaheadTimer) { clearTimeout(_typeaheadTimer); _typeaheadTimer = null; }
  _typeahead = '';
  detachGlobalListeners();
  for (const layer of _stack) {
    if (layer.el && layer.el.parentNode) layer.el.remove();
  }
  // Return focus to opener.
  const opener = _root.opener;
  _stack = [];
  _focused = null;
  _root = null;
  if (opener && opener.focus) {
    try { opener.focus(); } catch {}
  }
}
