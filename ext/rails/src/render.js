// @gcu/rails — chrome rendering + content positioning + panel cache
// DOM-touching. Expects an instance object holding host/chromeLayer/contentLayer/state/panels/callbacks.

import { liveTabIds } from './state.js';

export function cssEscape(s) {
  return (typeof window !== 'undefined' && window.CSS && window.CSS.escape)
    ? window.CSS.escape(s)
    : String(s).replace(/["\\]/g, '\\$&');
}

// z-index scheme. Rail panels sit at RAIL_PANEL_Z, above rail/stack splitters
// (z:2) but below the lowest float. Each float's chrome and panel get
// interleaved z-indexes so that float windows (chrome + panel together) stack
// as discrete units — a higher float fully paints above a lower float.
const RAIL_PANEL_Z = 5;
const FLOAT_Z_BASE = 100;
const FLOAT_Z_STEP = 10;
const FLOAT_PANEL_OFFSET = 5;

export function floatChromeZ(z) {
  return FLOAT_Z_BASE + z * FLOAT_Z_STEP;
}

export function floatPanelZ(z) {
  return FLOAT_Z_BASE + z * FLOAT_Z_STEP + FLOAT_PANEL_OFFSET;
}

// Chrome sublayer structure (built once in api.js's createRails init):
//
//   .rails-chrome
//     .rails-rails     — rail/stack layout, rebuilt on structural rail changes
//     .rails-floats    — float frames, rebuilt on structural float changes
//
// renderChrome wipes + rebuilds both sublayers from state. Float raise and
// stack activate are in-place and do NOT rebuild (see activateInPlace,
// raiseFloatInPlace in api.js / drag.js).

export function ensureSublayers(inst) {
  if (!inst.railsLayer) {
    inst.railsLayer = document.createElement('div');
    inst.railsLayer.className = 'rails-rails';
    inst.chromeLayer.appendChild(inst.railsLayer);
  }
  if (!inst.floatsLayer) {
    inst.floatsLayer = document.createElement('div');
    inst.floatsLayer.className = 'rails-floats';
    inst.chromeLayer.appendChild(inst.floatsLayer);
  }
}

export function renderChrome(inst) {
  ensureSublayers(inst);
  inst.railsLayer.innerHTML = '';
  inst.floatsLayer.innerHTML = '';
  inst._emptyEl = null;

  // Empty workspace: mount renderEmpty() if provided.
  if (inst.state.rails.length === 0 && (!inst.state.floats || inst.state.floats.length === 0)) {
    if (inst.callbacks.renderEmpty) {
      const el = inst.callbacks.renderEmpty();
      if (el) {
        el.classList.add('rails-empty');
        inst.railsLayer.appendChild(el);
        inst._emptyEl = el;
      }
    }
    reposition(inst);
    inst._emit('layout:change', { state: inst.state });
    return;
  }

  renderRails(inst);
  renderFloats(inst);
  reposition(inst);
  inst._emit('layout:change', { state: inst.state });
}

function buildRailBtn(inst, rail, kind) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = kind === 'expand' ? 'rails-rail-expand-btn' : 'rails-rail-collapse-btn';
  btn.textContent = kind === 'expand' ? '\u25b6' : '\u25c0';
  btn.setAttribute('aria-label', kind === 'expand' ? 'Expand rail' : 'Collapse rail');
  btn.title = kind === 'expand' ? 'Expand rail' : 'Collapse rail';
  btn.tabIndex = -1;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    inst._toggleRailCollapsed(rail.id);
  });
  return btn;
}

