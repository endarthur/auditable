// @gcu/rails — public API: createRails()
// Assembles an instance, wires event delegation, and returns the public surface.

import {
  findTab,
  findStack,
  findRail,
  findFloat,
  removeTabFromStack,
  cleanup,
  patchTab,
  liveTabIds,
  validateState,
  emptyState,
  makeId,
  freshId,
  serializeState,
} from './state.js';

import {
  renderChrome,
  rebuildStrip,
  reposition,
  getPanel,
  destroyPanel,
  reconcilePanels,
  destroyAllPanels,
  activateInPlace,
  raiseFloatInPlace,
  setFloatBoundsInPlace,
  cssEscape,
} from './render.js';

import { onTabDown, onSplitterDown, onFloatTitlebarDown, onFloatResizeDown } from './drag.js';

export function createRails(host, options = {}) {
  if (!host || !host.nodeType) {
    throw new Error('rails: host must be an HTMLElement');
  }
  if (typeof options.renderPanel !== 'function') {
    throw new Error('rails: options.renderPanel is required');
  }

  host.classList.add('rails-root');

  const chromeLayer = document.createElement('div');
  chromeLayer.className = 'rails-chrome';
  const contentLayer = document.createElement('div');
  contentLayer.className = 'rails-content';
  host.append(chromeLayer, contentLayer);

  const state = options.initialState
    ? JSON.parse(JSON.stringify(options.initialState))
    : emptyState();
  // Ensure floats is an array even if consumer omitted it.
  if (!Array.isArray(state.floats)) state.floats = [];

  // Validate only if non-empty — empty state skips per invariant 7.
  if (state.rails.length > 0) validateState(state);

  const callbacks = {
    renderPanel: options.renderPanel,
    renderEmpty: options.renderEmpty,
    onPanelDestroy: options.onPanelDestroy,
    canCloseTab: options.canCloseTab,
    canMoveTab: options.canMoveTab,
    canCreateFloat: options.canCreateFloat,
    canDropOn: options.canDropOn,
  };

  const config = {
    minFloatSize: options.minFloatSize ?? { w: 200, h: 120 },
    dragThreshold: options.dragThreshold ?? 4,
    tabPosition: options.tabPosition ?? 'top',
    dropZones: options.dropZones ?? {},
    // Opt-in "+" button at the end of every tab strip. When true, each strip
    // renders a new-tab affordance that emits `strip:newtab` ({ stack }); the
    // consumer decides what to spawn (e.g. a launcher) into that stack. Off by
    // default so existing rails hosts are unchanged.
    newTabButton: options.newTabButton ?? false,
  };

  const events = new Map();

  const inst = {
    host,
    chromeLayer,
    contentLayer,
    state,
    panels: new Map(),
    // Panels preserved after close — keyed by tabId, value is the last-known
    // tab object. The panel itself stays in `panels` too, hidden via display:none.
    // Re-adding the same tab ID reuses the cached panel; releasePreservedPanel
    // forces destruction. See closeTab({ preserve: true }).
    preservedTabs: new Map(),
    callbacks,
    config,
    events,
    drag: null,
    batchDepth: 0,
    batchDirty: false,
    // Wired methods below for render.js/drag.js to call without circular imports.
    _emit: null,
    _reposition: null,
    _renderChrome: null,
    _activate: null,
    _onTabDown: null,
    _onSplitterDown: null,
    _cleanupAndRender: null,
  };

  inst._emit = (event, payload) => {
    // Shortcut handlers from options (onChange, onFloatMinimize, etc.)
    const shortcut = options['on' + capitalize(toCamel(event))];
    if (typeof shortcut === 'function') {
      try { shortcut(payload); } catch (e) { console.error('rails: event handler threw', e); }
    }
    const subs = events.get(event);
    if (subs) {
      for (const fn of subs) {
        try { fn(payload); } catch (e) { console.error('rails: event handler threw', e); }
      }
    }
    if (event === 'layout:change') {
      const onChange = options.onChange;
      if (typeof onChange === 'function') {
        try { onChange(inst.state); } catch (e) { console.error('rails: onChange threw', e); }
      }
    }
  };

  inst._reposition = () => reposition(inst);
  inst._renderChrome = () => {
    if (inst.batchDepth > 0) { inst.batchDirty = true; return; }
    renderChrome(inst);
  };
  inst._activate = (stack, tabId) => activateInPlace(inst, stack, tabId);
  inst._onTabDown = (e, tabId) => onTabDown(inst, e, tabId);
  inst._onSplitterDown = (e, kind, rail, idx) => onSplitterDown(inst, e, kind, rail, idx);
  inst._onFloatTitlebarDown = (e, floatId) => onFloatTitlebarDown(inst, e, floatId);
  inst._onFloatResizeDown = (e, floatId, dir) => onFloatResizeDown(inst, e, floatId, dir);
  inst._onStripKeyDown = (e, stack) => onStripKeyDown(inst, e, stack);
  inst._closeTab = (tabId) => closeTab(tabId);
  inst._toggleRailCollapsed = (railId) => toggleRailCollapsed(railId);
  inst._raiseFloat = (floatId) => raiseFloatInPlace(inst, floatId);
  inst._toggleFloatMinimized = (floatId) => toggleFloatMinimized(floatId);
  inst._toggleFloatMaximized = (floatId) => toggleFloatMaximized(floatId);
  inst._closeFloat = (floatId) => closeFloat(floatId);
  inst._freshId = (prefix) => freshId(inst.state, prefix);
  inst._cleanupAndRender = () => {
    cleanup(inst.state);
    reconcilePanels(inst);
    inst._renderChrome();
  };

  // Delegated click handler: close-× affordance. Routes through preserve if
  // the tab has preserveOnClose:true, otherwise destroys.
  host.addEventListener('click', e => {
    const tabId = e.target?.dataset?.closeTab;
    if (!tabId) return;
    const hit = findTab(inst.state, tabId);
    if (hit?.tab?.preserveOnClose) closeTab(tabId, { preserve: true });
    else closeTab(tabId);
  });

  // Pointerdown-to-raise for floats: hit-test against every float's screen
  // rect so clicks anywhere in a float's window (including its panel, which
  // lives in contentLayer, a separate DOM subtree) raise the float.
  host.addEventListener('pointerdown', e => {
    const floats = inst.state.floats;
    if (!floats || floats.length === 0) return;
    const wsRect = host.getBoundingClientRect();
    const x = e.clientX - wsRect.left;
    const y = e.clientY - wsRect.top;
    let top = null;
    for (const f of floats) {
      if (f.minimized) continue;
      if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) {
        if (!top || f.z > top.z) top = f;
      }
    }
    if (top) raiseFloatInPlace(inst, top.id);
  }, true);

  // Global keyboard shortcuts (only when focus is inside host).
  host.addEventListener('keydown', e => {
    if (!host.contains(document.activeElement) && document.activeElement !== host) return;
    // Ctrl-W / Cmd-W: close active tab of the focused stack. Routes through
    // preserve if the tab has preserveOnClose:true.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
      const stack = focusedStack(inst);
      if (stack && stack.active) {
        e.preventDefault();
        const activeTab = stack.tabs.find(t => t.id === stack.active);
        if (activeTab?.preserveOnClose) closeTab(stack.active, { preserve: true });
        else closeTab(stack.active);
      }
      return;
    }
    // Ctrl-Tab / Ctrl-Shift-Tab: cycle tabs within the focused stack.
    if (e.ctrlKey && e.key === 'Tab') {
      const stack = focusedStack(inst);
      if (stack && stack.tabs.length > 1) {
        e.preventDefault();
        const curIdx = Math.max(0, stack.tabs.findIndex(t => t.id === stack.active));
        const step = e.shiftKey ? -1 : 1;
        const nextIdx = (curIdx + step + stack.tabs.length) % stack.tabs.length;
        activateInPlace(inst, stack, stack.tabs[nextIdx].id);
      }
      return;
    }
  });

  // ResizeObserver syncs panel positions on host resize.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => reposition(inst));
    ro.observe(host);
  }
  window.addEventListener('resize', inst._reposition);

  // ── public methods ──

  function render() { renderChrome(inst); }

  function batch(fn) {
    inst.batchDepth++;
    try {
      fn();
    } finally {
      inst.batchDepth--;
      if (inst.batchDepth === 0 && inst.batchDirty) {
        inst.batchDirty = false;
        renderChrome(inst);
      }
    }
  }

  function addTab(tab, target) {
    if (!tab || !tab.id) throw new Error('rails: addTab requires tab with id');
    if (findTab(inst.state, tab.id)) {
      throw new Error(`rails: duplicate tab id ${tab.id}`);
    }

    // If this tab was previously closed-with-preserve, the cached panel is
    // about to become visible again. Drop it from the preserved set — the
    // tab is now live again. The panel element itself is reused automatically
    // via the panels Map (renderPanel won't be called again).
    inst.preservedTabs.delete(tab.id);

    const t = target || defaultAddTarget(inst.state);
    insertAtTarget(inst, tab, t);
    inst._renderChrome();
    // Emit float:create for the new-float target so consumers see the same
    // event whether a float was created via floatTab(id) or addTab(tab,
    // {to:'new-float'}). insertAtTarget pushes the new float to the end of
    // state.floats, so it's the last entry.
    if (t.to === 'new-float') {
      const float = inst.state.floats[inst.state.floats.length - 1];
      if (float) inst._emit('float:create', { float, tab });
    }
  }

  function closeTab(tabId, opts = {}) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    if (hit.tab.closeable === false) return;
    if (inst.callbacks.canCloseTab && !inst.callbacks.canCloseTab(hit.tab)) return;

    const from = { stackId: hit.stack.id, at: hit.idx };
    const tab = hit.tab;
    removeTabFromStack(inst.state, tabId);

    if (opts.preserve) {
      // Keep the panel element alive but hide it. Re-adding with the same
      // tab id reuses the cached element — renderPanel is NOT called again.
      const panel = inst.panels.get(tabId);
      if (panel) panel.style.display = 'none';
      inst.preservedTabs.set(tabId, tab);
    } else {
      // Normal close: destroy panel + fire onPanelDestroy.
      destroyPanel(inst, tabId, tab);
    }

    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('tab:close', { tab, from, preserved: !!opts.preserve });
  }

  function activateTab(tabId) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    activateInPlace(inst, hit.stack, tabId);
  }

  function moveTab(tabId, target) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    const from = { stackId: hit.stack.id, at: hit.idx };

    if (inst.callbacks.canMoveTab && !inst.callbacks.canMoveTab(hit.tab, from, target)) return;

    // Remove from source, insert at target, cleanup, re-render.
    const tab = hit.tab;
    hit.stack.tabs.splice(hit.idx, 1);
    if (hit.stack.active === tabId && hit.stack.tabs.length) {
      hit.stack.active = hit.stack.tabs[Math.max(0, hit.idx - 1)].id;
    }
    insertAtTarget(inst, tab, target);
    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('tab:move', { tab, from, to: target });
  }

  function updateTab(tabId, patch) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    const { changed, chromeVisible } = patchTab(inst.state, tabId, patch);
    if (!changed) return;
    if (chromeVisible) {
      if (inst.batchDepth > 0) { inst.batchDirty = true; return; }
      rebuildStrip(inst, hit.stack.id);
    }
    // Non-chrome-visible: state mutated, no re-render. Consumer sees the change
    // in inst.state and is responsible for panel-side refresh if needed.
  }

  function floatTab(tabId, bounds) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    if (inst.callbacks.canCreateFloat && !inst.callbacks.canCreateFloat(hit.tab, bounds)) return;

    const tab = hit.tab;
    const from = hit.container === 'float'
      ? { floatId: hit.float.id, at: hit.idx }
      : { stackId: hit.stack.id, at: hit.idx };

    hit.stack.tabs.splice(hit.idx, 1);
    if (hit.stack.active === tabId && hit.stack.tabs.length) {
      hit.stack.active = hit.stack.tabs[Math.max(0, hit.idx - 1)].id;
    }

    const w = bounds?.w ?? inst.config.defaultFloatSize?.w ?? 400;
    const h = bounds?.h ?? inst.config.defaultFloatSize?.h ?? 300;
    const x = bounds?.x ?? 80;
    const y = bounds?.y ?? 80;
    const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
    const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const float = {
      id: inst._freshId('f'),
      stack,
      x, y, w, h,
      z: maxZ + 1,
    };
    if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
    inst.state.floats.push(float);

    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('float:create', { float, tab });
    inst._emit('tab:move', { tab, from, to: { to: 'float', floatId: float.id } });
  }

  function redockTab(tabId, target) {
    moveTab(tabId, target);
  }

  function setFloatBounds(floatId, bounds) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    const from = { x: float.x, y: float.y, w: float.w, h: float.h };
    setFloatBoundsInPlace(inst, floatId, bounds);
    const to = { x: float.x, y: float.y, w: float.w, h: float.h };
    // Emit move or resize depending on what changed.
    if ('w' in bounds || 'h' in bounds) inst._emit('float:resize', { float, from, to });
    else inst._emit('float:move', { float, from, to });
  }

  function raiseFloat(floatId) {
    raiseFloatInPlace(inst, floatId);
  }

  function toggleFloatMinimized(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    float.minimized = !float.minimized;
    // Update DOM class + visibility in place on both the float and its
    // handles-overlay sibling; emit event.
    const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
    if (el) el.classList.toggle('rails-minimized', !!float.minimized);
    const handlesEl = inst.chromeLayer.querySelector(
      `.rails-float-handles[data-handles-for="${cssEscape(floatId)}"]`
    );
    if (handlesEl) handlesEl.classList.toggle('rails-minimized', !!float.minimized);
    reposition(inst);
    inst._emit('float:minimize', { float });
  }

  function toggleFloatMaximized(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    if (!float.maximized) {
      // Snapshot pre-max bounds, fill workspace.
      float._preMax = { x: float.x, y: float.y, w: float.w, h: float.h };
      const hostRect = host.getBoundingClientRect();
      float.maximized = true;
      setFloatBoundsInPlace(inst, floatId, { x: 0, y: 0, w: hostRect.width, h: hostRect.height });
    } else {
      // Restore.
      const snap = float._preMax || { x: 80, y: 80, w: 400, h: 300 };
      float.maximized = false;
      setFloatBoundsInPlace(inst, floatId, snap);
      delete float._preMax;
    }
    // Re-render chrome so max button glyph updates and maximize class is set.
    inst._renderChrome();
    inst._emit('float:maximize', {
      float,
      from: float.maximized ? null : float._preMax,
    });
  }

  function toggleRailCollapsed(railId) {
    const rail = findRail(inst.state, railId);
    if (!rail) return;
    rail.collapsed = !rail.collapsed;
    inst._renderChrome();
    inst._emit(rail.collapsed ? 'rail:collapse' : 'rail:expand', { rail });
  }

  function releasePreservedPanel(tabId) {
    if (!inst.preservedTabs.has(tabId)) return;
    const tab = inst.preservedTabs.get(tabId);
    inst.preservedTabs.delete(tabId);
    destroyPanel(inst, tabId, tab);
  }

  function listPreservedPanels() {
    return [...inst.preservedTabs.entries()].map(([id, tab]) => ({ id, tab }));
  }

  function closeFloat(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    // Delegate each tab through closeTab so its preserveOnClose flag routes
    // to preserve instead of destroy (matching UI behavior for rail tabs).
    // canCloseTab / closeable:false checks and tab:close emission happen
    // inside closeTab. batch() collapses the repeated cleanups into one
    // chrome rebuild.
    const tabs = [...(float.stack?.tabs || [])];
    batch(() => {
      for (const tab of tabs) {
        closeTab(tab.id, { preserve: !!tab.preserveOnClose });
      }
    });
    // Only emit float:close if the float was actually removed (all tabs
    // closed or preserved; none refused via canCloseTab / closeable:false).
    if (!findFloat(inst.state, floatId)) {
      inst._emit('float:close', { float });
    }
  }

  function on(event, handler) {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    events.get(event)?.delete(handler);
  }

  function serialize(replacer) {
    return serializeState(inst.state, replacer);
  }

  function deserialize(str) {
    const next = JSON.parse(str);
    if (!Array.isArray(next.floats)) next.floats = [];
    if (next.rails.length > 0) validateState(next);
    inst.state = next;
    // Deserialize evicts preserved panels whose ids aren't in the new state —
    // reconcilePanels handles the DOM + onPanelDestroy; we clear the preserved
    // bookkeeping for those too so it doesn't drift from the panel cache.
    const nextIds = liveTabIds(next);
    for (const [id] of inst.preservedTabs) {
      if (!nextIds.has(id)) inst.preservedTabs.delete(id);
    }
    reconcilePanels(inst);
    renderChrome(inst);
  }

  function destroy() {
    destroyAllPanels(inst);
    inst.preservedTabs.clear();
    ro?.disconnect();
    window.removeEventListener('resize', inst._reposition);
    host.classList.remove('rails-root');
    chromeLayer.remove();
    contentLayer.remove();
  }

  // Initial render.
  renderChrome(inst);

  return {
    get state() { return inst.state; },
    render,
    batch,
    addTab,
    closeTab,
    activateTab,
    moveTab,
    updateTab,
    floatTab,
    redockTab,
    setFloatBounds,
    raiseFloat,
    toggleFloatMinimized,
    toggleFloatMaximized,
    closeFloat,
    toggleRailCollapsed,
    releasePreservedPanel,
    listPreservedPanels,
    on,
    off,
    serialize,
    deserialize,
    destroy,
  };
}

