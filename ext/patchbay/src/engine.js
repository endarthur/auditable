// @gcu/patchbay — dataflow engine.
//
// createEngine(sr, ctx) builds an engine bound to injected sideact primitives
// (signal/computed/effect/batch). sideact is injected (not imported) so the
// engine is unit-testable in Node and immune to the surface bundle's
// concat-inlining quirks.
//
// Each module instance holds its input ports, knobs, and output ports as
// sideact signals. A cable A.out → B.in is a *rebindable input source*: the
// input's value is a computed that, when wired, reads the producer's output
// signal — so sideact's auto-tracking becomes the reactive graph (no manual
// topo-sort). The cable IS the dependency, in Patchbay's own graph.

import { getModuleDef } from './sdk.js';

export function createEngine(sr, ctx = {}) {
  const { signal, computed, effect, batch } = sr;
  const instances = new Map();   // id → instance
  const cables = [];             // [{ from:{id,port}, to:{id,port} }]

  function addInstance(id, type, opts = {}) {
    const def = getModuleDef(type);
    if (!def) throw new Error('patchbay: unknown module type "' + type + '"');
    if (instances.has(id)) throw new Error('patchbay: duplicate instance id "' + id + '"');

    // knobs → signals
    const knobs = {};
    for (const k of def.knobs) {
      const init = (opts.knobs && k.name in opts.knobs) ? opts.knobs[k.name] : k.default;
      const [read, write] = signal(init);
      knobs[k.name] = { read, write, def: k };
    }

    // interactive controls (button/toggle/switch/fader) → signals. Persistent
    // like knobs; button persists 0 (momentary). They share the value namespace
    // with knobs when passed to process().
    const controls = {};
    for (const c of def.controls) {
      const init = (opts.controls && c.name in opts.controls) ? opts.controls[c.name] : c.default;
      const [read, write] = signal(init);
      controls[c.name] = { read, write, def: c };
    }

    // params (config) → plain editable values
    const params = {};
    for (const [pn, pspec] of Object.entries(def.params)) params[pn] = pspec.default;
    Object.assign(params, opts.params || {});

    // output ports → signals (written by process or by an I/O setup callback)
    const outputs = {};
    for (const p of def.outPorts) {
      const [read, write] = signal(p.type === 'number' ? 0 : p.type === 'boolean' ? false : null);
      outputs[p.name] = { read, write, def: p };
    }

    // input ports → { wiring signal, default signal, value computed }
    const inputs = {};
    for (const p of def.inPorts) {
      const [wiringRead, wiringWrite] = signal(null);        // { id, port } | null
      const [defaultRead, defaultWrite] = signal(p.default); // unwired constant
      const value = computed(() => {
        const w = wiringRead();
        if (w) {
          const src = instances.get(w.id);
          if (src && src.outputs[w.port]) return src.outputs[w.port].read();
        }
        return defaultRead();
      });
      inputs[p.name] = { wiringRead, wiringWrite, defaultRead, defaultWrite, value, def: p };
    }

    const state = {};   // per-instance scratch (process/setup/display)
    const inst = {
      id, type, def, knobs, controls, params, inputs, outputs, state,
      row: Number.isFinite(opts.row) ? opts.row : 0,
      hpPos: Number.isFinite(opts.hpPos) ? opts.hpPos : 0,
      color: opts.color || null,   // per-instance accent override (else def.color)
      style: opts.style || null,   // per-instance panel-style override (else def.style)
      _processEffect: null, _teardown: null,
    };
    instances.set(id, inst);

    // process effect — reactive value compute (auto-tracks the inputs/knobs it reads)
    if (def.process) {
      inst._processEffect = effect(() => {
        const inp = {};
        for (const name in inputs) inp[name] = inputs[name].value();
        const kv = {};
        for (const name in knobs) kv[name] = knobs[name].read();
        for (const name in controls) kv[name] = controls[name].read();
        let out;
        try { out = def.process(inp, kv, state); }
        catch (e) { console.error(`patchbay: module "${id}" process threw:`, e); return; }
        if (out && typeof out === 'object') {
          batch(() => {
            for (const name in out) if (outputs[name]) outputs[name].write(out[name]);
          });
        }
      });
    }

    // setup seam — I/O bridge modules subscribe/poll here; returns a teardown.
    _runSetup(inst);

    return inst;
  }

  function _runSetup(inst) {
    if (!inst.def.setup) return;
    try { inst._teardown = inst.def.setup({ ...ctx, sr, instance: inst }, inst) || null; }
    catch (e) { console.error(`patchbay: module "${inst.id}" setup threw:`, e); }
  }

  function removeInstance(id) {
    const inst = instances.get(id);
    if (!inst) return;
    for (let i = cables.length - 1; i >= 0; i--) {
      const c = cables[i];
      if (c.from.id === id || c.to.id === id) _spliceCable(i);
    }
    if (typeof inst._processEffect === 'function') inst._processEffect();
    if (typeof inst._teardown === 'function') { try { inst._teardown(); } catch { /* ignore */ } }
    instances.delete(id);
  }

  // Would a cable from→to create a cycle? Data flows producer→consumer; a cycle
  // exists if the consumer (to) can already reach the producer (from) by
  // following existing cables.
  function wouldCycle(fromId, toId) {
    if (fromId === toId) return true;
    const adj = new Map();   // producerId → Set(consumerId)
    for (const c of cables) {
      if (!adj.has(c.from.id)) adj.set(c.from.id, new Set());
      adj.get(c.from.id).add(c.to.id);
    }
    const seen = new Set([toId]);
    const q = [toId];
    while (q.length) {
      const n = q.shift();
      if (n === fromId) return true;
      for (const m of (adj.get(n) || [])) if (!seen.has(m)) { seen.add(m); q.push(m); }
    }
    return false;
  }

  // Connect producer output (from) → consumer input (to). An input takes a
  // single cable; reconnecting replaces it. `color` is an optional cable-color
  // role override (else the render falls back to the source module's accent).
  // Returns { ok, reason? }.
  function connect(from, to, color) {
    const src = instances.get(from.id);
    const dst = instances.get(to.id);
    if (!src || !dst) return { ok: false, reason: 'missing-instance' };
    if (!src.outputs[from.port]) return { ok: false, reason: 'no-output' };
    if (!dst.inputs[to.port]) return { ok: false, reason: 'no-input' };
    if (wouldCycle(from.id, to.id)) return { ok: false, reason: 'cycle' };
    _disconnectInput(to);
    dst.inputs[to.port].wiringWrite({ id: from.id, port: from.port });
    const cable = { from: { id: from.id, port: from.port }, to: { id: to.id, port: to.port } };
    if (color) cable.color = color;
    cables.push(cable);
    return { ok: true };
  }

  // Remove a specific cable object (cable-delete affordance).
  function removeCable(cable) {
    const i = cables.indexOf(cable);
    if (i !== -1) _spliceCable(i);
  }

  function _disconnectInput(to) {
    for (let i = cables.length - 1; i >= 0; i--) {
      const c = cables[i];
      if (c.to.id === to.id && c.to.port === to.port) _spliceCable(i);
    }
  }

  function _spliceCable(i) {
    const c = cables[i];
    const dst = instances.get(c.to.id);
    if (dst && dst.inputs[c.to.port]) dst.inputs[c.to.port].wiringWrite(null);
    cables.splice(i, 1);
  }

  // Disconnect whatever feeds the given input.
  function disconnect(to) { _disconnectInput(to); }

  // ── read/write helpers (render loop + UI) ──
  function outputValue(id, port) {
    const i = instances.get(id);
    return i && i.outputs[port] ? i.outputs[port].read() : undefined;
  }
  function inputValue(id, port) {
    const i = instances.get(id);
    return i && i.inputs[port] ? i.inputs[port].value() : undefined;
  }
  function knobValue(id, name) {
    const i = instances.get(id);
    return i && i.knobs[name] ? i.knobs[name].read() : undefined;
  }
  function setKnob(id, name, v) {
    const i = instances.get(id);
    if (i && i.knobs[name]) i.knobs[name].write(v);
  }
  function controlValue(id, name) {
    const i = instances.get(id);
    return i && i.controls[name] ? i.controls[name].read() : undefined;
  }
  function setControl(id, name, v) {
    const i = instances.get(id);
    if (i && i.controls[name]) i.controls[name].write(v);
  }
  // Per-instance appearance (accent / panel style). null clears the override.
  function setAppearance(id, key, v) {
    const i = instances.get(id);
    if (i && (key === 'color' || key === 'style')) i[key] = v || null;
  }
  // Param changes re-run the I/O setup seam (a new topic/path needs to re-bind).
  function setParam(id, name, v) {
    const i = instances.get(id);
    if (!i) return;
    i.params[name] = v;
    if (i.def.setup) {
      if (typeof i._teardown === 'function') { try { i._teardown(); } catch { /* ignore */ } }
      _runSetup(i);
    }
  }

  // Tear down every instance (surface dispose).
  function destroy() {
    for (const id of [...instances.keys()]) removeInstance(id);
  }

  return {
    instances, cables,
    addInstance, removeInstance, connect, disconnect, removeCable, wouldCycle,
    outputValue, inputValue, knobValue, setKnob, controlValue, setControl, setParam, setAppearance, destroy,
  };
}