function renderRails(inst) {
  inst.state.rails.forEach((rail, ri) => {
    const railEl = document.createElement('div');
    railEl.className = 'rails-rail';
    if (rail.collapsed) railEl.classList.add('rails-collapsed');
    railEl.dataset.railId = rail.id;

    if (rail.collapsed) {
      // Collapsed rail: fixed-width strip with a restore button. No stacks
      // render; their panels are hidden by reposition (no slot found).
      railEl.style.flex = '0 0 32px';
      railEl.appendChild(buildRailBtn(inst, rail, 'expand'));
    } else {
      if (rail.width != null) {
        railEl.style.flex = `0 0 ${rail.width}px`;
      } else {
        railEl.style.flex = rail.flex ?? 1;
      }

      rail.stacks.forEach((stack, si) => {
        const stackEl = buildStackEl(inst, stack);
        if (stack.height != null) {
          stackEl.style.flex = `0 0 ${stack.height}px`;
        } else {
          stackEl.style.flex = stack.flex ?? 1;
        }
        railEl.appendChild(stackEl);

        if (si < rail.stacks.length - 1) {
          const sp = document.createElement('div');
          sp.className = 'rails-stack-split';
          sp.addEventListener('pointerdown', e => inst._onSplitterDown(e, 'stack', rail, si));
          railEl.appendChild(sp);
        }
      });

      // For collapsible rails, append the collapse button into the first
      // stack's strip-wrap so it sits as a flex sibling of the tabs/overflow
      // button (intentional neighbors), not absolutely-positioned over them.
      if (rail.collapsible && rail.stacks.length > 0) {
        const firstWrap = railEl.querySelector('.rails-strip-wrap');
        if (firstWrap) firstWrap.appendChild(buildRailBtn(inst, rail, 'collapse'));
      }
    }

    inst.railsLayer.appendChild(railEl);

    if (ri < inst.state.rails.length - 1) {
      const sp = document.createElement('div');
      sp.className = 'rails-rail-split';
      sp.addEventListener('pointerdown', e => inst._onSplitterDown(e, 'rail', null, ri));
      inst.railsLayer.appendChild(sp);
    }
  });
}

// Build a fully-assembled .rails-stack element (no size styling applied yet;
// caller handles flex/width/height). Used for rail-stacks and float-stacks.
function buildStackEl(inst, stack) {
  const stackEl = document.createElement('div');
  stackEl.className = 'rails-stack';
  const tabPos = stack.tabPosition || inst.config.tabPosition || 'top';
  if (tabPos === 'bottom') stackEl.classList.add('rails-tabs-bottom');
  stackEl.dataset.stackId = stack.id;

  const stripWrap = buildStripWrap(inst, stack);
  const slot = document.createElement('div');
  slot.className = 'rails-slot';
  slot.dataset.slotFor = stack.id;
  // ARIA: slot holds the active panel via its cached element.
  slot.setAttribute('role', 'tabpanel');
  slot.id = `rails-panel-${stack.id}`;

  if (tabPos === 'bottom') {
    stackEl.append(slot, stripWrap);
  } else {
    stackEl.append(stripWrap, slot);
  }
  return stackEl;
}

// Strip wrapper — flex row holding the scrollable strip + overflow button.
// The button lives next to (not inside) the scrollable strip so it doesn't
// scroll away with the tabs.
function buildStripWrap(inst, stack) {
  const wrap = document.createElement('div');
  wrap.className = 'rails-strip-wrap';
  const strip = buildStrip(inst, stack);
  const overflowBtn = buildOverflowBtn(inst, stack, strip);
  wrap.append(strip, overflowBtn);
  return wrap;
}

function buildOverflowBtn(inst, stack, strip) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rails-overflow-btn';
  btn.textContent = '\u22ef'; // ⋯
  btn.setAttribute('aria-label', 'Overflow tabs');
  btn.title = 'Overflow tabs';
  btn.tabIndex = -1;
  btn.hidden = true;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const overflowTabs = computeOverflowTabs(strip, stack);
    const r = btn.getBoundingClientRect();
    inst._emit('strip:overflow', {
      stack, overflowTabs,
      x: r.right, y: r.bottom,
    });
  });
  // Observe the strip for size/content changes; toggle btn visibility.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateOverflowBtn(btn, strip));
    ro.observe(strip);
  }
  // Initial compute in a microtask so layout has run.
  Promise.resolve().then(() => updateOverflowBtn(btn, strip));
  return btn;
}

function updateOverflowBtn(btn, strip) {
  if (!btn.isConnected) return;
  const overflow = strip.scrollWidth > strip.clientWidth + 1;
  btn.hidden = !overflow;
}