// Keyboard navigation on a tab strip (arrow keys, home/end, delete).
function onStripKeyDown(inst, e, stack) {
  const tabs = stack.tabs;
  if (tabs.length === 0) return;
  const curIdx = Math.max(0, tabs.findIndex(t => t.id === stack.active));
  let nextIdx = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (curIdx + 1) % tabs.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') nextIdx = 0;
  else if (e.key === 'End') nextIdx = tabs.length - 1;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    const active = tabs[curIdx];
    if (active && active.closeable !== false) {
      e.preventDefault();
      inst._closeTab?.(active.id);
    }
    return;
  }
  if (nextIdx != null && nextIdx !== curIdx) {
    e.preventDefault();
    activateInPlaceFromInst(inst, stack, tabs[nextIdx].id);
    // Move focus to the now-active tab element.
    const newActive = tabs[nextIdx];
    const tabEl = inst.chromeLayer.querySelector(
      `.rails-strip[data-stack-id="${cssEscape(stack.id)}"] .rails-tab[data-tab-id="${cssEscape(newActive.id)}"]`
    );
    tabEl?.focus?.();
  }
}

function activateInPlaceFromInst(inst, stack, tabId) {
  activateInPlace(inst, stack, tabId);
}

// Find the stack whose DOM tree contains document.activeElement. Used for
// keyboard-focused shortcuts (Ctrl-W, Ctrl-Tab).
function focusedStack(inst) {
  const active = document.activeElement;
  if (!active) return null;
  const stripEl = active.closest?.('.rails-strip, .rails-stack');
  const stackId = stripEl?.dataset?.stackId;
  if (!stackId) return null;
  for (const rail of inst.state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  for (const float of inst.state.floats || []) {
    if (float.stack?.id === stackId) return float.stack;
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────

function defaultAddTarget(state) {
  if (state.rails.length === 0) {
    // Caller is asking us to auto-create the first rail/stack. Signal this
    // via a synthetic target that insertAtTarget understands.
    return { to: '__bootstrap' };
  }
  const firstStack = state.rails[0].stacks[0];
  return { to: 'stack', stackId: firstStack.id };
}

function insertAtTarget(inst, tab, target) {
  if (!target || typeof target !== 'object') {
    throw new Error('rails: invalid MoveTarget');
  }
  switch (target.to) {
    case '__bootstrap': {
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const rail = { id: inst._freshId('r'), flex: 1, stacks: [stack] };
      inst.state.rails.push(rail);
      break;
    }
    case 'stack': {
      const stack = findStackByIdInState(inst.state, target.stackId);
      if (!stack) throw new Error(`rails: stack ${target.stackId} not found`);
      const at = target.at == null ? stack.tabs.length : target.at;
      stack.tabs.splice(at, 0, tab);
      stack.active = tab.id;
      break;
    }
    case 'new-rail': {
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const rail = { id: inst._freshId('r'), flex: 1, stacks: [stack] };
      const at = target.at ?? inst.state.rails.length;
      inst.state.rails.splice(at, 0, rail);
      break;
    }
    case 'new-stack': {
      const rail = findRail(inst.state, target.railId);
      if (!rail) throw new Error(`rails: rail ${target.railId} not found`);
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const at = target.at ?? rail.stacks.length;
      rail.stacks.splice(at, 0, stack);
      break;
    }
    case 'float': {
      const float = findFloat(inst.state, target.floatId);
      if (!float) throw new Error(`rails: float ${target.floatId} not found`);
      if (!float.stack) throw new Error(`rails: float ${target.floatId} missing stack`);
      const at = target.at == null ? float.stack.tabs.length : target.at;
      float.stack.tabs.splice(at, 0, tab);
      float.stack.active = tab.id;
      break;
    }
    case 'new-float': {
      const w = target.w ?? inst.config.defaultFloatSize?.w ?? 400;
      const h = target.h ?? inst.config.defaultFloatSize?.h ?? 300;
      const x = target.x ?? 80;
      const y = target.y ?? 80;
      const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const float = {
        id: inst._freshId('f'),
        stack,
        x, y, w, h,
        z: maxZ + 1,
      };
      if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
      inst.state.floats.push(float);
      break;
    }
    default:
      throw new Error(`rails: unknown MoveTarget ${target.to}`);
  }
}

function findStackByIdInState(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  return null;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function toCamel(s) {
  return s.replace(/[:-](.)/g, (_, c) => c.toUpperCase());
}
