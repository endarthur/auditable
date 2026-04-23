// @gcu/rails — tab drag, splitter drag, float drag/resize, drop zones, Escape-cancel
// All drag state lives on the instance (inst.drag); no module-scoped mutables.

import { findTab, findFloat } from './state.js';
import { cssEscape, setFloatBoundsInPlace, raiseFloatInPlace } from './render.js';

// ── splitter drag ─────────────────────────────────────────────────────────

const MIN_RAIL_WIDTH = 140;
const MIN_STACK_HEIGHT = 100;

export function onSplitterDown(inst, e, kind, rail, idx) {
  e.preventDefault();
  e.stopPropagation();

  const snapshot = [];
  if (kind === 'rail') {
    const a = inst.state.rails[idx], b = inst.state.rails[idx + 1];
    snapshot.push({ target: a, flex: a.flex });
    snapshot.push({ target: b, flex: b.flex });
  } else {
    const a = rail.stacks[idx], b = rail.stacks[idx + 1];
    snapshot.push({ target: a, flex: a.flex });
    snapshot.push({ target: b, flex: b.flex });
  }

  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  const onMove = ev => {
    if (kind === 'rail') {
      const a = inst.state.rails[idx], b = inst.state.rails[idx + 1];
      const ae = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(a.id)}"]`);
      const be = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(b.id)}"]`);
      if (!ae || !be) return;
      const ra = ae.getBoundingClientRect(), rb = be.getBoundingClientRect();
      const total = ra.width + rb.width;
      const totalFlex = (a.flex ?? 1) + (b.flex ?? 1);
      const w = Math.max(MIN_RAIL_WIDTH, Math.min(total - MIN_RAIL_WIDTH, ev.clientX - ra.left));
      a.flex = (w / total) * totalFlex;
      b.flex = totalFlex - a.flex;
      ae.style.flex = a.flex;
      be.style.flex = b.flex;
    } else {
      const a = rail.stacks[idx], b = rail.stacks[idx + 1];
      const ae = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(a.id)}"]`);
      const be = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(b.id)}"]`);
      if (!ae || !be) return;
      const ra = ae.getBoundingClientRect(), rb = be.getBoundingClientRect();
      const total = ra.height + rb.height;
      const totalFlex = (a.flex ?? 1) + (b.flex ?? 1);
      const h = Math.max(MIN_STACK_HEIGHT, Math.min(total - MIN_STACK_HEIGHT, ev.clientY - ra.top));
      a.flex = (h / total) * totalFlex;
      b.flex = totalFlex - a.flex;
      ae.style.flex = a.flex;
      be.style.flex = b.flex;
    }
    inst._reposition();
  };

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
    inst.drag = null;
  };

  const onUp = () => {
    cleanup();
    inst._emit('layout:change', { state: inst.state });
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    for (const snap of snapshot) snap.target.flex = snap.flex;
    cleanup();
    inst._renderChrome();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);

  inst.drag = { kind: 'splitter' };
}

// ── tab drag ──────────────────────────────────────────────────────────────

export function onTabDown(inst, e, tabId) {
  if (e.target.dataset.closeTab) return;
  if (e.button !== 0) return;
  e.preventDefault();

  const hit = findTab(inst.state, tabId);
  if (!hit) return;
  if (hit.tab.draggable === false) {
    const onUp = () => {
      document.removeEventListener('pointerup', onUp);
      inst._activate(hit.stack, tabId);
    };
    document.addEventListener('pointerup', onUp);
    return;
  }

  // Capture the pointer on the tab element so the move/up fire there even
  // if the finger leaves it (esp. touch).
  try { e.target.setPointerCapture?.(e.pointerId); } catch {}

  const pointerType = e.pointerType;
  const startX = e.clientX, startY = e.clientY;
  const threshold = inst.config.dragThreshold ?? 4;
  let started = false;

  const onMove = ev => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < threshold) return;
      started = true;
      beginTabDrag(inst, hit.tab, pointerType);
    }
    updateTabDrag(inst, ev);
  };

  const onUp = ev => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    if (started) {
      endTabDrag(inst, ev);
    } else {
      const h = findTab(inst.state, tabId);
      if (h) inst._activate(h.stack, tabId);
    }
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (started) cancelTabDrag(inst);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

