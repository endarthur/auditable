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

// Interactive panel controls — operable widgets (vs knobs which only drag).
// kind: 'button' (momentary: 1 while pressed), 'toggle' (latching bool),
// 'switch' (N-position rotary, integer 0..N-1), 'fader' (vertical value slider).
// All are persistent signals at runtime (button persists 0); only render +
// interaction differ. They share the value namespace with knobs in process().
function normalizeControls(obj) {
  const out = [];
  for (const [name, raw] of Object.entries(obj || {})) {
    const c = (raw && typeof raw === 'object') ? raw : {};
    const kind = c.kind || 'toggle';
    const count = kind === 'switch'
      ? (Array.isArray(c.positions) ? c.positions.length : (c.count || 4))
      : 0;
    out.push({
      name, kind,
      label: c.label || name.toUpperCase(),
      default: ('default' in c) ? c.default : (kind === 'fader' ? 0.5 : 0),
      min: typeof c.min === 'number' ? c.min : 0,
      max: typeof c.max === 'number' ? c.max : 1,
      positions: Array.isArray(c.positions) ? c.positions : null,
      count,
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
export function defineModule(spec) {
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
    controls: normalizeControls(spec.controls),
    params: normalizeParams(spec.params),
    process: typeof spec.process === 'function' ? spec.process : null,
    setup: typeof spec.setup === 'function' ? spec.setup : null,
    display: typeof spec.display === 'function' ? spec.display : null,
    layout: spec.layout || null,
  };
  _moduleRegistry.set(def.type, def);
  return def;
}

export function getModuleDef(type) { return _moduleRegistry.get(type) || null; }
export function hasModuleDef(type) { return _moduleRegistry.has(type); }
export function listModuleDefs() { return [..._moduleRegistry.values()]; }

// Test/teardown helper — drop all registered types.
export function clearModuleRegistry() { _moduleRegistry.clear(); }