function computeOverflowTabs(strip, stack) {
  // Tabs whose rendered edges fall outside the strip's visible viewport.
  const tabEls = strip.querySelectorAll(':scope > .rails-tab');
  const sr = strip.getBoundingClientRect();
  const out = [];
  tabEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > sr.right + 1 || r.left < sr.left - 1) {
      const tab = stack.tabs.find(t => t.id === el.dataset.tabId);
      if (tab) out.push(tab);
    }
  });
  return out;
}

function buildStrip(inst, stack) {
  const strip = document.createElement('div');
  strip.className = 'rails-strip';
  strip.dataset.stackId = stack.id;
  strip.setAttribute('role', 'tablist');
  strip.tabIndex = 0;

  strip.addEventListener('contextmenu', e => {
    if (e.target === strip) {
      e.preventDefault();
      inst._emit('strip:contextmenu', { stack, x: e.clientX, y: e.clientY });
    }
  });
  strip.addEventListener('keydown', e => inst._onStripKeyDown(e, stack));

  stack.tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = 'rails-tab';
    if (tab.id === stack.active) tabEl.classList.add('rails-active');
    if (tab.closeable === false) tabEl.classList.add('rails-pinned-closed');
    if (tab.draggable === false) tabEl.classList.add('rails-locked');
    tabEl.dataset.tabId = tab.id;

    // ARIA
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', tab.id === stack.active ? 'true' : 'false');
    tabEl.setAttribute('aria-controls', `rails-panel-${stack.id}`);
    tabEl.id = `rails-tab-${tab.id}`;
    tabEl.tabIndex = tab.id === stack.active ? 0 : -1;

    const label = document.createElement('span');
    label.className = 'rails-tab-label';
    label.textContent = tab.title ?? tab.id;
    tabEl.appendChild(label);

    if (tab.badge != null && tab.badge !== '') {
      const badge = document.createElement('span');
      badge.className = 'rails-tab-badge';
      badge.textContent = String(tab.badge);
      tabEl.appendChild(badge);
    }

    if (tab.closeable !== false) {
      const x = document.createElement('span');
      x.className = 'rails-x';
      x.textContent = '\u00d7';
      x.dataset.closeTab = tab.id;
      x.setAttribute('aria-label', `Close ${tab.title ?? tab.id}`);
      x.setAttribute('role', 'button');
      tabEl.appendChild(x);
    }

    tabEl.addEventListener('pointerdown', e => inst._onTabDown(e, tab.id));
    tabEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      inst._emit('tab:contextmenu', { tab, stack, x: e.clientX, y: e.clientY });
    });

    strip.appendChild(tabEl);
  });
  return strip;
}

function renderFloats(inst) {
  if (!Array.isArray(inst.state.floats)) return;
  // Render in z-order so the DOM order is irrelevant for painting
  // (we use style.zIndex directly), but DOM order still matches z for dev tools.
  const sorted = [...inst.state.floats].sort((a, b) => a.z - b.z);
  for (const float of sorted) {
    inst.floatsLayer.appendChild(buildFloatEl(inst, float));
  }
}

