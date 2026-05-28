// @gcu/patchbay — Eurorack-style reactive dataflow surface engine
// Auto-generated from ext/patchbay/src/ — do not edit directly

// -- sdk.js --

// @gcu/patchbay — module SDK: defineModule + the module-type registry.
//
// A module *type* is a declarative spec (ports / knobs / process / setup /
// display). Instances of a type live in an engine (see engine.js). The
// registry is a module-level singleton — types are global definitions, while
// instances are per-engine.

const _moduleRegistry = new Map();   // type → normalized def

const PRIMITIVE_DEFAULT = (t) =>
  t === 'number' ? 0 : t === 'boolean' ? false : t === 'string' ? '' : null;

function normalizePorts(obj, isOut) {
  const out = [];
  for (const [name, raw] of Object.entries(obj || {})) {
    const spec = typeof raw === 'string' ? { type: raw } : (raw && typeof raw === 'object' ? raw : {});
    const type = spec.type || 'number';
    const entry = { name, type };
    if (isOut) {
      entry.cable = spec.cable || 'trs';
    } else {
      entry.default = ('default' in spec) ? spec.default : PRIMITIVE_DEFAULT(type);
    }
    out.push(entry);
  }
  return out;
}

function normalizeKnobs(obj) {
  const out = [];
  for (const [name, raw] of Object.entries(obj || {})) {
    const k = (raw && typeof raw === 'object') ? raw : {};
    out.push({
      name,
      label: k.label || name.toUpperCase(),
      default: typeof k.default === 'number' ? k.default : 0.5,
      min: typeof k.min === 'number' ? k.min : 0,
      max: typeof k.max === 'number' ? k.max : 1,
    });
  }
  return out;
}

function normalizeParams(obj) {
  // params are config fields (e.g. an A-Bus topic, a VFS path) edited in the
  // properties panel — NOT reactive signals. name → { label, kind, default }.
  const out = {};
  for (const [name, raw] of Object.entries(obj || {})) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    out[name] = {
      label: p.label || name,
      kind: p.kind || 'text',                       // text | number | select
      options: Array.isArray(p.options) ? p.options : null,
      default: ('default' in p) ? p.default : '',
    };
  }
  return out;
}

// Register a module type. Returns the normalized def.
function defineModule(spec) {
  if (!spec || typeof spec.type !== 'string' || !spec.type) {
    throw new Error('defineModule: a string `type` is required');
  }
  const ports = spec.ports || {};
  const def = {
    type: spec.type,
    title: spec.title || spec.type,
    subtitle: spec.subtitle || '',
    hp: Number.isFinite(spec.hp) ? spec.hp : 8,
    color: spec.color || 'indigo',
    style: spec.style || 'studio',
    height: spec.height || '3U',
    inPorts: normalizePorts(ports.in, false),
    outPorts: normalizePorts(ports.out, true),
    knobs: normalizeKnobs(spec.knobs),
    params: normalizeParams(spec.params),
    process: typeof spec.process === 'function' ? spec.process : null,
    setup: typeof spec.setup === 'function' ? spec.setup : null,
    display: typeof spec.display === 'function' ? spec.display : null,
    layout: spec.layout || null,
  };
  _moduleRegistry.set(def.type, def);
  return def;
}

function getModuleDef(type) { return _moduleRegistry.get(type) || null; }
function hasModuleDef(type) { return _moduleRegistry.has(type); }
function listModuleDefs() { return [..._moduleRegistry.values()]; }

// Test/teardown helper — drop all registered types.
function clearModuleRegistry() { _moduleRegistry.clear(); }

// -- engine.js --

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


function createEngine(sr, ctx = {}) {
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
      id, type, def, knobs, params, inputs, outputs, state,
      row: Number.isFinite(opts.row) ? opts.row : 0,
      hpPos: Number.isFinite(opts.hpPos) ? opts.hpPos : 0,
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
  // single cable; reconnecting replaces it. Returns { ok, reason? }.
  function connect(from, to) {
    const src = instances.get(from.id);
    const dst = instances.get(to.id);
    if (!src || !dst) return { ok: false, reason: 'missing-instance' };
    if (!src.outputs[from.port]) return { ok: false, reason: 'no-output' };
    if (!dst.inputs[to.port]) return { ok: false, reason: 'no-input' };
    if (wouldCycle(from.id, to.id)) return { ok: false, reason: 'cycle' };
    _disconnectInput(to);
    dst.inputs[to.port].wiringWrite({ id: from.id, port: from.port });
    cables.push({ from: { id: from.id, port: from.port }, to: { id: to.id, port: to.port } });
    return { ok: true };
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
    addInstance, removeInstance, connect, disconnect, wouldCycle,
    outputValue, inputValue, knobValue, setKnob, setParam, destroy,
  };
}

// -- styles.js --

// @gcu/patchbay — panel styles. Each style varies surface (panel bg/edge,
// typography, LED + display aesthetics) while sharing the HP grid, rail
// geometry, screw convention, and Switchboard surface palette — the discipline
// that keeps a rack from collapsing into a sticker collection. render.js + pb.js
// read these; values are resolved against the live theme color table at draw
// time (a style names *which* role/look, not a fixed hex).