// ── float titlebar drag (either moves float, or redocks into rails) ───────

export function onFloatTitlebarDown(inst, e, floatId) {
  // Ignore clicks on titlebar buttons.
  if (e.target.closest('.rails-titlebar-buttons')) return;
  if (e.button !== 0) return;
  e.preventDefault();

  const float = findFloat(inst.state, floatId);
  if (!float) return;
  if (float.maximized) return; // can't drag a maximized float

  // Raise on pointerdown.
  raiseFloatInPlace(inst, floatId);

  const startX = e.clientX, startY = e.clientY;
  const origX = float.x, origY = float.y, origW = float.w, origH = float.h;
  const grabOffset = { dx: e.clientX - float.x, dy: e.clientY - float.y };
  const threshold = inst.config.dragThreshold ?? 4;
  let started = false;
  let dragMode = null; // 'move' | 'redock'

  const onMove = ev => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < threshold) return;
      started = true;
      // Begin as a move. If the cursor enters a rails drop zone during the drag,
      // we'll transition into 'redock' mode (showing zones, allowing drop).
      dragMode = 'move';
      beginFloatDrag(inst, float, origX, origY, origW, origH);
    }
    updateFloatDrag(inst, ev, float, grabOffset);
  };

  const onUp = ev => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    if (started) endFloatDrag(inst, ev, float);
    // else: click on titlebar with no drag; the raise above already fired.
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (started) {
      // Restore pre-drag bounds.
      setFloatBoundsInPlace(inst, floatId, { x: origX, y: origY, w: origW, h: origH });
      teardownFloatDrag(inst);
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

function beginFloatDrag(inst, float, origX, origY, origW, origH) {
  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  // Compute rails drop zones (not new-float — the float itself is being dragged)
  // so the user can redock onto rails by dropping on a rail zone. Exclude the
  // dragging float's own titlebar from the zone set — dropping a float on itself
  // is a no-op.
  const activeTab = float.stack?.tabs.find(t => t.id === float.stack.active);
  const zones = activeTab ? computeRedockZones(inst, activeTab, float.id) : [];
  const zoneEls = zones.map(z => makeZoneEl(inst, z));

  inst.drag = {
    kind: 'float',
    float,
    origBounds: { x: origX, y: origY, w: origW, h: origH },
    scrim,
    zones,
    zoneEls,
    active: null,
  };
}

function updateFloatDrag(inst, ev, float, grabOffset) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  // Move float by pointer.
  const newX = ev.clientX - grabOffset.dx;
  const newY = ev.clientY - grabOffset.dy;
  setFloatBoundsInPlace(inst, float.id, { x: newX, y: newY });

  // Hit-test redock zones.
  const wsRect = inst.host.getBoundingClientRect();
  const lx = ev.clientX - wsRect.left;
  const ly = ev.clientY - wsRect.top;
  let best = null, bestScore = Infinity;
  for (const z of drag.zones) {
    const r = z.rect;
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
      const area = r.w * r.h;
      const score = z.priority === 'body-append' ? area + 1e9 : area;
      if (score < bestScore) { best = z; bestScore = score; }
    }
  }
  drag.zoneEls.forEach((el, i) => el.classList.toggle('rails-active', drag.zones[i] === best));
  drag.active = best;
}

function endFloatDrag(inst, ev, float) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  const { active } = drag;
  teardownFloatDrag(inst);

  if (!active) {
    // Plain move; emit event.
    inst._emit('float:move', {
      float,
      from: drag.origBounds,
      to: { x: float.x, y: float.y, w: float.w, h: float.h }
    });
    inst.drag = null;
    return;
  }

  // Redock: destroy float, move each of its tabs to the target stack.
  // We preserve tab order; the active tab in the float stays active post-redock.
  const tabs = [...float.stack.tabs];
  const activeId = float.stack.active;
  const toDesc = zoneToMoveTarget(active);

  // Remove the float first.
  inst.state.floats = inst.state.floats.filter(f => f.id !== float.id);

  // For multi-tab redock, create the target stack once (if needed) then
  // append all tabs into it. For stack/append-type targets, just append.
  const destStack = resolveRedockDestination(inst, active);
  if (destStack) {
    for (const tab of tabs) destStack.tabs.push(tab);
    destStack.active = activeId;
  }

  inst.drag = null;
  inst._cleanupAndRender();
  inst._emit('float:close', { float });
  inst._emit('tab:move', {
    tab: tabs[0],
    from: { floatId: float.id },
    to: toDesc
  });
}