function buildFloatEl(inst, float) {
  const el = document.createElement('div');
  el.className = 'rails-float';
  if (float.minimized) el.classList.add('rails-minimized');
  if (float.maximized) el.classList.add('rails-maximized');
  el.dataset.floatId = float.id;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', float.stack?.tabs.find(t => t.id === float.stack.active)?.title ?? 'Floating panel');
  el.style.left = float.x + 'px';
  el.style.top = float.y + 'px';
  el.style.width = float.w + 'px';
  el.style.height = float.h + 'px';
  el.style.zIndex = floatChromeZ(float.z);

  // Titlebar (drag handle + buttons)
  const titlebar = document.createElement('div');
  titlebar.className = 'rails-titlebar';
  titlebar.dataset.floatId = float.id;

  const titleLabel = document.createElement('div');
  titleLabel.className = 'rails-titlebar-label';
  const activeTab = float.stack?.tabs.find(t => t.id === float.stack.active);
  titleLabel.textContent = activeTab?.title ?? '';
  titlebar.appendChild(titleLabel);

  const btns = document.createElement('div');
  btns.className = 'rails-titlebar-buttons';
  btns.appendChild(makeTitleButton('rails-btn-minimize', '\u2013', 'Minimize'));
  btns.appendChild(makeTitleButton('rails-btn-maximize', float.maximized ? '\u29c9' : '\u25a1', float.maximized ? 'Restore' : 'Maximize'));
  btns.appendChild(makeTitleButton('rails-btn-close', '\u00d7', 'Close'));
  titlebar.appendChild(btns);

  titlebar.addEventListener('pointerdown', e => inst._onFloatTitlebarDown(e, float.id));
  titlebar.addEventListener('contextmenu', e => {
    e.preventDefault();
    inst._emit('float:titlebar:contextmenu', { float, x: e.clientX, y: e.clientY });
  });

  // Click on title buttons (delegated)
  btns.addEventListener('click', e => {
    const btn = e.target.closest('.rails-btn-minimize, .rails-btn-maximize, .rails-btn-close');
    if (!btn) return;
    e.stopPropagation();
    if (btn.classList.contains('rails-btn-minimize')) inst._toggleFloatMinimized(float.id);
    else if (btn.classList.contains('rails-btn-maximize')) inst._toggleFloatMaximized(float.id);
    else if (btn.classList.contains('rails-btn-close')) inst._closeFloat(float.id);
  });

  el.appendChild(titlebar);

  // Stack (strip + slot). Floats always render top-tabs.
  if (float.stack) {
    const stackEl = buildStackEl(inst, float.stack);
    // Float stacks fill remaining space below titlebar.
    stackEl.classList.add('rails-stack-in-float');
    el.appendChild(stackEl);
  }

  // 8 resize handles
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = `rails-resize-handle rails-resize-handle-${dir}`;
    handle.dataset.resize = dir;
    handle.addEventListener('pointerdown', e => inst._onFloatResizeDown(e, float.id, dir));
    el.appendChild(handle);
  }

  // Raise-on-pointerdown anywhere in the float.
  el.addEventListener('pointerdown', e => {
    // Only raise if the float isn't already topmost.
    const topZ = Math.max(0, ...inst.state.floats.map(f => f.z));
    if (float.z < topZ) inst._raiseFloat(float.id);
  }, true);

  return el;
}

function makeTitleButton(cls, glyph, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.tabIndex = -1;
  return b;
}

// Rebuild a single stack's strip wrapper in place (used by updateTab).
// Rebuilds the whole strip-wrap (strip + overflow button) so the RO and
// click-handler closures reference the new strip element.
export function rebuildStrip(inst, stackId) {
  const oldStrip = inst.chromeLayer.querySelector(
    `.rails-strip[data-stack-id="${cssEscape(stackId)}"]`
  );
  if (!oldStrip) {
    renderChrome(inst);
    return;
  }
  const stack = findStackInState(inst.state, stackId);
  if (!stack) {
    renderChrome(inst);
    return;
  }
  const oldWrap = oldStrip.parentElement;
  if (!oldWrap || !oldWrap.classList.contains('rails-strip-wrap')) {
    renderChrome(inst);
    return;
  }
  const newWrap = buildStripWrap(inst, stack);
  oldWrap.replaceWith(newWrap);
  reposition(inst);
  inst._emit('layout:change', { state: inst.state });
}

function findStackInState(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  for (const float of state.floats || []) {
    if (float.stack && float.stack.id === stackId) return float.stack;
  }
  return null;
}

// Position panels for all stacks (rails + floats). Show the active tab per
// stack; hide all others. Assigns per-panel z-index:
//   - rail tabs → 5 (above rail/stack splitters at z:2, below the floats
//     layer at z:100)
//   - float tabs → 100 + float.z (same effective root z as the float's own
//     chrome; DOM order breaks the tie and the panel wins because contentLayer
//     comes after chromeLayer in DOM. This is what lets the topmost float's
//     panel paint above every other float's chrome when you raise it.)
export function reposition(inst) {
  const wsRect = inst.host.getBoundingClientRect();
  const activeIds = new Set();

  const placeFromStack = (stack, float) => {
    const slot = inst.chromeLayer.querySelector(
      `.rails-slot[data-slot-for="${cssEscape(stack.id)}"]`
    );
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    const activeTab = stack.tabs.find(t => t.id === stack.active);
    if (!activeTab) return;
    const panel = getPanel(inst, activeTab);
    panel.style.left = (r.left - wsRect.left) + 'px';
    panel.style.top = (r.top - wsRect.top) + 'px';
    panel.style.width = r.width + 'px';
    panel.style.height = r.height + 'px';
    panel.style.display = '';
    panel.style.zIndex = float ? String(floatPanelZ(float.z ?? 0)) : String(RAIL_PANEL_Z);
    activeIds.add(activeTab.id);
  };

  for (const rail of inst.state.rails) {
    for (const stack of rail.stacks) placeFromStack(stack, null);
  }
  for (const float of inst.state.floats || []) {
    if (float.minimized) continue; // panel hidden when float is minimized
    if (float.stack) placeFromStack(float.stack, float);
  }

  for (const [tabId, el] of inst.panels) {
    if (!activeIds.has(tabId)) el.style.display = 'none';
  }
}