const PANEL_STYLES = {
  studio: {
    label: 'Studio',
    panel: { top: 'bgBright', bottom: 'bgRaised', edge: 'border' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'accent',           // 'accent' = module bandColor, else a role token
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'pill',
    display: 'clean',
  },
  brutalist: {
    label: 'Brutalist',
    panel: { top: 'bgDeep', bottom: 'bgDeep', edge: 'rule' },
    accentStripe: false,
    headerFont: '700 16px "Space Mono", monospace',
    headerColor: 'text',
    labelFont: '8.5px "Space Mono", monospace',
    upperLabels: true,
    screws: true,
    led: 'pixel',
    display: 'pixel-lcd',
  },
  analog: {
    label: 'Analog',
    panel: { top: 'bgBright', bottom: 'bgRaised', edge: 'border' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'accent',
    labelFont: '9px Barlow, sans-serif',
    screws: true,
    led: 'glow',
    display: 'crt',
  },
  lab: {
    label: 'Lab',
    panel: { top: 'bgDeep', bottom: 'bg', edge: 'rule' },
    accentStripe: true,
    headerFont: '600 16px Barlow, sans-serif',
    headerColor: 'text',
    labelFont: '9px Barlow, sans-serif',
    screws: true,
    led: 'ring',
    display: 'segment',
  },
  retro: {
    label: 'Retro',
    panel: { top: 'bgRaised', bottom: 'bgDeep', edge: 'amber' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'amber',
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'glow',
    display: 'vfd',
  },
  blank: {
    label: 'Blank',
    panel: { top: 'bgRaised', bottom: 'bgRaised', edge: 'border' },
    accentStripe: false,
    headerFont: '9px "Space Mono", monospace',
    headerColor: 'textSoft',
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'pill',
    display: 'none',
  },
};

function getStyle(name) {
  return PANEL_STYLES[name] || PANEL_STYLES.studio;
}

function listStyles() {
  return Object.keys(PANEL_STYLES);
}

// -- store.js --

// @gcu/patchbay — rack document schema + persistence.
//
// One schema, two containers. v1 persists a rack as a single `.patchbay` JSON
// file (LooseFileStore). The schema is deliberately container-agnostic so a
// future ProjectStore (a /projects/<name>/ directory with project.json +
// rack.patchbay + modules/*.js) is a drop-in: same JSON, different load/save.

const FORMAT = 'patchbay';
const VERSION = 1;

function blankRack() {
  return {
    format: FORMAT,
    version: VERSION,
    rack: { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] },
    modules: [],
    cables: [],
  };
}

// Engine state + rack geometry → plain doc object.
function serializeRack(engine, rack) {
  const modules = [];
  for (const inst of engine.instances.values()) {
    const knobs = {};
    for (const name in inst.knobs) knobs[name] = inst.knobs[name].read();
    modules.push({
      id: inst.id,
      type: inst.type,
      row: inst.row,
      hpPos: inst.hpPos,
      knobs,
      params: { ...inst.params },
    });
  }
  const cables = engine.cables.map((c) => ({
    from: { id: c.from.id, port: c.from.port },
    to: { id: c.to.id, port: c.to.port },
  }));
  const geom = rack || { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] };
  return {
    format: FORMAT,
    version: VERSION,
    rack: { hp: geom.hp || 64, rows: (geom.rows || []).map((r) => ({ kind: r.kind || '3U' })) },
    modules,
    cables,
  };
}

// Doc (object or JSON string) → populate engine, return rack geometry.
// Adds every instance first, then connects cables (cables reference ids).
function deserializeRack(doc, engine) {
  const d = typeof doc === 'string' ? JSON.parse(doc) : doc;
  if (!d || d.format !== FORMAT) throw new Error('patchbay: not a patchbay document');
  const rack = {
    hp: (d.rack && d.rack.hp) || 64,
    rows: ((d.rack && d.rack.rows) || [{ kind: '3U' }, { kind: '3U' }]).map((r) => ({ kind: r.kind || '3U' })),
  };
  for (const m of (d.modules || [])) {
    try {
      engine.addInstance(m.id, m.type, { row: m.row, hpPos: m.hpPos, knobs: m.knobs, params: m.params });
    } catch (e) {
      console.error('patchbay: skipping bad module on load:', m && m.id, e);
    }
  }
  for (const c of (d.cables || [])) {
    if (c && c.from && c.to) engine.connect(c.from, c.to);   // cycle/missing rejected silently
  }
  return rack;
}

// The RackStore interface is { load(): Promise<doc|null>, save(doc): Promise<void> }.
// v1 backend: a single .patchbay file read/written through the works VFS service.
class LooseFileStore {
  constructor(bus, path) {
    this.bus = bus;
    this.path = path;
  }
  async load() {
    const text = await this.bus.call(
      { to: 'works', path: '/', interface: 'VFS', member: 'Read' },
      [this.path, 'utf8']);
    if (!text) return null;
    return JSON.parse(text);
  }
  async save(doc) {
    await this.bus.call(
      { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
      [this.path, JSON.stringify(doc, null, 2)]);
  }
}

// -- pb.js --

// @gcu/patchbay — the `pb` display library. Module-sized, style-aware
// visualizations drawn into a module's display rect (world coords; the canvas
// transform is already in world space when run() is called). Reactive by virtue
// of the render loop: values are read each frame and passed in via `out`.
//
// Intentionally constrained — there is no general-purpose chart. If you want a
// real plot in a module you're using the wrong surface; keep it in a cell.

// 7-segment lit-segment maps.
const SEG7 = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '', '.': '',
};

function createPb(ctx) {
  let rect, style, colors, accent, cursor;

  const col = (name) => (name && colors[name]) || name || accent;
  const c01 = (v) => Math.max(0, Math.min(1, v));

  // Reserve a sub-rect: explicit {x,y,w,h} (rect-local) or auto-stack downward.
  // Auto-stacked slots clamp to the remaining display band, so a primitive can
  // ask for a tall slot (e.g. a full-height trend) and get the available space.
  function slot(opts, defH) {
    if (opts && Number.isFinite(opts.x)) {
      return { x: rect.x + opts.x, y: rect.y + opts.y, w: opts.w ?? rect.w, h: opts.h ?? defH };
    }
    const remaining = rect.y + rect.h - cursor.y - 2;
    const h = Math.max(8, Math.min((opts && opts.h) || defH, remaining));
    const s = { x: rect.x + 2, y: cursor.y, w: rect.w - 4, h };
    cursor.y += h + 3;
    return s;
  }

  function inset(s) {
    ctx.fillStyle = colors.bgDeep;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
  }

  // ── primitives ──

  function led(value, opts = {}) {
    const s = slot(opts, 14);
    const c = col(opts.color);
    const on = typeof value === 'number' ? value : (value ? 1 : 0);
    const cx = s.x + 7, cy = s.y + s.h / 2, r = 5;
    if (style.led === 'pixel') {
      ctx.fillStyle = colors.bgDeep; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.globalAlpha = 0.25 + 0.75 * on; ctx.fillStyle = c;
      ctx.fillRect(cx - r + 1, cy - r + 1, r * 2 - 2, r * 2 - 2); ctx.globalAlpha = 1;
    } else {
      if (style.led === 'glow' && on > 0.05) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
        g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.5 * on; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.2 + 0.8 * on; ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      if (style.led === 'ring') { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (opts.label) {
      ctx.fillStyle = colors.textSoft; ctx.font = '8px "Space Mono", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(opts.label).toUpperCase(), cx + r + 5, cy);
    }
  }

  function bargraph(value, opts = {}) {
    const steps = opts.steps || 8;
    const lo = opts.min ?? 0, hi = opts.max ?? 1;
    const frac = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
    const lit = Math.round(frac * steps);
    const vert = opts.orient === 'v';
    const s = slot(opts, vert ? rect.h - cursor.y + rect.y - 2 : 12);
    inset(s);
    const gap = 2;
    if (vert) {
      const segH = (s.h - gap * (steps + 1)) / steps;
      for (let i = 0; i < steps; i++) {
        const on = i < lit;
        ctx.fillStyle = on ? (i >= steps - 2 ? colors.red : i >= steps - 4 ? colors.amber : colors.green) : colors.bgRaised;
        ctx.fillRect(s.x + gap, s.y + s.h - gap - (i + 1) * (segH + gap) + gap, s.w - gap * 2, segH);
      }
    } else {
      const segW = (s.w - gap * (steps + 1)) / steps;
      for (let i = 0; i < steps; i++) {
        const on = i < lit;
        ctx.fillStyle = on ? (i >= steps - 2 ? colors.red : i >= steps - 4 ? colors.amber : colors.green) : colors.bgRaised;
        ctx.fillRect(s.x + gap + i * (segW + gap), s.y + gap, segW, s.h - gap * 2);
      }
    }
  }

  // Strip-chart trend. Single series via `buffer`, or multiple colored pens via
  // opts.series = [{ data, color }]. Autoscales across all series unless
  // opts.min/max pin the range. opts: { grid, fill, labels, color, h }.
  function scope(buffer, opts = {}) {
    const s = slot(opts, opts.h || 40);
    inset(s);
    const series = opts.series && opts.series.length
      ? opts.series
      : [{ data: (buffer && buffer.length) ? buffer : [0], color: opts.color }];

    let lo = opts.min, hi = opts.max;
    if (lo == null || hi == null) {
      let mn = Infinity, mx = -Infinity;
      for (const ser of series) for (const v of ser.data) { if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      if (mn === mx) { mn -= 0.5; mx += 0.5; }
      if (lo == null) lo = mn;
      if (hi == null) hi = mx;
    }
    const ix = s.x + 2, iy = s.y + 2, iw = s.w - 4, ih = s.h - 4;
    const yOf = (v) => iy + ih - ih * c01((v - lo) / (hi - lo || 1));

    if (opts.grid !== false) {
      ctx.strokeStyle = colors.rule; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.4;
      for (let i = 1; i < 4; i++) { const y = iy + ih * i / 4; ctx.beginPath(); ctx.moveTo(ix, y); ctx.lineTo(ix + iw, y); ctx.stroke(); }
      for (let i = 1; i < 6; i++) { const x = ix + iw * i / 6; ctx.beginPath(); ctx.moveTo(x, iy); ctx.lineTo(x, iy + ih); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }

    for (const ser of series) {
      const data = ser.data; if (!data || !data.length) continue;
      const c = col(ser.color);
      const xOf = (i) => ix + iw * (i / (data.length - 1 || 1));
      if (opts.fill) {
        ctx.fillStyle = c; ctx.globalAlpha = 0.12;
        ctx.beginPath(); ctx.moveTo(ix, iy + ih);
        for (let i = 0; i < data.length; i++) ctx.lineTo(xOf(i), yOf(data[i]));
        ctx.lineTo(ix + iw, iy + ih); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) { const x = xOf(i), y = yOf(data[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      // current-value marker at the right edge (the live pen tip)
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(ix + iw, yOf(data[data.length - 1]), 2, 0, Math.PI * 2); ctx.fill();
    }

    if (opts.labels !== false && ih > 24) {
      ctx.fillStyle = colors.textSoft; ctx.font = '7px "Space Mono", monospace'; ctx.textAlign = 'right';
      ctx.textBaseline = 'top'; ctx.fillText(hi.toFixed(2), ix + iw - 2, iy + 1);
      ctx.textBaseline = 'bottom'; ctx.fillText(lo.toFixed(2), ix + iw - 2, iy + ih - 1);
    }
  }

  function lcd(text, opts = {}) {
    const s = slot(opts, 18);
    const back = style.display === 'vfd' ? colors.bgDeep : style.display === 'crt' ? '#0a160a' : colors.bgDeep;
    ctx.fillStyle = back; ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    const fg = opts.color ? col(opts.color) : style.display === 'vfd' ? colors.teal : style.display === 'crt' ? colors.green : colors.text;
    ctx.fillStyle = fg; ctx.font = `${Math.min(13, s.h - 6)}px "Space Mono", monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(String(text), s.x + 5, s.y + s.h / 2);
  }

  function _draw7(s, ch, onColor) {
    const segs = SEG7[ch] || '';
    const w = s.w, h = s.h, t = Math.max(1.5, Math.min(w, h) * 0.13);
    const x = s.x, y = s.y, midY = y + h / 2;
    const off = colors.bgRaised;
    const hbar = (yy) => [x + t, yy - t / 2, w - 2 * t, t];
    const vbar = (xx, yy0, yy1) => [xx - t / 2, yy0 + t / 2, t, (yy1 - yy0) - t];
    const R = {
      a: hbar(y + t / 2), d: hbar(y + h - t / 2), g: hbar(midY),
      f: vbar(x + t / 2, y, midY), b: vbar(x + w - t / 2, y, midY),
      e: vbar(x + t / 2, midY, y + h), c: vbar(x + w - t / 2, midY, y + h),
    };
    for (const k of 'abcdefg') {
      ctx.fillStyle = segs.includes(k) ? onColor : off;
      ctx.globalAlpha = segs.includes(k) ? 1 : 0.22;
      const r = R[k]; ctx.fillRect(r[0], r[1], r[2], r[3]);
    }
    ctx.globalAlpha = 1;
  }

  function numeric(value, opts = {}) {
    const s = slot(opts, 26);
    inset(s);
    const decimals = opts.decimals ?? (Number.isInteger(value) ? 0 : 2);
    let str = (typeof value === 'number' && isFinite(value)) ? value.toFixed(decimals) : String(value);
    const digits = opts.digits || str.length;
    str = str.slice(0, digits).padStart(digits, ' ');
    const onColor = opts.color ? col(opts.color) : style.display === 'vfd' ? colors.teal : colors.amber;
    const pad = 4, dw = (s.w - pad * 2) / digits, dh = s.h - pad * 2;
    const cw = Math.min(dw - 3, dh * 0.6);
    let cx = s.x + pad;
    for (const ch of str) {
      _draw7({ x: cx + (dw - cw) / 2, y: s.y + pad, w: cw, h: dh }, ch, onColor);
      cx += dw;
    }
  }

  function dot(x, y, opts = {}) {
    const s = slot(opts, 36);
    inset(s);
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(s.x + s.w / 2, s.y + 2); ctx.lineTo(s.x + s.w / 2, s.y + s.h - 2);
    ctx.moveTo(s.x + 2, s.y + s.h / 2); ctx.lineTo(s.x + s.w - 2, s.y + s.h / 2); ctx.stroke();
    const px = s.x + 3 + (s.w - 6) * Math.max(0, Math.min(1, x));
    const py = s.y + s.h - 3 - (s.h - 6) * Math.max(0, Math.min(1, y));
    ctx.fillStyle = col(opts.color); ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
  }

  function spectrum(values, opts = {}) {
    const s = slot(opts, 40);
    inset(s);
    const vals = values && values.length ? values : [0];
    const hi = opts.max ?? Math.max(1, ...vals);
    const n = vals.length, gap = 1, bw = (s.w - 4 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const frac = Math.max(0, Math.min(1, vals[i] / (hi || 1)));
      const bh = (s.h - 4) * frac;
      ctx.fillStyle = col(opts.color);
      ctx.fillRect(s.x + 2 + i * (bw + gap), s.y + s.h - 2 - bh, bw, bh);
    }
  }

  function indicator(stateName, opts = {}) {
    const map = { ok: colors.green, warn: colors.amber, err: colors.red, off: colors.textSoft };
    led(1, { ...opts, color: map[stateName] || colors.textSoft });
  }

  // Analog-needle dial — the instrumentation signature. A 270°-sweep arc (gap
  // at the bottom), ticks, a colored value sweep, a needle, and a digital
  // value in the gap. Sized + centered to fit inside the inset (the arc spans
  // 2·r wide and ~1.71·r tall, including the lower arms).
  function gauge(value, opts = {}) {
    const pad = 10;
    const explicit = Number.isFinite(opts.x);
    const availW = explicit ? (opts.w ?? rect.w) : rect.w - 4;
    const capH = (explicit ? opts.h : opts.maxH) || 160;
    // Size the dial from the panel width (usually the binding constraint),
    // capped by maxH. Then make the inset exactly tall enough for the arc +
    // its lower arms + the readout — no dead space below.
    const rad = Math.max(8, Math.min((availW - 2 * pad) / 2, (capH - 2 * pad - 14) / 1.71));
    const needH = Math.round(pad + rad * 1.71 + 16);
    const s = explicit
      ? { x: rect.x + opts.x, y: rect.y + opts.y, w: availW, h: opts.h ?? needH }
      : slot({ h: needH }, needH);
    inset(s);
    const lo = opts.min ?? 0, hi = opts.max ?? 1;
    const frac = c01(((value || 0) - lo) / (hi - lo || 1));
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;   // 135° → 405° (270° sweep)
    const cx = s.x + s.w / 2;
    const cy = s.y + pad + rad;                       // top of arc sits `pad` below the inset top

    ctx.strokeStyle = colors.rule; ctx.lineWidth = 2.5; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
    ctx.strokeStyle = colors.textSoft; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * (i / 8), major = i % 2 === 0;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (rad - (major ? 5 : 3)), cy + Math.sin(a) * (rad - (major ? 5 : 3)));
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.stroke();
    }
    const va = a0 + (a1 - a0) * frac;
    ctx.strokeStyle = col(opts.color); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, rad, a0, va); ctx.stroke();
    ctx.strokeStyle = colors.text; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(va) * (rad - 3), cy + Math.sin(va) * (rad - 3)); ctx.stroke();
    ctx.fillStyle = colors.text; ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();
    // digital readout in the bottom gap
    ctx.fillStyle = col(opts.color); ctx.font = '10px "Space Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((value == null ? 0 : value).toFixed(opts.decimals ?? 2), cx, cy + rad * 0.52);
  }

  const api = { led, bargraph, scope, lcd, numeric, dot, spectrum, indicator, gauge };

  function run(inst, r, out, st, themeColors, accentColor) {
    rect = r; style = st; colors = themeColors; accent = accentColor;
    cursor = { x: r.x + 2, y: r.y + 2 };
    inst.def.display(api, out, inst.state);
  }

  return { run, api };
}

// -- stdlib.js --

// @gcu/patchbay — built-in module stdlib. Registered at import (idempotent).
//
// "Punk SCADA": the modules wear the Eurorack panel aesthetic (rack, HP, jacks,
// knobs) but the kit is industrial process-control — setpoints, gains, gauges,
// alarms, PID loops, field tags — not synth voices. Type ids are stable
// (persisted identity); titles/colors are cosmetic and free to evolve.
//
// Three execution shapes:
//   • pure `process(inp, knobs, state)` — reactive value compute (math, logic,
//     clamp, hysteresis alarm). Runs whenever a read input/knob changes.
//   • `setup(ctx, inst) → teardown` with a clock — time-aware blocks (signal
//     gen, PID, timer) drive their outputs from a setInterval/effect.
//   • I/O `setup` — bridge to A-Bus tags + the VFS (field I/O, file, historian).


const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const truthy = (v) => (v || 0) > 0.5;

// topic string "Interface.Member" → { iface, member }
function parseTopic(s) {
  const m = String(s || '').split(/[.\/]/);
  return { iface: m[0] || '', member: m[1] || 'Value' };
}

const STDLIB_MODULES = [
  { type: 'src.const',   label: 'Setpoint', category: 'source' },
  { type: 'src.lfo',     label: 'Signal',   category: 'source' },
  { type: 'math.add',    label: 'Sum',      category: 'math' },
  { type: 'math.mul',    label: 'Product',  category: 'math' },
  { type: 'math.scale',  label: 'Gain',     category: 'math' },
  { type: 'math.limit',  label: 'Limit',    category: 'math' },
  { type: 'logic.compare', label: 'Compare', category: 'logic' },
  { type: 'logic.and',   label: 'And',      category: 'logic' },
  { type: 'logic.or',    label: 'Or',       category: 'logic' },
  { type: 'logic.not',   label: 'Not',      category: 'logic' },
  { type: 'logic.xor',   label: 'Xor',      category: 'logic' },
  { type: 'ctrl.alarm',  label: 'Alarm',    category: 'control' },
  { type: 'ctrl.pid',    label: 'PID',      category: 'control' },
  { type: 'ctrl.timer',  label: 'Timer',    category: 'control' },
  { type: 'disp.number', label: 'Readout',  category: 'display' },
  { type: 'disp.scope',  label: 'Trend',    category: 'display' },
  { type: 'disp.gauge',  label: 'Gauge',    category: 'display' },
  { type: 'io.abus-in',  label: 'Tag In',   category: 'io' },
  { type: 'io.abus-out', label: 'Tag Out',  category: 'io' },
  { type: 'io.vfs-read', label: 'File',     category: 'io' },
  { type: 'io.vfs-write', label: 'Log',     category: 'io' },
];

let _registered = false;

function registerStdlib() {
  if (_registered) return STDLIB_MODULES;
  _registered = true;

  // ── sources ──────────────────────────────────────────────────────────
  defineModule({
    type: 'src.const', title: 'SETPT', subtitle: 'sp · target', hp: 8, color: 'indigo',
    knobs: { value: { label: 'SP', default: 0.5, min: 0, max: 1 } },
    ports: { out: { v: { type: 'number', cable: 'trs' } } },
    process: (_i, k) => ({ v: k.value }),
    display: (pb, out) => pb.numeric(out.v, { digits: 4, decimals: 2 }),
  });

  defineModule({
    type: 'src.lfo', title: 'SIGNAL', subtitle: 'function gen', hp: 10, color: 'teal',
    knobs: { rate: { label: 'RATE', default: 0.3, min: 0, max: 1 } },
    ports: { out: { sin: { type: 'number', cable: 'banana' }, tri: { type: 'number', cable: 'banana' } } },
    setup(ctx, inst) {
      const t0 = now();
      const id = setInterval(() => {
        const rate = inst.knobs.rate.read();           // 0..1 → ~0.1..4 Hz
        const ph = ((now() - t0) / 1000) * (0.1 + rate * 4) * Math.PI * 2;
        inst.outputs.sin.write((Math.sin(ph) + 1) / 2);
        inst.outputs.tri.write(Math.abs(((ph / Math.PI) % 2) - 1));
      }, 33);
      return () => clearInterval(id);
    },
    display: (pb, out, st) => {
      st.buf = st.buf || [];
      st.buf.push(out.sin); if (st.buf.length > 64) st.buf.shift();
      pb.scope(st.buf, { min: 0, max: 1 });
    },
  });

  // ── math / signal conditioning ────────────────────────────────────────
  defineModule({
    type: 'math.add', title: 'SUM', subtitle: 'a + b', hp: 8, color: 'teal',
    ports: { in: { a: 'number', b: 'number' }, out: { sum: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ sum: (i.a || 0) + (i.b || 0) }),
    display: (pb, out) => pb.numeric(out.sum, { digits: 5, decimals: 2 }),
  });
  defineModule({
    type: 'math.mul', title: 'MULT', subtitle: 'a × b', hp: 8, color: 'teal',
    ports: { in: { a: 'number', b: 'number' }, out: { product: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ product: (i.a || 0) * (i.b || 0) }),
    display: (pb, out) => pb.numeric(out.product, { digits: 5, decimals: 2 }),
  });
  defineModule({
    type: 'math.scale', title: 'GAIN', subtitle: 'K · x', hp: 8, color: 'amber',
    knobs: { gain: { label: 'K', default: 1, min: 0, max: 4 } },
    ports: { in: { x: 'number' }, out: { y: { type: 'number', cable: 'trs' } } },
    process: (i, k) => ({ y: (i.x || 0) * k.gain }),
    display: (pb, out) => pb.bargraph(out.y, { steps: 10, min: 0, max: 4 }),
  });
  defineModule({
    type: 'math.limit', title: 'LIMIT', subtitle: 'clamp', hp: 8, color: 'amber',
    knobs: { lo: { label: 'LO', default: 0, min: 0, max: 1 }, hi: { label: 'HI', default: 1, min: 0, max: 1 } },
    ports: { in: { x: 'number' }, out: { y: { type: 'number', cable: 'trs' } } },
    process: (i, k, st) => {
      const lo = Math.min(k.lo, k.hi), hi = Math.max(k.lo, k.hi);
      const y = Math.max(lo, Math.min(hi, i.x || 0));
      st.clipped = (i.x || 0) < lo || (i.x || 0) > hi;
      return { y };
    },
    display: (pb, out, st) => pb.led(st.clipped ? 1 : 0, { label: 'CLIP', color: st.clipped ? 'amber' : 'textSoft' }),
  });

  // ── logic ────────────────────────────────────────────────────────────
  defineModule({
    type: 'logic.compare', title: 'COMP', subtitle: 'a ≷ b', hp: 8, color: 'green',
    ports: { in: { a: 'number', b: 'number' }, out: { gt: { type: 'number', cable: 'coax' } } },
    process: (i, _k, st) => { const gt = (i.a || 0) > (i.b || 0); st.gt = gt; return { gt: gt ? 1 : 0 }; },
    display: (pb, out) => pb.led(out.gt, { label: 'A>B', color: 'green' }),
  });
  const gate = (type, title, sub, fn, unary) => defineModule({
    type, title, subtitle: sub, hp: 6, color: 'green',
    ports: { in: unary ? { a: 'number' } : { a: 'number', b: 'number' }, out: { q: { type: 'number', cable: 'coax' } } },
    process: (i) => ({ q: fn(truthy(i.a), truthy(i.b)) ? 1 : 0 }),
    display: (pb, out) => pb.led(out.q, { label: 'Q', color: 'green' }),
  });
  gate('logic.and', 'AND', '∧', (a, b) => a && b);
  gate('logic.or',  'OR',  '∨', (a, b) => a || b);
  gate('logic.not', 'NOT', '¬', (a) => !a, true);
  gate('logic.xor', 'XOR', '⊕', (a, b) => a !== b);

  // ── control ──────────────────────────────────────────────────────────
  // Alarm: edge-armed threshold with hysteresis (a Schmitt trigger). Trips
  // when x ≥ level, re-arms when x < level − hyst. Pure/reactive: state holds
  // the armed flag + last input for the lamp.
  defineModule({
    type: 'ctrl.alarm', title: 'ALARM', subtitle: 'threshold', hp: 10, color: 'red',
    knobs: { level: { label: 'SET', default: 0.7, min: 0, max: 1 }, hyst: { label: 'HYST', default: 0.05, min: 0, max: 0.5 } },
    ports: { in: { x: 'number' }, out: { trip: { type: 'number', cable: 'coax' } } },
    process: (i, k, st) => {
      const x = i.x || 0;
      let armed = !!st.armed;
      if (!armed && x >= k.level) armed = true;
      else if (armed && x < k.level - k.hyst) armed = false;
      st.armed = armed; st.x = x; st.level = k.level;
      return { trip: armed ? 1 : 0 };
    },
    display: (pb, out, st) => {
      pb.led(out.trip, { label: 'TRIP', color: out.trip ? 'red' : 'textSoft' });
      pb.bargraph(st.x || 0, { steps: 10, min: 0, max: 1 });
    },
  });

  // PID: clocked controller. cv = Kp·e + Ki·∫e + Kd·de/dt, clamped 0..1 with
  // integral anti-windup. Setup-interval (50 ms) so the integral/derivative
  // see real dt; reads pv/sp inputs + gain knobs each tick.
  defineModule({
    type: 'ctrl.pid', title: 'PID', subtitle: 'controller', hp: 12, color: 'orange',
    knobs: {
      kp: { label: 'Kp', default: 1, min: 0, max: 4 },
      ki: { label: 'Ki', default: 0.3, min: 0, max: 2 },
      kd: { label: 'Kd', default: 0, min: 0, max: 2 },
    },
    ports: { in: { pv: 'number', sp: 'number' }, out: { cv: { type: 'number', cable: 'trs' } } },
    setup(ctx, inst) {
      let integ = 0, lastErr = 0, lastT = now();
      inst.state.cv = 0; inst.state.err = 0;
      const id = setInterval(() => {
        const pv = inst.inputs.pv.value() || 0, sp = inst.inputs.sp.value() || 0;
        const t = now(), dt = Math.max(0.001, (t - lastT) / 1000); lastT = t;
        const err = sp - pv;
        integ = Math.max(-10, Math.min(10, integ + err * dt));   // anti-windup
        const deriv = (err - lastErr) / dt; lastErr = err;
        const kp = inst.knobs.kp.read(), ki = inst.knobs.ki.read(), kd = inst.knobs.kd.read();
        const cv = Math.max(0, Math.min(1, kp * err + ki * integ + kd * deriv));
        inst.state.cv = cv; inst.state.err = err;
        inst.outputs.cv.write(cv);
      }, 50);
      return () => clearInterval(id);
    },
    display: (pb, out, st) => {
      pb.numeric(st.cv || 0, { digits: 4, decimals: 2 });
      pb.bargraph(st.cv || 0, { steps: 10, min: 0, max: 1 });
    },
  });

  // Timer: TON (on-delay) / TOF (off-delay), PLC-style. Output q follows trig
  // through a configurable delay. Effect re-arms on trig edges; a pending
  // setTimeout fires the delayed transition.
  defineModule({
    type: 'ctrl.timer', title: 'TIMER', subtitle: 'on/off delay', hp: 10, color: 'amber',
    params: {
      mode: { label: 'mode', kind: 'select', options: ['TON', 'TOF'], default: 'TON' },
      delay: { label: 'delay (ms)', kind: 'number', default: 1000 },
    },
    ports: { in: { trig: 'number' }, out: { q: { type: 'number', cable: 'coax' } } },
    setup(ctx, inst) {
      let pending = null, q = false;
      const apply = (v) => { if (v !== q) { q = v; inst.state.q = v; inst.outputs.q.write(v ? 1 : 0); } };
      const eff = ctx.sr.effect(() => {
        const trig = truthy(inst.inputs.trig.value());
        const mode = inst.params.mode || 'TON';
        const delay = Math.max(0, parseFloat(inst.params.delay) || 0);
        inst.state.mode = mode;
        if (pending) { clearTimeout(pending); pending = null; }
        if (mode === 'TON') {
          if (trig) pending = setTimeout(() => apply(true), delay);
          else apply(false);
        } else {                                  // TOF
          if (trig) apply(true);
          else pending = setTimeout(() => apply(false), delay);
        }
      });
      return () => { if (pending) clearTimeout(pending); eff(); };
    },
    display: (pb, out, st) => pb.led(out.q, { label: st.mode || 'TON', color: out.q ? 'green' : 'textSoft' }),
  });

  // ── displays (pass-through monitors) ───────────────────────────────────
  defineModule({
    type: 'disp.number', title: 'READOUT', subtitle: 'DRO', hp: 8, color: 'amber', style: 'lab',
    ports: { in: { x: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ x: i.x }),
    display: (pb, out) => pb.numeric(out.x, { digits: 6, decimals: 3 }),
  });
  // TREND: a two-pen strip chart. `x` is the primary trace; `b` is an optional
  // second pen (shown only once it carries a nonzero signal, so an unwired b
  // doesn't draw a flat zero line). Fills the panel; autoscales; grid + min/max.
  defineModule({
    type: 'disp.scope', title: 'TREND', subtitle: 'strip chart', hp: 16, color: 'orange', style: 'analog',
    ports: { in: { x: 'number', b: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i, _k, st) => {
      st.a = st.a || []; st.b = st.b || [];
      st.a.push(i.x || 0); if (st.a.length > 160) st.a.shift();
      st.b.push(i.b || 0); if (st.b.length > 160) st.b.shift();
      return { x: i.x };
    },
    display: (pb, _out, st) => {
      const series = [{ data: st.a || [], color: 'orange' }];
      if ((st.b || []).some((v) => v !== 0)) series.push({ data: st.b, color: 'teal' });
      pb.scope([], { series, h: 999, grid: true, fill: true });
    },
  });
  defineModule({
    type: 'disp.gauge', title: 'GAUGE', subtitle: 'dial', hp: 10, color: 'teal', style: 'analog',
    ports: { in: { x: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ x: i.x }),
    display: (pb, out) => pb.gauge(out.x || 0, { min: 0, max: 1, color: 'teal', maxH: 150 }),
  });

  // ── I/O (the field boundary) ───────────────────────────────────────────
  defineModule({
    type: 'io.abus-in', title: 'TAG IN', subtitle: 'field · AI', hp: 10, color: 'indigo',
    params: { topic: { label: 'tag (Iface.Member)', kind: 'text', default: '' } },
    ports: { out: { value: { type: 'number', cable: 'banana' } } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.topic) return null;
      const { iface, member } = parseTopic(inst.params.topic);
      const unsub = ctx.bus.subscribe({ interface: iface, member }, (msg) => {
        inst.outputs.value.write(msg && msg.args ? msg.args[0] : undefined);
      });
      return () => { try { unsub(); } catch { /* ignore */ } };
    },
    display: (pb, out) => pb.numeric(out.value, { digits: 5, decimals: 2 }),
  });

  defineModule({
    type: 'io.abus-out', title: 'TAG OUT', subtitle: 'field · AO', hp: 10, color: 'orange',
    params: { topic: { label: 'tag (Iface.Member)', kind: 'text', default: '' } },
    ports: { in: { value: 'number' } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.topic) return null;
      const { iface, member } = parseTopic(inst.params.topic);
      return ctx.sr.effect(() => {
        const v = inst.inputs.value.value();
        ctx.bus.signal({ path: '/', interface: iface, member }, [v]);
      });
    },
  });

  defineModule({
    type: 'io.vfs-read', title: 'FILE', subtitle: 'source', hp: 12, color: 'teal',
    params: { path: { label: 'path', kind: 'text', default: '' } },
    ports: { out: { content: { type: 'string', cable: 'ribbon' } } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.path) return null;
      let alive = true;
      const read = async () => {
        try {
          const t = await ctx.bus.call(
            { to: 'works', path: '/', interface: 'VFS', member: 'Read' }, [inst.params.path, 'utf8']);
          if (alive) inst.outputs.content.write(t);
        } catch { /* missing file → leave prior value */ }
      };
      read();
      const unsub = ctx.bus.subscribe({ interface: 'VFS', member: 'Changed' }, (msg) => {
        if (msg && msg.args && msg.args[0] === inst.params.path) read();
      });
      return () => { alive = false; try { unsub(); } catch { /* ignore */ } };
    },
    display: (pb, out) => pb.lcd(out.content == null ? '—' : String(out.content).slice(0, 12)),
  });

  defineModule({
    type: 'io.vfs-write', title: 'LOG', subtitle: 'historian', hp: 12, color: 'red',
    params: { path: { label: 'path', kind: 'text', default: '' } },
    ports: { in: { content: 'string' } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.path) return null;
      let first = true;
      return ctx.sr.effect(() => {
        const c = inst.inputs.content.value();   // track the input
        if (first) { first = false; return; }    // skip the initial run — don't clobber the file
        ctx.bus.call(
          { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
          [inst.params.path, c == null ? '' : String(c)]).catch(() => {});
      });
    },
  });

  return STDLIB_MODULES;
}

// Register at import so the bundle (and the surface) has the stdlib available.
registerStdlib();

// -- render.js --

// @gcu/patchbay — canvas rack renderer. Ported from the v0 sketch
// (spec_inbox/surfaces/patchbay.html) but driven by engine instances + live
// signal values instead of hard-coded module data. Owns the view transform,
// auto-layout, cable verlet physics, drawing, and hit-testing geometry. The
// interaction layer (interact.js) calls its hit-tests and reads/sets the view.


// Rack geometry (Eurorack-inspired, our own units).
const HP = 14;          // px per HP slot
const ROW_H = 300;      // 3U module height
const ROW_1U_H = 100;   // 1U row height
const RAIL_H = 14;      // visible rail thickness
const ROW_GAP = 8;      // gap between adjacent rows
const RAIL_LEFT = 80;   // x-origin of the HP grid

// Default color table — the GCU/Switchboard dark palette. The surface overrides
// this with live theme tokens (setColors). Role names are referenced by styles.
const DEFAULT_COLORS = {
  bgDeep: '#0E1012', bg: '#15171A', bgRaised: '#1D2024', bgBright: '#25282D',
  text: '#DDDCDA', textMid: '#9E9C98', textSoft: '#6E6C68',
  border: '#2F3338', rule: '#3A3E44',
  orange: '#D4672E', teal: '#3A9BA3', green: '#5A9B5E',
  amber: '#C49540', red: '#D05048', indigo: '#7E86B8',
  jack: '#7E86B8',
};

const ACCENTS = ['orange', 'teal', 'green', 'amber', 'red', 'indigo'];

// Verlet cable params.
const SEGMENTS = 28, GRAVITY = 0.45, DAMPING = 0.93, ITER = 7;

function rrectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function darken(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgb(${(r * (1 - a)) | 0},${(g * (1 - a)) | 0},${(b * (1 - a)) | 0})`;
}
function lighten(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgb(${(r + (255 - r) * a) | 0},${(g + (255 - g) * a) | 0},${(b + (255 - b) * a) | 0})`;
}

const cableKey = (c) => `${c.from.id}:${c.from.port}->${c.to.id}:${c.to.port}`;

function createRenderer(opts) {
  const { canvas, engine, pb = null } = opts;
  const ctx = canvas.getContext('2d');
  let rack = opts.rack || { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] };
  let colors = { ...DEFAULT_COLORS, ...(opts.colors || {}) };

  let W = 0, H = 0, DPR = 1;
  const view = { scale: 1, tx: 0, ty: 0 };
  const _cablePts = new Map();   // cableKey → points[]
  const _layoutCache = new WeakMap();   // def → layout

  function accent(name) { return colors[name] || colors.indigo; }

  // Per-row y origins from the rack's row list.
  function rowYs() {
    const ys = [];
    let y = 100;
    for (const r of rack.rows) {
      ys.push(y);
      const h = r.kind === '1U' ? ROW_1U_H : ROW_H;
      y += h + 2 * RAIL_H + ROW_GAP;
    }
    return ys;
  }
  function rowHeight(i) { return (rack.rows[i] && rack.rows[i].kind === '1U') ? ROW_1U_H : ROW_H; }

  // The faceplate covers both rails (top of the top rail to bottom of the
  // bottom rail) — like a real Eurorack panel. Rails show only in empty HP
  // gaps; screws (drawMounts) sit on the faceplate over the rail holes.
  function moduleRect(inst) {
    const ys = rowYs();
    const x = RAIL_LEFT + inst.hpPos * HP;
    const rowY = ys[inst.row] != null ? ys[inst.row] : ys[0];
    const w = inst.def.hp * HP;
    const ch = rowHeight(inst.row);
    return { x, y: rowY - RAIL_H, w, h: ch + 2 * RAIL_H };
  }

  // Auto-layout: knob row near top, ports row near bottom, display band between.
  // Manual layout (def.layout) overrides element positions when present.
  function layoutFor(def) {
    let lay = _layoutCache.get(def);
    if (lay) return lay;
    const w = def.hp * HP;
    const ch = def.height === '1U' ? ROW_1U_H : ROW_H;
    const h = ch + 2 * RAIL_H;      // faceplate height (covers both rails)
    // Flow the panel vertically: a mounting strip over each rail (for the
    // screws), then header → knob row (only if knobs) → display (fills the
    // middle) → jacks just above the bottom mounting strip. The +RAIL_H on the
    // header keeps content clear of the top rail-cover strip.
    const headerBottom = RAIL_H + 58;   // title + subtitle + divider, below the top strip
    const jackY = h - RAIL_H - 36;      // jacks above the bottom rail-cover strip
    const knobs = [];
    const nK = def.knobs.length;
    const knobY = headerBottom + 26;
    def.knobs.forEach((k, i) => {
      knobs.push({ name: k.name, label: k.label, x: (w * (i + 1)) / (nK + 1), y: knobY });
    });
    const ports = [];
    const all = [
      ...def.inPorts.map((p) => ({ name: p.name, side: 'in' })),
      ...def.outPorts.map((p) => ({ name: p.name, side: 'out', cable: p.cable })),
    ];
    const nP = all.length;
    all.forEach((p, i) => {
      ports.push({ ...p, x: (w * (i + 1)) / (nP + 1), y: jackY });
    });
    const dispTop = nK ? knobY + 24 : headerBottom + 8;
    const dispBottom = jackY - 16;   // leave room above the jack circles
    const display = { x: 14, y: dispTop, w: w - 28, h: Math.max(0, dispBottom - dispTop) };
    lay = { knobs, ports, display };
    // Manual override (positions in panel-local px).
    if (def.layout && typeof def.layout === 'object') Object.assign(lay, def.layout);
    _layoutCache.set(def, lay);
    return lay;
  }

  function portLocal(inst, name, side) {
    const lay = layoutFor(inst.def);
    return lay.ports.find((p) => p.name === name && p.side === side) || null;
  }
  function portWorldPos(inst, name, side) {
    const p = portLocal(inst, name, side);
    if (!p) return null;
    const r = moduleRect(inst);
    return { x: r.x + p.x, y: r.y + p.y };
  }
  function refPos(ref, side) {
    const inst = engine.instances.get(ref.id);
    if (!inst) return null;
    return portWorldPos(inst, ref.port, side);
  }

  // ── view ──
  function resize() {
    DPR = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
    W = canvas.clientWidth || canvas.width || 800;
    H = canvas.clientHeight || canvas.height || 600;
    canvas.width = W * DPR; canvas.height = H * DPR;
  }
  function screenToWorld(sx, sy) { return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function rackBBox() {
    const ys = rowYs();
    const lastY = ys[ys.length - 1] + rowHeight(rack.rows.length - 1);
    return {
      minX: RAIL_LEFT - 18, minY: ys[0] - RAIL_H - 18,
      maxX: RAIL_LEFT + rack.hp * HP + 18, maxY: lastY + RAIL_H + 18,
    };
  }
  function fitToViewport() {
    const b = rackBBox(), margin = 16;
    const wW = b.maxX - b.minX, wH = b.maxY - b.minY;
    view.scale = clamp(Math.min((W - margin * 2) / wW, (H - margin * 2) / wH), 0.3, 1.2);
    view.tx = (W - wW * view.scale) / 2 - b.minX * view.scale;
    view.ty = (H - wH * view.scale) / 2 - b.minY * view.scale;
  }

  // ── hit testing ──
  function findPortAt(wx, wy, inputType) {
    const screenR = inputType === 'touch' ? 22 : 14;
    const r = Math.max(11.5, screenR / view.scale), r2 = r * r;
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const lay = layoutFor(inst.def);
      const rect = moduleRect(inst);
      for (const p of lay.ports) {
        const dx = wx - (rect.x + p.x), dy = wy - (rect.y + p.y);
        if (dx * dx + dy * dy <= r2) return { id: inst.id, port: p.name, side: p.side };
      }
    }
    return null;
  }
  function findModuleAt(wx, wy) {
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const r = moduleRect(inst);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return inst;
    }
    return null;
  }
  function findKnobAt(wx, wy) {
    const list = [...engine.instances.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const inst = list[i];
      const lay = layoutFor(inst.def);
      const rect = moduleRect(inst);
      for (const k of lay.knobs) {
        const dx = wx - (rect.x + k.x), dy = wy - (rect.y + k.y);
        if (dx * dx + dy * dy <= 16 * 16) return { id: inst.id, name: k.name };
      }
    }
    return null;
  }

  // ── grid snap (grid-only placement; row + hpPos) ──
  function overlaps(inst, row, hpPos) {
    const lo = hpPos, hi = hpPos + inst.def.hp;
    for (const other of engine.instances.values()) {
      if (other === inst) continue;
      if (other.row !== row) continue;
      const olo = other.hpPos, ohi = other.hpPos + other.def.hp;
      if (lo < ohi && hi > olo) return true;
    }
    return false;
  }
  function snapTarget(inst, wx, wy, grabHp = 0) {
    const ys = rowYs();
    let row = 0, bd = Infinity;
    for (let i = 0; i < ys.length; i++) { const d = Math.abs(wy - ys[i]); if (d < bd) { bd = d; row = i; } }
    const maxHp = rack.hp - inst.def.hp;
    const hpPos = clamp(Math.round((wx - RAIL_LEFT) / HP - grabHp), 0, Math.max(0, maxHp));
    return {
      row, hpPos, valid: !overlaps(inst, row, hpPos),
      // Ghost matches the faceplate extent (covers the rails).
      x: RAIL_LEFT + hpPos * HP, y: ys[row] - RAIL_H, w: inst.def.hp * HP, h: rowHeight(row) + 2 * RAIL_H,
    };
  }

  // ── cable verlet ──
  function _ensurePts(key, a, b) {
    let pts = _cablePts.get(key);
    if (pts) return pts;
    pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / (SEGMENTS - 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * 30;
      pts.push({ x, y, px: x, py: y });
    }
    _cablePts.set(key, pts);
    return pts;
  }
  function _relax(pts, aPos, bPos) {
    const N = pts.length;
    const dist = Math.hypot(bPos.x - aPos.x, bPos.y - aPos.y);
    const slack = Math.max(75, dist * 0.18);
    const segLen = (dist + slack) / (N - 1);
    for (let i = 1; i < N - 1; i++) {
      const p = pts[i];
      const vx = (p.x - p.px) * DAMPING, vy = (p.y - p.py) * DAMPING;
      p.px = p.x; p.py = p.y;
      p.x += vx; p.y += vy + GRAVITY;
    }
    pts[0].x = aPos.x; pts[0].y = aPos.y;
    pts[N - 1].x = bPos.x; pts[N - 1].y = bPos.y;
    for (let it = 0; it < ITER; it++) {
      pts[0].x = aPos.x; pts[0].y = aPos.y;
      pts[N - 1].x = bPos.x; pts[N - 1].y = bPos.y;
      for (let i = 0; i < N - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const k = ((d - segLen) / d) * 0.5;
        const ox = dx * k, oy = dy * k;
        if (i > 0) { a.x += ox; a.y += oy; }
        if (i < N - 2) { b.x -= ox; b.y -= oy; }
      }
    }
  }
  function updateCables(drag) {
    const live = new Set();
    for (const c of engine.cables) {
      const key = cableKey(c);
      live.add(key);
      const aPos = refPos(c.from, 'out'), bPos = refPos(c.to, 'in');
      if (!aPos || !bPos) continue;
      _relax(_ensurePts(key, aPos, bPos), aPos, bPos);
    }
    for (const key of [..._cablePts.keys()]) if (!live.has(key)) _cablePts.delete(key);
    if (drag) {
      const aPos = drag.from ? refPos(drag.from, 'out') : drag.mouse;
      const bPos = drag.to ? refPos(drag.to, 'in') : drag.mouse;
      if (aPos && bPos) _relax(_ensurePts('__drag__', aPos, bPos), aPos, bPos);
    } else {
      _cablePts.delete('__drag__');
    }
  }

  // ── drawing ──
  function drawBg() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
    const sp = 26 * view.scale;
    if (sp >= 7) {
      ctx.fillStyle = colors.bgRaised;
      const ox = ((view.tx % sp) + sp) % sp, oy = ((view.ty % sp) + sp) % sp;
      for (let y = oy; y < H; y += sp) for (let x = ox; x < W; x += sp) ctx.fillRect(x, y, 1, 1);
    }
    ctx.setTransform(view.scale * DPR, 0, 0, view.scale * DPR, view.tx * DPR, view.ty * DPR);
  }
  function drawRail(x, y, w) {
    const g = ctx.createLinearGradient(0, y, 0, y + RAIL_H);
    g.addColorStop(0, '#3a3e44'); g.addColorStop(0.45, '#2d3137');
    g.addColorStop(0.55, '#252a30'); g.addColorStop(1, '#1a1d22');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, RAIL_H);
    ctx.fillStyle = '#4a4e54'; ctx.fillRect(x, y, w, 1);
    ctx.fillStyle = '#0a0c0e'; ctx.fillRect(x, y + RAIL_H - 1, w, 1);
    const n = Math.round(w / HP);
    for (let i = 0; i < n; i++) {
      const cx = x + i * HP + HP / 2, cy = y + RAIL_H / 2;
      ctx.fillStyle = '#0a0c0e'; ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3f4348'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.stroke();
    }
  }
  function drawRack() {
    const ys = rowYs(), w = rack.hp * HP;
    for (let i = 0; i < rack.rows.length; i++) {
      const y = ys[i], h = rowHeight(i);
      ctx.fillStyle = colors.bgDeep; ctx.fillRect(RAIL_LEFT, y, w, h);
      const sg = ctx.createLinearGradient(0, y, 0, y + 12);
      sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg; ctx.fillRect(RAIL_LEFT, y, w, 12);
      drawRail(RAIL_LEFT, y - RAIL_H, w);
      drawRail(RAIL_LEFT, y + h, w);
    }
  }
  // A mounting screw seated in the rail. Drawn AFTER modules + rails, at the
  // rail↔panel boundary, so each module reads as bolted to the rail.
  function railScrew(x, y) {
    ctx.fillStyle = '#0a0c0e'; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill();   // recess
    const g = ctx.createRadialGradient(x - 1.4, y - 1.6, 0.4, x, y, 3.4);
    g.addColorStop(0, '#7a7e84'); g.addColorStop(0.6, '#4a4e54'); g.addColorStop(1, '#23262b');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#15171a'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#0a0c0e'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 2.1, y - 0.6); ctx.lineTo(x + 2.1, y + 0.6); ctx.stroke();    // slot
  }
  function drawMounts(inst) {
    if (!getStyle(inst.def.style).screws) return;
    const r = moduleRect(inst);
    // Screws on the faceplate's mounting strips, over the rail hole centres.
    // The rail holes are HP-grid-centred (drawRail), so align to HP centres
    // near each panel edge — the screw reads as going through the faceplate
    // into the rail beneath.
    const topY = r.y + RAIL_H / 2, botY = r.y + r.h - RAIL_H / 2;
    for (const sx of [r.x + HP / 2, r.x + r.w - HP / 2]) { railScrew(sx, topY); railScrew(sx, botY); }
  }
  function drawKnob(cx, cy, value, label, accentColor) {
    const r = 14;
    ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(cx - 4, cy - 5, 1, cx, cy, r);
    g.addColorStop(0, '#3a3f46'); g.addColorStop(1, colors.bg);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const start = Math.PI * 0.75, end = Math.PI * 2.25, a = start + (end - start) * clamp(value, 0, 1);
    ctx.strokeStyle = accentColor; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3);
    ctx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
    ctx.stroke();
    ctx.fillStyle = colors.textSoft; ctx.font = '9px "Space Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + r + 4);
  }
  function drawPort(x, y, p, hovered) {
    const col = p.side === 'out' ? accent(p._accent || 'indigo') : colors.jack;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.bgDeep; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(x, y - 1, 0, x, y, 5);
    g.addColorStop(0, colors.bgRaised); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    if (hovered) {
      ctx.strokeStyle = colors.text; ctx.lineWidth = 2 / view.scale;
      ctx.beginPath(); ctx.arc(x, y, 11.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = p.side === 'out' ? col : colors.textSoft;
    ctx.font = '8.5px "Space Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(String(p.name).toUpperCase(), x, y + 11);
  }
  function drawModule(inst, hoveredPort, selected) {
    const r = moduleRect(inst), lay = layoutFor(inst.def), style = getStyle(inst.def.style);
    const bandColor = accent(inst.def.color);
    const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    g.addColorStop(0, colors[style.panel.top] || colors.bgBright);
    g.addColorStop(1, colors[style.panel.bottom] || colors.bgRaised);
    ctx.fillStyle = g; rrectPath(ctx, r.x, r.y, r.w, r.h, 2); ctx.fill();
    // Seated seam: a dark line along the top + bottom edges where the panel
    // tucks under the rail — reads as recessed into the rack, not a card laid
    // on top. (No drop shadow, for the same reason.)
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(r.x, r.y, r.w, 1.5); ctx.fillRect(r.x, r.y + r.h - 1.5, r.w, 1.5);
    ctx.strokeStyle = selected ? bandColor : (colors[style.panel.edge] || colors.border);
    ctx.lineWidth = selected ? 1.5 : 1; rrectPath(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2); ctx.stroke();
    // Header content sits below the top rail-cover/mounting strip (RAIL_H).
    if (style.accentStripe) { ctx.fillStyle = bandColor; ctx.fillRect(r.x + 3, r.y + RAIL_H + 3, r.w - 6, 2.5); }
    const headerColor = style.headerColor === 'accent' ? bandColor : (colors[style.headerColor] || colors.text);
    ctx.fillStyle = headerColor; ctx.font = style.headerFont; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(inst.def.title, r.x + r.w / 2, r.y + RAIL_H + 16);
    if (inst.def.subtitle) {
      ctx.fillStyle = colors.textSoft; ctx.font = style.labelFont;
      ctx.fillText(inst.def.subtitle.toUpperCase(), r.x + r.w / 2, r.y + RAIL_H + 38);
    }
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r.x + 18, r.y + RAIL_H + 56); ctx.lineTo(r.x + r.w - 18, r.y + RAIL_H + 56); ctx.stroke();
    // display band — pb (Phase C). Guarded so Phase B renders without it.
    if (pb && inst.def.display && lay.display.h > 4) {
      try {
        const out = {}; for (const n in inst.outputs) out[n] = inst.outputs[n].read();
        pb.run(inst, { x: r.x + lay.display.x, y: r.y + lay.display.y, w: lay.display.w, h: lay.display.h },
          out, style, colors, bandColor);
      } catch (e) { /* display errors never break the rack */ }
    }
    for (const k of lay.knobs) {
      // Normalize by the knob's declared range so the needle reflects value
      // for non-0..1 knobs (gain 0..4, pid gains, …) — drawKnob expects 0..1.
      const kd = inst.def.knobs.find((d) => d.name === k.name);
      const raw = engine.knobValue(inst.id, k.name);
      const norm = (kd && kd.max !== kd.min) ? (raw - kd.min) / (kd.max - kd.min) : raw;
      drawKnob(r.x + k.x, r.y + k.y, norm, k.label, bandColor);
    }
    for (const p of lay.ports) {
      p._accent = inst.def.color;
      const hov = hoveredPort && hoveredPort.id === inst.id && hoveredPort.port === p.name && hoveredPort.side === p.side;
      drawPort(r.x + p.x, r.y + p.y, p, hov);
    }
  }
  function drawCableStroke(pts, color) {
    if (pts.length < 2) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 7.5;
    ctx.beginPath(); ctx.moveTo(pts[0].x + 3, pts[0].y + 6);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + 3, pts[i].y + 6);
    ctx.stroke();
    for (const [w, c] of [[6.6, darken(color, 0.6)], [4.2, color]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.strokeStyle = lighten(color, 0.32); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y - 1.3);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y - 1.3);
    ctx.stroke();
    drawPlug(pts[0].x, pts[0].y, color); drawPlug(pts[pts.length - 1].x, pts[pts.length - 1].y, color);
  }
  function drawPlug(x, y, color) {
    ctx.fillStyle = darken(color, 0.65); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = lighten(color, 0.45); ctx.beginPath(); ctx.arc(x - 0.9, y - 0.9, 0.95, 0, Math.PI * 2); ctx.fill();
  }
  function cableColor(c) {
    const inst = engine.instances.get(c.from.id);
    return inst ? accent(inst.def.color) : colors.textMid;
  }
  function drawDragGhost(ghost) {
    if (!ghost) return;
    ctx.save(); ctx.lineWidth = 2 / view.scale;
    ctx.strokeStyle = ghost.valid ? colors.orange : colors.red;
    ctx.fillStyle = ghost.valid ? 'rgba(212,103,46,0.10)' : 'rgba(208,80,72,0.10)';
    rrectPath(ctx, ghost.x, ghost.y, ghost.w, ghost.h, 4); ctx.fill(); ctx.stroke(); ctx.restore();
  }

  // One full frame. state from interact.js: { dragGhost, dragCable, hoveredPort, selectedId, railsOn }
  function draw(state = {}) {
    drawBg();
    if (state.railsOn !== false) drawRack();
    updateCables(state.dragCable);
    drawDragGhost(state.dragGhost);
    for (const inst of engine.instances.values()) drawModule(inst, state.hoveredPort, inst.id === state.selectedId);
    if (state.railsOn !== false) for (const inst of engine.instances.values()) drawMounts(inst);
    for (const c of engine.cables) {
      const pts = _cablePts.get(cableKey(c));
      if (pts) drawCableStroke(pts, cableColor(c));
    }
    const dpts = _cablePts.get('__drag__');
    if (dpts && state.dragCable) {
      const src = state.dragCable.from || state.dragCable.to;
      const inst = src && engine.instances.get(src.id);
      drawCableStroke(dpts, inst ? accent(inst.def.color) : colors.textMid);
    }
  }

  return {
    view, get colors() { return colors; },
    setColors(t) { colors = { ...DEFAULT_COLORS, ...t }; },
    setRack(r) { rack = r; },
    get rack() { return rack; },
    resize, screenToWorld, fitToViewport, rowYs, rowHeight, moduleRect, layoutFor,
    portWorldPos, refPos, findPortAt, findModuleAt, findKnobAt, overlaps, snapTarget,
    updateCables, draw,
    get W() { return W; }, get H() { return H; }, get DPR() { return DPR; },
    ACCENTS,
  };
}

// -- interact.js --

// @gcu/patchbay — pointer/gesture interaction. Ported from the v0 sketch and
// routed to the engine (cables, knobs, placement) + the renderer (hit-tests,
// view transform). Exposes a mutable `state` the render loop reads each frame,
// and a `detach()`.
//
// v1 is grid-only (modules snap to row + HP slot); free placement is deferred.
// Gestures: drag jack → wire; drag knob → turn; drag panel → move; drag empty
// → pan; two pointers → pinch; wheel → zoom.


function attachInteraction(renderer, engine, canvas, opts = {}) {
  const onChange = opts.onChange || (() => {});       // mark dirty
  const onSelect = opts.onSelect || (() => {});       // selection changed → id|null
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
      return;
    }

    // knob → turn
    const knobHit = renderer.findKnobAt(wx, wy);
    if (knobHit) {
      select(knobHit.id);
      const inst = engine.instances.get(knobHit.id);
      const kdef = inst.def.knobs.find((k) => k.name === knobHit.name);
      gesture = { kind: 'knob', id: knobHit.id, name: knobHit.name, kdef,
                  startVal: engine.knobValue(knobHit.id, knobHit.name), startSy: sy, pointerId: e.pointerId };
      return;
    }

    // panel → move
    const inst = renderer.findModuleAt(wx, wy);
    if (inst) {
      select(inst.id);
      const r = renderer.moduleRect(inst);
      gesture = { kind: 'module', inst, grabHp: (wx - r.x) / HP,
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
      const snap = renderer.snapTarget(gesture.inst, wx, wy, gesture.grabHp);
      state.dragGhost = { x: snap.x, y: snap.y, w: snap.w, h: snap.h, valid: snap.valid };
      if (snap.valid) { gesture.inst.row = snap.row; gesture.inst.hpPos = snap.hpPos; }
    } else if (gesture.kind === 'knob') {
      const range = (gesture.kdef.max - gesture.kdef.min) || 1;
      const dv = (gesture.startSy - sy) / 160 * range;   // drag up → increase
      const v = clamp(gesture.startVal + dv, gesture.kdef.min, gesture.kdef.max);
      engine.setKnob(gesture.id, gesture.name, v);
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
      const snap = renderer.snapTarget(gesture.inst, ...lastWorld(e), gesture.grabHp);
      if (!snap.valid) { gesture.inst.row = gesture.startRow; gesture.inst.hpPos = gesture.startHp; }
      else if (gesture.inst.row !== gesture.startRow || gesture.inst.hpPos !== gesture.startHp) onChange();
      state.dragGhost = null; gesture = null; return;
    }
    if (gesture.kind === 'knob') { onChange(); gesture = null; return; }

    if (gesture.kind === 'wire') {
      const [wx, wy] = lastWorld(e);
      const hit = renderer.findPortAt(wx, wy, lastInputType);
      if (hit && hit.side === 'in' && gesture.from) {
        const res = engine.connect(gesture.from, { id: hit.id, port: hit.port });
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

// -- mount.js --

// @gcu/patchbay — surface glue. mountPatchbay(ctx) builds the canvas + chrome
// (toolbar, insert palette, properties panel) into ctx.root, wires the engine /
// renderer / interaction together, drives the rAF render loop, reads theme
// tokens, and returns { flush, dispose, isDirty } for the surface contract.
//
// ctx = { root, bus, tab, sr, doc?, onDirty? }
//   root   — element to render into (iframe body, or a privileged shadow root)
//   bus    — A-Bus peer (for the works VFS service + I/O modules)
//   tab    — { id, path, kind }
//   sr     — { signal, computed, effect, batch }
//   doc    — optional preloaded rack document (else loaded via LooseFileStore)
//   onDirty(bool) — optional dirty-state callback (drives the tab dot)








// --sw-* token → renderer color role.
const TOKEN_MAP = {
  bgDeep: '--sw-bg-deep', bg: '--sw-bg', bgRaised: '--sw-bg-raised', bgBright: '--sw-bg-bright',
  text: '--sw-text', textMid: '--sw-text-mid', textSoft: '--sw-text-soft',
  border: '--sw-border', rule: '--sw-rule',
  orange: '--sw-orange', teal: '--sw-teal', green: '--sw-green',
  amber: '--sw-amber', red: '--sw-red', indigo: '--sw-indigo',
};
function readThemeColors(el) {
  const cs = (typeof getComputedStyle !== 'undefined') ? getComputedStyle(el) : null;
  if (!cs) return { ...DEFAULT_COLORS };
  const out = { ...DEFAULT_COLORS };
  for (const [role, varName] of Object.entries(TOKEN_MAP)) {
    const v = cs.getPropertyValue(varName).trim();
    if (v) out[role] = v;
  }
  out.jack = out.indigo;
  return out;
}

function slug(type) { return type.split('.').pop().replace(/[^a-z0-9]+/gi, '-'); }
function freshId(engine, type) {
  const base = slug(type);
  if (!engine.instances.has(base)) return base;
  for (let i = 2; ; i++) if (!engine.instances.has(`${base}_${i}`)) return `${base}_${i}`;
}
function freeSlot(engine, rack, def) {
  const occ = (row, hp) => {
    for (const o of engine.instances.values()) {
      if (o.row !== row) continue;
      if (hp < o.hpPos + o.def.hp && hp + def.hp > o.hpPos) return true;
    }
    return false;
  };
  for (let row = 0; row < rack.rows.length; row++) {
    for (let hp = 0; hp <= rack.hp - def.hp; hp++) if (!occ(row, hp)) return { row, hpPos: hp };
  }
  return { row: 0, hpPos: 0 };
}

function mountPatchbay(ctx) {
  registerStdlib();
  const { root, bus, tab, sr } = ctx;
  const onDirty = ctx.onDirty || (() => {});
  const doc = root.ownerDocument || document;

  // ── DOM scaffold ──
  const host = doc.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--sw-bg,#15171A);';
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none;';
  host.appendChild(canvas);

  const css = `
    .pb-bar{position:absolute;top:8px;left:8px;display:flex;gap:6px;z-index:5;align-items:center}
    .pb-btn{background:var(--sw-bg-raised,#1D2024);border:1px solid var(--sw-border,#2F3338);color:var(--sw-text,#DDD);
      border-radius:4px;padding:6px 10px;font:10px/1 "Space Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
    .pb-btn:hover{background:var(--sw-bg-bright,#25282D)}
    .pb-btn.on{background:rgba(212,103,46,.22);border-color:var(--sw-orange,#D4672E);color:var(--sw-orange,#D4672E)}
    .pb-pop{position:absolute;z-index:8;background:rgba(20,23,26,.97);border:1px solid var(--sw-border,#2F3338);
      border-radius:6px;padding:5px;min-width:158px;max-height:74vh;overflow:auto;box-shadow:0 8px 28px rgba(0,0,0,.5);
      font:12px/1.4 Barlow,system-ui,sans-serif;display:none}
    .pb-pop.open{display:block}
    .pb-grp{font:600 9px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--sw-orange,#D4672E);padding:7px 6px 2px}
    .pb-item{display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border-radius:4px;cursor:pointer;color:var(--sw-text,#DDD)}
    .pb-item:hover{background:var(--sw-bg-bright,#25282D)}
    .pb-item .t{color:var(--sw-text-soft,#6E6C68);font:10px/1.5 "Space Mono",monospace}
    .pb-item.danger{color:var(--sw-red,#D05048)}
    .pb-props{position:absolute;top:8px;right:8px;width:208px;z-index:5;background:rgba(29,32,36,.94);
      border:1px solid var(--sw-border,#2F3338);border-radius:5px;padding:10px;color:var(--sw-text,#DDD);
      font:12px/1.5 Barlow,system-ui,sans-serif;display:none}
    .pb-props h4{margin:0 0 6px;font:700 12px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--sw-orange,#D4672E)}
    .pb-props label{display:block;font-size:10px;color:var(--sw-text-soft,#6E6C68);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px}
    .pb-props input{width:100%;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:3px;padding:4px 6px;font:11px "Space Mono",monospace;box-sizing:border-box}
    .pb-props input[type=range]{padding:0}
    .pb-props select{width:100%;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:3px;padding:4px 6px;font:11px "Space Mono",monospace;box-sizing:border-box}
    .pb-del{margin-top:12px;width:100%;background:rgba(208,80,72,.15);border-color:var(--sw-red,#D05048);color:var(--sw-red,#D05048)}
    .pb-hud{position:absolute;bottom:8px;right:8px;z-index:5;font:9.5px "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68);
      background:rgba(29,32,36,.88);border:1px solid var(--sw-border,#2F3338);border-radius:4px;padding:5px 8px}
  `;
  const styleEl = doc.createElement('style'); styleEl.textContent = css; host.appendChild(styleEl);

  const bar = doc.createElement('div'); bar.className = 'pb-bar';
  const paletteBtn = doc.createElement('button'); paletteBtn.className = 'pb-btn'; paletteBtn.textContent = '+ module';
  const fitBtn = doc.createElement('button'); fitBtn.className = 'pb-btn'; fitBtn.textContent = 'fit';
  bar.append(paletteBtn, fitBtn); host.appendChild(bar);

  // Palette popover (toolbar) + context menu (right-click) — both list module
  // types grouped by category and share renderModuleList.
  const palette = doc.createElement('div'); palette.className = 'pb-pop';
  palette.style.top = '44px'; palette.style.left = '8px';
  host.appendChild(palette);
  const ctxMenu = doc.createElement('div'); ctxMenu.className = 'pb-pop'; host.appendChild(ctxMenu);

  const props = doc.createElement('div'); props.className = 'pb-props'; host.appendChild(props);
  const hud = doc.createElement('div'); hud.className = 'pb-hud'; host.appendChild(hud);
  root.appendChild(host);

  const PREFIX_LABEL = { src: 'Sources', math: 'Math', logic: 'Logic', ctrl: 'Control', disp: 'Display', io: 'I/O' };
  function moduleGroups() {
    const groups = new Map();
    for (const def of listModuleDefs()) {
      const g = PREFIX_LABEL[def.type.split('.')[0]] || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(def);
    }
    return groups;
  }
  function renderModuleList(el, onPick) {
    el.innerHTML = '';
    for (const [grp, defs] of moduleGroups()) {
      const h = doc.createElement('div'); h.className = 'pb-grp'; h.textContent = grp; el.appendChild(h);
      for (const def of defs) {
        const it = doc.createElement('div'); it.className = 'pb-item';
        const name = doc.createElement('span'); name.textContent = def.title;
        const t = doc.createElement('span'); t.className = 't'; t.textContent = def.type;
        it.append(name, t);
        it.addEventListener('click', (e) => { e.stopPropagation(); onPick(def.type); });
        el.appendChild(it);
      }
    }
  }
  function hideMenus() { palette.classList.remove('open'); paletteBtn.classList.remove('on'); ctxMenu.classList.remove('open'); }

  // ── engine + renderer + interaction ──
  let dirty = false;
  const markDirty = () => { if (!dirty) { dirty = true; onDirty(true); } };
  const engine = createEngine(sr, { bus, sr });
  const pb = createPb(canvas.getContext('2d'));
  const renderer = createRenderer({ canvas, engine, pb, colors: readThemeColors(doc.documentElement) });

  // load rack
  const store = new LooseFileStore(bus, tab && tab.path);
  let rackDoc = ctx.doc || null;
  function applyDoc(d) {
    const rack = deserializeRack(d || blankRack(), engine);
    renderer.setRack(rack);
    renderer.resize(); renderer.fitToViewport();
  }
  if (rackDoc) applyDoc(rackDoc);
  else {
    applyDoc(blankRack());
    if (tab && tab.path) store.load().then((d) => { if (d) { engine.destroy(); applyDoc(d); } }).catch(() => {});
  }

  const interaction = attachInteraction(renderer, engine, canvas, {
    onChange: markDirty,
    onSelect: (id) => renderProps(id),
  });

  // ── insert (palette + context menu) / fit ──
  function addModuleAt(type, place) {
    const def = getModuleDef(type); if (!def) return;
    engine.addInstance(freshId(engine, type), type, place || freeSlot(engine, renderer.rack, def));
    markDirty();
  }
  function slotAtWorld(def, wx, wy) {
    const ys = renderer.rowYs();
    let row = 0, bd = Infinity;
    for (let i = 0; i < ys.length; i++) { const d = Math.abs(wy - ys[i]); if (d < bd) { bd = d; row = i; } }
    const hpPos = Math.max(0, Math.min(renderer.rack.hp - def.hp, Math.round((wx - RAIL_LEFT) / HP)));
    return renderer.overlaps({ def, row, hpPos }, row, hpPos) ? freeSlot(engine, renderer.rack, def) : { row, hpPos };
  }

  paletteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctxMenu.classList.remove('open');
    const open = !palette.classList.contains('open');
    if (open) renderModuleList(palette, (type) => addModuleAt(type));   // stays open for multi-add
    palette.classList.toggle('open', open);
    paletteBtn.classList.toggle('on', open);
  });
  fitBtn.addEventListener('click', () => renderer.fitToViewport());

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    palette.classList.remove('open'); paletteBtn.classList.remove('on');
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    const hitMod = renderer.findModuleAt(wx, wy);
    ctxMenu.innerHTML = '';
    if (hitMod) {
      interaction.select(hitMod.id);
      const it = doc.createElement('div'); it.className = 'pb-item danger';
      it.textContent = 'Delete ' + hitMod.def.title;
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        engine.removeInstance(hitMod.id); interaction.select(null); renderProps(null); markDirty(); hideMenus();
      });
      ctxMenu.appendChild(it);
    } else {
      renderModuleList(ctxMenu, (type) => { addModuleAt(type, slotAtWorld(getModuleDef(type), wx, wy)); hideMenus(); });
    }
    ctxMenu.style.left = Math.max(4, Math.min(sx, host.clientWidth - 172)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(sy, host.clientHeight - 80)) + 'px';
    ctxMenu.classList.add('open');
  });

  // Dismiss popovers on any plain click outside them. Chips + the toolbar
  // button stopPropagation, so picks don't self-close (multi-add) and the
  // toggle isn't immediately undone.
  const onDocClick = () => hideMenus();
  doc.addEventListener('click', onDocClick);

  // ── properties panel ──
  function renderProps(id) {
    const inst = id && engine.instances.get(id);
    if (!inst) { props.style.display = 'none'; return; }
    props.style.display = 'block';
    props.innerHTML = '';
    const h = doc.createElement('h4'); h.textContent = inst.def.title; props.appendChild(h);
    const sub = doc.createElement('div'); sub.style.cssText = 'font:10px "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68);margin-bottom:4px';
    sub.textContent = inst.type + '  ·  ' + inst.id; props.appendChild(sub);

    for (const [pn, pspec] of Object.entries(inst.def.params)) {
      const lab = doc.createElement('label'); lab.textContent = pspec.label || pn; props.appendChild(lab);
      let inp;
      if (pspec.kind === 'select' && Array.isArray(pspec.options)) {
        inp = doc.createElement('select');
        for (const o of pspec.options) { const opt = doc.createElement('option'); opt.value = o; opt.textContent = o; inp.appendChild(opt); }
        inp.value = inst.params[pn] != null ? inst.params[pn] : pspec.default;
        inp.addEventListener('change', () => { engine.setParam(inst.id, pn, inp.value); markDirty(); });
      } else {
        inp = doc.createElement('input');
        inp.type = pspec.kind === 'number' ? 'number' : 'text';
        inp.value = inst.params[pn] != null ? inst.params[pn] : '';
        inp.addEventListener('change', () => {
          const v = pspec.kind === 'number' ? parseFloat(inp.value) : inp.value;
          engine.setParam(inst.id, pn, v); markDirty();
        });
      }
      props.appendChild(inp);
    }
    for (const k of inst.def.knobs) {
      const lab = doc.createElement('label'); lab.textContent = k.label + ' (' + (Math.round(engine.knobValue(inst.id, k.name) * 100) / 100) + ')';
      props.appendChild(lab);
      const inp = doc.createElement('input'); inp.type = 'range'; inp.min = k.min; inp.max = k.max;
      inp.step = (k.max - k.min) / 200; inp.value = engine.knobValue(inst.id, k.name);
      inp.addEventListener('input', () => { engine.setKnob(inst.id, k.name, parseFloat(inp.value)); lab.textContent = k.label + ' (' + (Math.round(parseFloat(inp.value) * 100) / 100) + ')'; markDirty(); });
      props.appendChild(inp);
    }
    const del = doc.createElement('button'); del.className = 'pb-btn pb-del'; del.textContent = 'delete module';
    del.addEventListener('click', () => { engine.removeInstance(inst.id); interaction.select(null); renderProps(null); markDirty(); });
    props.appendChild(del);
  }

  // ── theme re-read on shell SettingsChanged ──
  let themeUnsub = null;
  if (bus && bus.subscribe) {
    themeUnsub = bus.subscribe({ interface: 'Shell', member: 'SettingsChanged' }, () => {
      setTimeout(() => renderer.setColors(readThemeColors(doc.documentElement)), 0);
    });
  }

  // ── render loop + resize ──
  let raf = 0;
  function frame() {
    renderer.draw(interaction.state);
    const z = Math.round(renderer.view.scale * 100);
    hud.textContent = engine.cables.length.toString().padStart(2, '0') + ' cab · ' + z + '%';
    raf = requestAnimationFrame(frame);
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => renderer.resize());
    ro.observe(canvas);
  } else if (typeof addEventListener !== 'undefined') {
    addEventListener('resize', () => renderer.resize());
  }
  raf = requestAnimationFrame(frame);

  // ── surface API ──
  async function flush() {
    if (!tab || !tab.path) return;
    await store.save(serializeRack(engine, renderer.rack));
    if (dirty) { dirty = false; onDirty(false); }
  }
  function dispose() {
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (typeof themeUnsub === 'function') { try { themeUnsub(); } catch { /* ignore */ } }
    doc.removeEventListener('click', onDocClick);
    interaction.detach();
    engine.destroy();
    try { root.removeChild(host); } catch { /* ignore */ }
  }

  return {
    flush, dispose,
    isDirty: () => dirty,
    engine, renderer,                 // exposed for tests / debugging
    addModule: (type) => { const d = getModuleDef(type); if (d) { const s = freeSlot(engine, renderer.rack, d); engine.addInstance(freshId(engine, type), type, s); markDirty(); } },
    STDLIB_MODULES,
  };
}
export {
  defineModule,
  getModuleDef,
  hasModuleDef,
  listModuleDefs,
  clearModuleRegistry,
  createEngine,
  PANEL_STYLES,
  getStyle,
  listStyles,
  FORMAT,
  VERSION,
  blankRack,
  serializeRack,
  deserializeRack,
  LooseFileStore,
  createPb,
  registerStdlib,
  STDLIB_MODULES,
  mountPatchbay,
};