// Resolve (or create) the target stack for redocking a float's tabs in bulk.
// For 'new-rail'/'new-stack' targets, creates the container. For stack/insert
// targets, returns the existing stack.
function resolveRedockDestination(inst, zone) {
  if (zone.type === 'new-rail') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [], active: null };
    const nr = { id: inst._freshId('r'), flex: 1, stacks: [ns] };
    inst.state.rails.splice(zone.at, 0, nr);
    return ns;
  }
  if (zone.type === 'new-stack') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [], active: null };
    const rail = inst.state.rails.find(r => r.id === zone.railId);
    if (rail) rail.stacks.splice(zone.at, 0, ns);
    return ns;
  }
  if (zone.type === 'tab-insert' || zone.type === 'tab-append') {
    return findStackById(inst.state, zone.stackId);
  }
  if (zone.type === 'float-titlebar') {
    const f = findFloat(inst.state, zone.floatId);
    return f?.stack || null;
  }
  return null;
}

function teardownFloatDrag(inst) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  drag.scrim?.remove();
  drag.zoneEls?.forEach(el => el.remove());
  for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
}

// ── float resize (8 handles) ──────────────────────────────────────────────

export function onFloatResizeDown(inst, e, floatId, dir) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const float = findFloat(inst.state, floatId);
  if (!float || float.maximized || float.minimized) return;

  const startX = e.clientX, startY = e.clientY;
  const origX = float.x, origY = float.y, origW = float.w, origH = float.h;
  const minW = inst.config.minFloatSize?.w ?? 200;
  const minH = inst.config.minFloatSize?.h ?? 120;

  raiseFloatInPlace(inst, floatId);

  for (const p of inst.panels.values()) p.classList.add('rails-dragging');
  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  inst.drag = { kind: 'float-resize', float, origBounds: { x: origX, y: origY, w: origW, h: origH }, scrim };

  const onMove = ev => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let nx = origX, ny = origY, nw = origW, nh = origH;
    if (dir.includes('e')) nw = Math.max(minW, origW + dx);
    if (dir.includes('s')) nh = Math.max(minH, origH + dy);
    if (dir.includes('w')) {
      const newW = Math.max(minW, origW - dx);
      nx = origX + (origW - newW);
      nw = newW;
    }
    if (dir.includes('n')) {
      const newH = Math.max(minH, origH - dy);
      ny = origY + (origH - newH);
      nh = newH;
    }
    setFloatBoundsInPlace(inst, floatId, { x: nx, y: ny, w: nw, h: nh });
  };

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
    inst.drag = null;
  };

  const onUp = () => {
    const from = { x: origX, y: origY, w: origW, h: origH };
    const to = { x: float.x, y: float.y, w: float.w, h: float.h };
    cleanup();
    inst._emit('float:resize', { float, from, to });
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    setFloatBoundsInPlace(inst, floatId, { x: origX, y: origY, w: origW, h: origH });
    cleanup();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

// ── tab drag internals ────────────────────────────────────────────────────

function beginTabDrag(inst, tab, pointerType) {
  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  const ghost = document.createElement('div');
  ghost.className = 'rails-ghost';
  const label = document.createElement('span');
  label.textContent = tab.title ?? tab.id;
  ghost.appendChild(label);
  inst.host.appendChild(ghost);

  const zones = computeZones(inst, tab, pointerType === 'touch');
  const zoneEls = zones.map(z => makeZoneEl(inst, z));

  inst.drag = {
    kind: 'tab',
    tab,
    ghost,
    scrim,
    zones,
    zoneEls,
    active: null,
  };
}

function updateTabDrag(inst, ev) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  const wsRect = inst.host.getBoundingClientRect();
  const lx = ev.clientX - wsRect.left;
  const ly = ev.clientY - wsRect.top;
  drag.ghost.style.left = (lx + 14) + 'px';
  drag.ghost.style.top = (ly + 14) + 'px';

  let best = null, bestScore = Infinity;
  for (const z of drag.zones) {
    const r = z.rect;
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
      const area = r.w * r.h;
      const score = z.priority === 'body-append' ? area + 1e9
                  : z.priority === 'new-float' ? area + 2e9
                  : area;
      if (score < bestScore) { best = z; bestScore = score; }
    }
  }
  drag.zoneEls.forEach((el, i) => el.classList.toggle('rails-active', drag.zones[i] === best));
  drag.active = best;
  // Stash cursor position for new-float targets (so tear-off places the float
  // at drop point, not at a static rect origin).
  if (best && best.type === 'new-float') {
    best._cursorX = lx - 60;  // offset so the ghost-tearing point becomes titlebar-ish
    best._cursorY = ly - 10;
  }
}