export function getPanel(inst, tab) {
  let panel = inst.panels.get(tab.id);
  if (panel) return panel;
  const wrap = document.createElement('div');
  wrap.className = 'rails-panel';
  wrap.dataset.tabId = tab.id;
  const body = inst.callbacks.renderPanel(tab);
  if (body) wrap.appendChild(body);
  inst.contentLayer.appendChild(wrap);
  inst.panels.set(tab.id, wrap);
  return wrap;
}

export function destroyPanel(inst, tabId, tab) {
  const el = inst.panels.get(tabId);
  if (!el) return;
  try {
    if (inst.callbacks.onPanelDestroy) {
      inst.callbacks.onPanelDestroy(tab || { id: tabId }, el);
    }
  } catch (err) {
    console.error('rails: onPanelDestroy threw', err);
  }
  el.remove();
  inst.panels.delete(tabId);
}

export function reconcilePanels(inst) {
  const live = liveTabIds(inst.state);
  for (const [tabId] of inst.panels) {
    if (!live.has(tabId)) destroyPanel(inst, tabId, null);
  }
}

export function destroyAllPanels(inst) {
  for (const [tabId] of inst.panels) destroyPanel(inst, tabId, null);
}

// In-place activate: swap .rails-active class on the strip, then reposition.
export function activateInPlace(inst, stack, tabId) {
  if (stack.active === tabId) return;
  stack.active = tabId;
  const strip = inst.chromeLayer.querySelector(
    `.rails-strip[data-stack-id="${cssEscape(stack.id)}"]`
  );
  if (strip) {
    for (const tabEl of strip.querySelectorAll('.rails-tab')) {
      const match = tabEl.dataset.tabId === tabId;
      tabEl.classList.toggle('rails-active', match);
      tabEl.setAttribute('aria-selected', match ? 'true' : 'false');
      tabEl.tabIndex = match ? 0 : -1;
    }
  }
  reposition(inst);
  const tab = stack.tabs.find(t => t.id === tabId);
  if (tab) inst._emit('tab:activate', { tab, stack });
}

// In-place raise of a float: update zIndex on the single float element and
// re-run reposition so the float's panel z-index (10 + float.z) is current.
// Without the reposition, a freshly-raised float's panel still has its old
// z-index and a previously-topmost float's panel keeps painting above it.
export function raiseFloatInPlace(inst, floatId) {
  const float = inst.state.floats.find(f => f.id === floatId);
  if (!float) return;
  const maxZ = Math.max(0, ...inst.state.floats.map(f => f.z));
  if (float.z >= maxZ) return;
  float.z = maxZ + 1;
  const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
  if (el) el.style.zIndex = floatChromeZ(float.z);
  reposition(inst);
  inst._emit('float:raise', { float });
}

// In-place bounds update (drag / resize). No chrome rebuild.
export function setFloatBoundsInPlace(inst, floatId, bounds) {
  const float = inst.state.floats.find(f => f.id === floatId);
  if (!float) return;
  if ('x' in bounds) float.x = bounds.x;
  if ('y' in bounds) float.y = bounds.y;
  if ('w' in bounds) float.w = bounds.w;
  if ('h' in bounds) float.h = bounds.h;
  const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
  if (el) {
    el.style.left = float.x + 'px';
    el.style.top = float.y + 'px';
    el.style.width = float.w + 'px';
    el.style.height = float.h + 'px';
  }
  reposition(inst);
}
