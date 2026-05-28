// @gcu/patchbay — rack document schema + persistence.
//
// One schema, two containers. v1 persists a rack as a single `.patchbay` JSON
// file (LooseFileStore). The schema is deliberately container-agnostic so a
// future ProjectStore (a /projects/<name>/ directory with project.json +
// rack.patchbay + modules/*.js) is a drop-in: same JSON, different load/save.

export const FORMAT = 'patchbay';
export const VERSION = 1;

export function blankRack() {
  return {
    format: FORMAT,
    version: VERSION,
    rack: { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] },
    modules: [],
    cables: [],
  };
}

// Engine state + rack geometry → plain doc object.
export function serializeRack(engine, rack) {
  const modules = [];
  for (const inst of engine.instances.values()) {
    const knobs = {};
    for (const name in inst.knobs) knobs[name] = inst.knobs[name].read();
    const controls = {};
    for (const name in inst.controls) {
      // momentary buttons persist released (0), not whatever transient state.
      controls[name] = inst.controls[name].def.kind === 'button' ? 0 : inst.controls[name].read();
    }
    const m = {
      id: inst.id,
      type: inst.type,
      row: inst.row,
      hpPos: inst.hpPos,
      knobs,
      params: { ...inst.params },
    };
    if (Object.keys(controls).length) m.controls = controls;
    modules.push(m);
  }
  const cables = engine.cables.map((c) => {
    const e = { from: { id: c.from.id, port: c.from.port }, to: { id: c.to.id, port: c.to.port } };
    if (c.color) e.color = c.color;
    return e;
  });
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
export function deserializeRack(doc, engine) {
  const d = typeof doc === 'string' ? JSON.parse(doc) : doc;
  if (!d || d.format !== FORMAT) throw new Error('patchbay: not a patchbay document');
  const rack = {
    hp: (d.rack && d.rack.hp) || 64,
    rows: ((d.rack && d.rack.rows) || [{ kind: '3U' }, { kind: '3U' }]).map((r) => ({ kind: r.kind || '3U' })),
  };
  for (const m of (d.modules || [])) {
    try {
      engine.addInstance(m.id, m.type, { row: m.row, hpPos: m.hpPos, knobs: m.knobs, controls: m.controls, params: m.params });
    } catch (e) {
      console.error('patchbay: skipping bad module on load:', m && m.id, e);
    }
  }
  for (const c of (d.cables || [])) {
    if (c && c.from && c.to) engine.connect(c.from, c.to, c.color);   // cycle/missing rejected silently
  }
  return rack;
}

// The RackStore interface is { load(): Promise<doc|null>, save(doc): Promise<void> }.
// v1 backend: a single .patchbay file read/written through the works VFS service.
export class LooseFileStore {
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