function endTabDrag(inst, ev) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  const { tab, active } = drag;
  teardownTabDrag(inst);

  if (!active) {
    inst.drag = null;
    return;
  }

  const src = findTab(inst.state, tab.id);
  if (!src) { inst.drag = null; return; }

  const fromDesc = src.container === 'float'
    ? { floatId: src.float.id, at: src.idx }
    : { stackId: src.stack.id, at: src.idx };
  const toDesc = zoneToMoveTarget(active);

  if (active.type === 'new-float' && inst.callbacks.canCreateFloat) {
    if (!inst.callbacks.canCreateFloat(tab, { x: active.rect.x, y: active.rect.y })) {
      inst.drag = null;
      return;
    }
  }

  if (inst.callbacks.canMoveTab && !inst.callbacks.canMoveTab(tab, fromDesc, toDesc)) {
    inst.drag = null;
    return;
  }

  // Remove from source.
  src.stack.tabs.splice(src.idx, 1);
  if (src.stack.active === tab.id && src.stack.tabs.length) {
    src.stack.active = src.stack.tabs[Math.max(0, src.idx - 1)].id;
  }

  // Apply target.
  applyMoveTarget(inst, tab, active, src.stack);
  inst.drag = null;

  inst._cleanupAndRender();

  // If we tore off into a new float, emit float:create.
  if (active.type === 'new-float') {
    const newFloat = inst.state.floats[inst.state.floats.length - 1];
    if (newFloat) inst._emit('float:create', { float: newFloat, tab });
  }
  inst._emit('tab:move', { tab, from: fromDesc, to: toDesc });
}

function cancelTabDrag(inst) {
  teardownTabDrag(inst);
  inst.drag = null;
}

function teardownTabDrag(inst) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  drag.ghost?.remove();
  drag.scrim?.remove();
  drag.zoneEls?.forEach(el => el.remove());
  for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
}

// ── drop zone computation ─────────────────────────────────────────────────

function makeZoneEl(inst, z) {
  const el = document.createElement('div');
  el.className = 'rails-zone';
  if (z.type === 'tab-insert') el.classList.add('rails-zone-insert');
  if (z.type === 'new-float') el.classList.add('rails-zone-float');
  if (z.type === 'new-rail' || z.type === 'new-stack') el.classList.add('rails-zone-new');
  el.style.left = z.rect.x + 'px';
  el.style.top = z.rect.y + 'px';
  el.style.width = z.rect.w + 'px';
  el.style.height = z.rect.h + 'px';
  inst.host.appendChild(el);
  return el;
}

// Zones for a tab drag — includes new-float.
function computeZones(inst, tab, touch) {
  const zones = collectRailsZones(inst);
  collectFloatTitlebarZones(inst, zones);
  const dropZones = inst.config.dropZones || {};
  if (dropZones['new-float'] !== false) {
    const wsRect = inst.host.getBoundingClientRect();
    zones.push({
      type: 'new-float',
      rect: { x: 0, y: 0, w: wsRect.width, h: wsRect.height },
      priority: 'new-float',
    });
  }
  if (touch) inflateZonesForTouch(zones);
  return filterZones(inst, zones, tab);
}

