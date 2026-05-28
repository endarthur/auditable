// @gcu/patchbay — pointer/gesture interaction. Ported from the v0 sketch and
// routed to the engine (cables, knobs, placement) + the renderer (hit-tests,
// view transform). Exposes a mutable `state` the render loop reads each frame,
// and a `detach()`.
//
// v1 is grid-only (modules snap to row + HP slot); free placement is deferred.
// Gestures: drag jack → wire; drag knob → turn; drag panel → move; drag empty
// → pan; two pointers → pinch; wheel → zoom.

import { HP, RAIL_LEFT } from './render.js';

export function attachInteraction(renderer, engine, canvas, opts = {}) {
  const onChange = opts.onChange || (() => {});       // mark dirty
  const onSelect = opts.onSelect || (() => {});       // selection changed → id|null
  const onConfigure = opts.onConfigure || (() => {}); // explicit configure (double-click) → id
  const wireColor = opts.wireColor || (() => null);    // current 'pen' color role for new cables
  let _lastModClick = null;                            // { id, t } for double-click detection
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const state = {
    railsOn: true,
    dragGhost: null,
    dragCable: null,            // { from?, to?, mouse:{x,y} }
    hoveredPort: null,
    selectedId: null,
    mouse: { x: 0, y: 0 },
  };

  const pointers = new Map();
  let gesture = null;
  let lastInputType = 'mouse';

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }
  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    onSelect(id);
  }

  function onDown(e) {
    // Ignore secondary buttons (right/middle) — right-click is the context
    // menu (handled in mount.js); starting a gesture here would dangle since
    // no pointerup follows a context-menu open.
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    lastInputType = e.pointerType === 'touch' ? 'touch' : 'mouse';
    const { sx, sy } = canvasPoint(e);
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    pointers.set(e.pointerId, { sx, sy, wx, wy });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const midSx = (a.sx + b.sx) / 2, midSy = (a.sy + b.sy) / 2;
      const dist = Math.hypot(b.sx - a.sx, b.sy - a.sy) || 1;
      if (!gesture || gesture.kind === 'pan') {
        gesture = { kind: 'pinch', startDist: dist, startScale: renderer.view.scale,
                    startWorldMid: renderer.screenToWorld(midSx, midSy) };
      }
      return;
    }

    // jack → wire
    const portHit = renderer.findPortAt(wx, wy, lastInputType);
    if (portHit) {
      select(portHit.id);
      if (portHit.side === 'out') {
        // new cable from this output
        gesture = { kind: 'wire', from: { id: portHit.id, port: portHit.port }, pointerId: e.pointerId };
      } else {
        // input: re-route its existing cable (disconnect, drag from its source)
        const cab = engine.cables.find((c) => c.to.id === portHit.id && c.to.port === portHit.port);
        if (cab) {
          const from = { id: cab.from.id, port: cab.from.port };
          engine.disconnect({ id: portHit.id, port: portHit.port });
          onChange();
          gesture = { kind: 'wire', from, pointerId: e.pointerId };
        } else {
          gesture = { kind: 'wire', from: null, pointerId: e.pointerId }; // nothing to grab
        }
      }
      state.mouse = { x: wx, y: wy };
      state.dragCable = gesture.from ? { from: gesture.from, to: null, mouse: state.mouse } : null;
      state.wireColor = wireColor();   // drag preview reflects the current pen
      return;
    }

    // knob → turn
    // control cell (knob / fader = value-drag; button = hold; toggle/switch = click)
    const ctlHit = renderer.findControlAt(wx, wy);
    if (ctlHit) {
      select(ctlHit.id);
      const inst = engine.instances.get(ctlHit.id);
      if (ctlHit.kind === 'knob' || ctlHit.kind === 'fader') {
        const isKnob = ctlHit.kind === 'knob';
        const def = (isKnob ? inst.def.knobs : inst.def.controls).find((d) => d.name === ctlHit.name);
        const startVal = isKnob ? engine.knobValue(ctlHit.id, ctlHit.name) : engine.controlValue(ctlHit.id, ctlHit.name);
        gesture = { kind: 'value', id: ctlHit.id, name: ctlHit.name, isKnob, cdef: def, startVal, startSy: sy, moved: false, pointerId: e.pointerId };
      } else if (ctlHit.kind === 'button') {
        engine.setControl(ctlHit.id, ctlHit.name, 1);   // 1 while held
        onChange();
        gesture = { kind: 'button', id: ctlHit.id, name: ctlHit.name, pointerId: e.pointerId };
      } else {   // toggle / switch — act on release (click)
        gesture = { kind: 'press', id: ctlHit.id, name: ctlHit.name, ckind: ctlHit.kind,
                    count: inst.def.controls.find((d) => d.name === ctlHit.name)?.count || 2, pointerId: e.pointerId };
      }
      return;
    }

    // panel → move
    const inst = renderer.findModuleAt(wx, wy);
    if (inst) {
      select(inst.id);
      const r = renderer.moduleRect(inst);
      gesture = { kind: 'module', inst, grabHp: (wx - r.x) / HP, grabY: wy - renderer.rowYs()[inst.row],
                  startRow: inst.row, startHp: inst.hpPos, pointerId: e.pointerId };
      return;
    }

    // empty → pan (and deselect)
    select(null);
    gesture = { kind: 'pan', pointerId: e.pointerId, lastSx: sx, lastSy: sy };
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    const { sx, sy } = canvasPoint(e);
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    const p = pointers.get(e.pointerId);
    p.sx = sx; p.sy = sy; p.wx = wx; p.wy = wy;

    if (gesture && gesture.kind === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const midSx = (a.sx + b.sx) / 2, midSy = (a.sy + b.sy) / 2;
      const dist = Math.hypot(b.sx - a.sx, b.sy - a.sy) || 1;
      const ns = clamp(gesture.startScale * (dist / gesture.startDist), 0.3, 3);
      renderer.view.scale = ns;
      renderer.view.tx = midSx - gesture.startWorldMid.x * ns;
      renderer.view.ty = midSy - gesture.startWorldMid.y * ns;
      return;
    }

    if (!gesture || gesture.pointerId !== e.pointerId) {
      state.hoveredPort = renderer.findPortAt(wx, wy, lastInputType);
      return;
    }

    if (gesture.kind === 'pan') {
      renderer.view.tx += sx - gesture.lastSx;
      renderer.view.ty += sy - gesture.lastSy;
      gesture.lastSx = sx; gesture.lastSy = sy;
    } else if (gesture.kind === 'module') {
      const snap = renderer.snapTarget(gesture.inst, wx, wy, gesture.grabHp, gesture.grabY);
      state.dragGhost = { x: snap.x, y: snap.y, w: snap.w, h: snap.h, valid: snap.valid };
      if (snap.valid) { gesture.inst.row = snap.row; gesture.inst.hpPos = snap.hpPos; }
    } else if (gesture.kind === 'value') {
      const range = (gesture.cdef.max - gesture.cdef.min) || 1;
      const dv = (gesture.startSy - sy) / 160 * range;   // drag up → increase
      const v = clamp(gesture.startVal + dv, gesture.cdef.min, gesture.cdef.max);
      if (Math.abs(sy - gesture.startSy) > 2) gesture.moved = true;
      if (gesture.isKnob) engine.setKnob(gesture.id, gesture.name, v);
      else engine.setControl(gesture.id, gesture.name, v);
    } else if (gesture.kind === 'wire') {
      state.mouse = { x: wx, y: wy };
      if (state.dragCable) state.dragCable.mouse = state.mouse;
      state.hoveredPort = renderer.findPortAt(wx, wy, lastInputType);
    }
  }

  function onUp(e) {
    e.preventDefault();
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!had || !gesture) { gesture = null; return; }

    if (gesture.kind === 'pinch') { if (pointers.size < 2) gesture = null; return; }

    if (gesture.kind === 'module') {
      const snap = renderer.snapTarget(gesture.inst, ...lastWorld(e), gesture.grabHp, gesture.grabY);
      if (!snap.valid) { gesture.inst.row = gesture.startRow; gesture.inst.hpPos = gesture.startHp; }
      const moved = gesture.inst.row !== gesture.startRow || gesture.inst.hpPos !== gesture.startHp;
      if (moved) { onChange(); _lastModClick = null; }
      else {
        // a click that didn't relocate — double-click opens the configurator
        const t = Date.now();
        if (_lastModClick && _lastModClick.id === gesture.inst.id && t - _lastModClick.t < 350) {
          _lastModClick = null; onConfigure(gesture.inst.id);
        } else { _lastModClick = { id: gesture.inst.id, t }; }
      }
      state.dragGhost = null; gesture = null; return;
    }
    if (gesture.kind === 'value') { onChange(); gesture = null; return; }

    if (gesture.kind === 'button') {
      engine.setControl(gesture.id, gesture.name, 0);   // release
      onChange(); gesture = null; return;
    }

    if (gesture.kind === 'press') {
      // click on toggle / switch (released over the same control)
      const [wx, wy] = lastWorld(e);
      const hit = renderer.findControlAt(wx, wy);
      if (hit && hit.id === gesture.id && hit.name === gesture.name) {
        const cur = engine.controlValue(gesture.id, gesture.name) | 0;
        if (gesture.ckind === 'toggle') engine.setControl(gesture.id, gesture.name, cur ? 0 : 1);
        else if (gesture.ckind === 'switch') engine.setControl(gesture.id, gesture.name, (cur + 1) % gesture.count);
        onChange();
      }
      gesture = null; return;
    }

    if (gesture.kind === 'wire') {
      const [wx, wy] = lastWorld(e);
      const hit = renderer.findPortAt(wx, wy, lastInputType);
      if (hit && hit.side === 'in' && gesture.from) {
        const res = engine.connect(gesture.from, { id: hit.id, port: hit.port }, wireColor());
        if (res.ok) onChange();
      }
      state.dragCable = null; gesture = null; return;
    }
    gesture = null;
  }

  function lastWorld(e) {
    const { sx, sy } = canvasPoint(e);
    const w = renderer.screenToWorld(sx, sy);
    return [w.x, w.y];
  }

  function onWheel(e) {
    e.preventDefault();
    const { sx, sy } = canvasPoint(e);
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    const ns = clamp(renderer.view.scale * Math.exp(-e.deltaY * 0.0015), 0.3, 3);
    renderer.view.scale = ns;
    renderer.view.tx = sx - wx * ns;
    renderer.view.ty = sy - wy * ns;
  }

  const preventDefault = (e) => e.preventDefault();
  const onTouchMove = (e) => { if (e.target === canvas) e.preventDefault(); };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  // Suppress iOS pinch-zoom of the page.
  addEventListener('gesturestart', preventDefault);
  addEventListener('gesturechange', preventDefault);
  addEventListener('gestureend', preventDefault);
  document.addEventListener('touchmove', onTouchMove, { passive: false });

  function detach() {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    removeEventListener('gesturestart', preventDefault);
    removeEventListener('gesturechange', preventDefault);
    removeEventListener('gestureend', preventDefault);
    document.removeEventListener('touchmove', onTouchMove);
  }

  return { state, detach, select, setRailsOn(v) { state.railsOn = v; } };
}