// Expand narrow drop zones so they remain usable with finger-sized pointers.
function inflateZonesForTouch(zones) {
  for (const z of zones) {
    // tab-insert is narrowest (6px). Expand to ~20px.
    if (z.type === 'tab-insert') {
      z.rect.x -= 7;
      z.rect.w += 14;
    }
    // new-rail and new-stack gaps — widen from 18px to 30px.
    if (z.type === 'new-rail' || z.type === 'new-stack') {
      if (z.rect.w < 20) { z.rect.x -= 6; z.rect.w += 12; }
      if (z.rect.h < 20) { z.rect.y -= 6; z.rect.h += 12; }
    }
  }
}

// Zones for float redock (float titlebar dragged onto rails) — rails-only,
// no new-float (can't redock into another new float). excludeFloatId skips
// the dragging float's own titlebar zone so self-drops don't happen.
function computeRedockZones(inst, tab, excludeFloatId) {
  const zones = collectRailsZones(inst);
  collectFloatTitlebarZones(inst, zones, excludeFloatId);
  return filterZones(inst, zones, tab);
}

function filterZones(inst, zones, tab) {
  if (inst.callbacks.canDropOn) {
    return zones.filter(z => inst.callbacks.canDropOn(z, tab));
  }
  return zones;
}

function collectRailsZones(inst) {
  const zones = [];
  const wsRect = inst.host.getBoundingClientRect();
  const dropZones = inst.config.dropZones || {};
  const enabled = (type) => dropZones[type] !== false;

  inst.state.rails.forEach((rail, ri) => {
    const railEl = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(rail.id)}"]`);
    if (!railEl) return;
    const rr = railEl.getBoundingClientRect();

    if (ri === 0 && enabled('new-rail')) {
      zones.push({ type: 'new-rail', at: 0,
        rect: { x: 0, y: 0, w: 12, h: wsRect.height } });
    }
    if (enabled('new-rail')) {
      const nextLeft = ri < inst.state.rails.length - 1
        ? inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(inst.state.rails[ri + 1].id)}"]`).getBoundingClientRect().left
        : wsRect.right;
      const gx = (rr.right + nextLeft) / 2 - wsRect.left;
      zones.push({ type: 'new-rail', at: ri + 1,
        rect: { x: gx - 9, y: 0, w: 18, h: wsRect.height } });
    }

    rail.stacks.forEach((stack, si) => {
      const stackEl = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(stack.id)}"]`);
      if (!stackEl) return;
      const sr = stackEl.getBoundingClientRect();

      if (si === 0 && enabled('new-stack')) {
        zones.push({ type: 'new-stack', railId: rail.id, at: 0,
          rect: { x: rr.left - wsRect.left, y: rr.top - wsRect.top, w: rr.width, h: 12 } });
      }
      if (enabled('new-stack')) {
        const nextTop = si < rail.stacks.length - 1
          ? inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(rail.stacks[si + 1].id)}"]`).getBoundingClientRect().top
          : rr.bottom;
        const gy = (sr.bottom + nextTop) / 2 - wsRect.top;
        zones.push({ type: 'new-stack', railId: rail.id, at: si + 1,
          rect: { x: rr.left - wsRect.left, y: gy - 9, w: rr.width, h: 18 } });
      }

      const strip = stackEl.querySelector('.rails-strip');
      if (!strip) return;
      const stripRect = strip.getBoundingClientRect();

      if (enabled('tab-append-strip')) {
        zones.push({ type: 'tab-append', stackId: stack.id,
          rect: { x: stripRect.left - wsRect.left, y: stripRect.top - wsRect.top,
                  w: stripRect.width, h: stripRect.height } });
      }

      if (enabled('tab-insert')) {
        const tabEls = strip.querySelectorAll('.rails-tab');
        const inserts = [];
        tabEls.forEach((t, ti) => {
          const r = t.getBoundingClientRect();
          inserts.push({ x: r.left, at: ti });
        });
        inserts.push({ x: stripRect.right, at: tabEls.length });
        inserts.forEach(ins => {
          zones.push({ type: 'tab-insert', stackId: stack.id, at: ins.at,
            rect: { x: ins.x - wsRect.left - 3, y: stripRect.top - wsRect.top,
                    w: 6, h: stripRect.height } });
        });
      }

      if (enabled('tab-append-body')) {
        const slot = stackEl.querySelector('.rails-slot');
        if (slot) {
          const slotRect = slot.getBoundingClientRect();
          zones.push({ type: 'tab-append', stackId: stack.id,
            rect: { x: slotRect.left - wsRect.left, y: slotRect.top - wsRect.top,
                    w: slotRect.width, h: slotRect.height },
            priority: 'body-append' });
        }
      }
    });
  });
  return zones;
}

function collectFloatTitlebarZones(inst, zones, excludeFloatId) {
  const wsRect = inst.host.getBoundingClientRect();
  const dropZones = inst.config.dropZones || {};
  if (dropZones['float-titlebar'] === false) return;
  for (const float of inst.state.floats || []) {
    if (float.id === excludeFloatId) continue;
    if (float.minimized || float.maximized) continue;
    const floatEl = inst.floatsLayer?.querySelector(`.rails-float[data-float-id="${cssEscape(float.id)}"]`);
    if (!floatEl) continue;
    const titlebar = floatEl.querySelector('.rails-titlebar');
    if (!titlebar) continue;
    const tr = titlebar.getBoundingClientRect();
    zones.push({
      type: 'float-titlebar',
      floatId: float.id,
      rect: { x: tr.left - wsRect.left, y: tr.top - wsRect.top,
              w: tr.width, h: tr.height },
    });
  }
}

function zoneToMoveTarget(zone) {
  switch (zone.type) {
    case 'new-rail':  return { to: 'new-rail', at: zone.at };
    case 'new-stack': return { to: 'new-stack', railId: zone.railId, at: zone.at };
    case 'tab-insert':return { to: 'stack', stackId: zone.stackId, at: zone.at };
    case 'tab-append':return { to: 'stack', stackId: zone.stackId };
    case 'new-float': return { to: 'new-float', x: zone._cursorX ?? 100, y: zone._cursorY ?? 100 };
    case 'float-titlebar': return { to: 'float', floatId: zone.floatId };
    default:          return null;
  }
}

function applyMoveTarget(inst, tab, zone, srcStack) {
  if (zone.type === 'new-rail') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const nr = { id: inst._freshId('r'), flex: 1, stacks: [ns] };
    inst.state.rails.splice(zone.at, 0, nr);
  } else if (zone.type === 'new-stack') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const rail = inst.state.rails.find(r => r.id === zone.railId);
    if (rail) rail.stacks.splice(zone.at, 0, ns);
  } else if (zone.type === 'tab-insert') {
    const target = findStackById(inst.state, zone.stackId);
    if (target) {
      let at = zone.at;
      if (target === srcStack) at = Math.min(at, target.tabs.length);
      target.tabs.splice(at, 0, tab);
      target.active = tab.id;
    }
  } else if (zone.type === 'tab-append') {
    const target = findStackById(inst.state, zone.stackId);
    if (target) {
      target.tabs.push(tab);
      target.active = tab.id;
    }
  } else if (zone.type === 'new-float') {
    const cx = zone._cursorX ?? 100;
    const cy = zone._cursorY ?? 100;
    const w = inst.config.defaultFloatSize?.w ?? 400;
    const h = inst.config.defaultFloatSize?.h ?? 300;
    const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
    const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const float = {
      id: inst._freshId('f'),
      stack,
      x: cx, y: cy, w, h,
      z: maxZ + 1,
    };
    if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
    inst.state.floats.push(float);
  } else if (zone.type === 'float-titlebar') {
    const float = findFloat(inst.state, zone.floatId);
    if (float && float.stack) {
      float.stack.tabs.push(tab);
      float.stack.active = tab.id;
    }
  }
}

function findStackById(state, stackId) {
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
