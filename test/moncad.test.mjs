// moncad — the command registry (the spine: commands-as-data, one registry many surfaces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry, normalizeKey, fuzzyScore } from '../tools/moncad/js/commands.js';

// A tiny command set standing in for the real moncad commands.
function fixture() {
  const log = [];
  const reg = new CommandRegistry().registerAll([
    { id: 'draw.line', title: 'Line', category: 'Draw', keys: 'L', run: (ctx) => { log.push('line'); ctx.drawn = 'line'; } },
    { id: 'draw.circle', title: 'Circle', category: 'Draw', keys: 'C', run: () => log.push('circle') },
    { id: 'modify.offset', title: 'Offset', category: 'Modify', keys: 'O', when: (ctx) => ctx.hasSelection, run: () => log.push('offset') },
    { id: 'view.zoomExtents', title: 'Zoom Extents', category: 'View', keys: 'Shift+Ctrl+E', run: () => log.push('zoom') },
  ]);
  return { reg, log };
}

test('register / get / has', () => {
  const { reg } = fixture();
  assert.equal(reg.has('draw.line'), true);
  assert.equal(reg.get('draw.line').title, 'Line');
  assert.equal(reg.get('nope'), null);
  assert.throws(() => reg.register({ title: 'no id' }), /needs an id/);
  assert.throws(() => reg.register({ id: 'x' }), /needs a run/);
});

test('execute is the single path; honours when(); routes to the command', async () => {
  const { reg, log } = fixture();
  const ctx = { hasSelection: false };
  assert.deepEqual(await reg.execute('draw.line', ctx), { ok: true, result: undefined });
  assert.equal(ctx.drawn, 'line');
  assert.deepEqual(log, ['line']);
  // disabled command: returns an envelope, doesn't run, doesn't throw
  assert.deepEqual(await reg.execute('modify.offset', ctx), { ok: false, reason: 'disabled' });
  assert.deepEqual(log, ['line']);                                   // offset did NOT run
  ctx.hasSelection = true;
  assert.equal((await reg.execute('modify.offset', ctx)).ok, true);
  assert.deepEqual(log, ['line', 'offset']);
  await assert.rejects(() => reg.execute('ghost', ctx), /unknown command/);
});

test('isEnabled / list reflect context (drives greyed-out toolbar + menu)', () => {
  const { reg } = fixture();
  assert.equal(reg.isEnabled('draw.line', {}), true);               // no when() → always
  assert.equal(reg.isEnabled('modify.offset', { hasSelection: false }), false);
  assert.equal(reg.isEnabled('modify.offset', { hasSelection: true }), true);
  assert.deepEqual(reg.list({ category: 'Draw' }).map((c) => c.id), ['draw.line', 'draw.circle']);
  const enabled = reg.list({ ctx: { hasSelection: false }, enabledOnly: true }).map((c) => c.id);
  assert.ok(!enabled.includes('modify.offset'));                    // filtered out when disabled
  assert.deepEqual(reg.categories(), ['Draw', 'Modify', 'View']);
});

test('the no-drift guarantee: a command keybinding round-trips with the key that fires it', () => {
  const { reg } = fixture();
  // what a toolbar tooltip would show for Offset…
  assert.equal(reg.keyFor('modify.offset'), 'o');
  // …is exactly the key that resolves back to it
  assert.equal(reg.forKey('O'), 'modify.offset');
  assert.equal(reg.forKey('o'), 'modify.offset');
  // modifier order is canonicalised, so the tooltip and the handler agree regardless of spelling
  assert.equal(reg.keyFor('view.zoomExtents'), 'ctrl+shift+e');
  assert.equal(reg.forKey('Shift+Ctrl+E'), 'view.zoomExtents');
  assert.equal(reg.forKey('ctrl+shift+e'), 'view.zoomExtents');
});

test('normalizeKey: lowercases and orders modifiers canonically', () => {
  assert.equal(normalizeKey('Shift+Ctrl+K'), 'ctrl+shift+k');
  assert.equal(normalizeKey('meta+alt+S'), 'alt+meta+s');
  assert.equal(normalizeKey('L'), 'l');
});

test('search: fuzzy-ranks for the palette, respects when()', () => {
  const { reg } = fixture();
  // substring beats subsequence; "o" hits Offset (disabled-filtered when no selection)
  const noSel = reg.search('o', { hasSelection: false }).map((c) => c.id);
  assert.ok(!noSel.includes('modify.offset'));                      // disabled → not offered
  const withSel = reg.search('off', { hasSelection: true }).map((c) => c.id);
  assert.equal(withSel[0], 'modify.offset');                        // 'off' ranks Offset first
  // empty query opens the palette with everything
  assert.equal(reg.search('', { hasSelection: true }).length, 4);
});

test('fuzzyScore: substring > subsequence > miss', () => {
  assert.ok(fuzzyScore('off', 'offset') > fuzzyScore('ost', 'offset'));   // substring wins
  assert.ok(fuzzyScore('ost', 'offset') > 0);                            // subsequence matches
  assert.equal(fuzzyScore('xyz', 'offset'), 0);                          // miss
  assert.ok(fuzzyScore('', 'anything') > 0);                            // empty → weak match-all
});

// ── viewport (the camera / transform: pure, frame-aware) ──────────────────────────

import { Viewport } from '../tools/moncad/js/viewport.js';

test('viewport: centre maps to screen centre; toScreen/toWorld round-trip', () => {
  const v = new Viewport({ width: 800, height: 600, center: [10, 20], scale: 2 });
  assert.deepEqual(v.toScreen([10, 20]), [400, 300]);          // centre → middle of screen
  assert.deepEqual(v.toScreen([15, 25]), [410, 290]);          // +5 world x → +10px; +5 world y → -10px (y-up)
  const w = v.toWorld([410, 290]);
  assert.ok(Math.abs(w[0] - 15) < 1e-9 && Math.abs(w[1] - 25) < 1e-9);
});

test('viewport: panBy moves the centre opposite the drag (y-up)', () => {
  const v = new Viewport({ width: 800, height: 600, center: [0, 0], scale: 2 });
  v.panBy(20, 10);
  assert.deepEqual(v.center, [-10, 5]);
});

test('viewport: zoomAt pins the world point under the cursor', () => {
  const v = new Viewport({ width: 800, height: 600, center: [0, 0], scale: 2 });
  const cursor = [600, 200], before = v.toWorld(cursor);
  v.zoomAt(cursor, 1.5);
  const after = v.toWorld(cursor);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9);
  assert.ok(Math.abs(v.scale - 3) < 1e-9);
});

test('viewport: fit centres and scales a bounds into the view', () => {
  const v = new Viewport({ width: 800, height: 600, scale: 1 });
  v.fit({ min: [-100, -100], max: [100, 100] }, 0);
  assert.deepEqual(v.center, [0, 0]);
  assert.ok(Math.abs(v.scale - 3) < 1e-9);                      // min(800/200, 600/200) = 3
});

test('viewport: uniforms expose centre/scale/res for the GPU', () => {
  const v = new Viewport({ width: 800, height: 600, center: [5, 6], scale: 2 });
  assert.deepEqual(v.uniforms(), { center: [5, 6], scale: 2, res: [800, 600] });
});

// ── scene (the @gcu/dxf → renderer bridge: pure, frame-aware) ──────────────────────

import { read as dxfRead } from '../ext/dxf/src/read.js';
import { sceneFromDxf } from '../tools/moncad/js/scene.js';

const SCENE_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'W', '10', '600000', '20', '7700000', '30', '0', '11', '600100', '21', '7700050', '31', '0',
  '0', 'CIRCLE', '8', 'H', '10', '600050', '20', '7700040', '30', '0', '40', '5',
  '0', 'POINT', '8', 'P', '10', '600025', '20', '7700025', '30', '0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

test('scene: dxf Document → renderer instances, WORLD geometry shifted into LOCAL', () => {
  const sc = sceneFromDxf(dxfRead(SCENE_DXF));
  assert.deepEqual(sc.frame.origin, [600000, 7700000, 0]);        // adopted the doc's frame (bbox floor)
  // the LINE entered first → its segment is local (0,0)→(100,50)
  assert.equal(sc.lines[0], 0); assert.equal(sc.lines[1], 0);
  assert.equal(sc.lines[2], 100); assert.equal(sc.lines[3], 50);
  assert.equal(sc.points.length, 7);                              // exactly one POINT → 7 floats
  assert.ok(sc.bounds.max[0] >= 100 && sc.bounds.min[0] === 0);   // local bounds span the geometry
  assert.ok(sc.lines.length / 9 > 8);                             // line + circle tessellated to many segments
});

test('scene: a bulge span tessellates into multiple chords (arc, not a chord)', () => {
  const arcDxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'ARC', '8', 'A', '10', '600000', '20', '7700000', '30', '0', '40', '20', '50', '0', '51', '90',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n');
  const sc = sceneFromDxf(dxfRead(arcDxf), { eps: 0.05 });
  assert.ok(sc.lines.length / 9 >= 3);                            // a 90° r=20 arc → several chords, not one
});

// ── snap (the spatial index: pure) ─────────────────────────────────────────────────

import { SnapIndex } from '../tools/moncad/js/snap.js';

test('snap: nearest target within tolerance, type priority breaks ties', () => {
  const idx = new SnapIndex([{ p: [0, 0], type: 'end' }, { p: [10, 0], type: 'mid' }, { p: [100, 100], type: 'center' }]);
  assert.equal(idx.query([0.4, 0.3], 2).type, 'end');             // snaps to the near endpoint
  assert.equal(idx.query([10.1, 0], 1).type, 'mid');
  assert.equal(idx.query([50, 50], 5), null);                     // nothing within tolerance
  // an 'end' and a 'mid' coincident → end (higher priority) wins
  assert.equal(new SnapIndex([{ p: [0, 0], type: 'mid' }, { p: [0, 0], type: 'end' }]).query([0, 0], 1).type, 'end');
});

test('snap: query reaches across grid cells (auto-sized cell)', () => {
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push({ p: [i * 5, (i % 7) * 5], type: 'end' });
  const idx = new SnapIndex(pts);
  const hit = idx.query([497, 10], 4);                            // near (500,10) → i=100
  assert.ok(hit && Math.abs(hit.p[0] - 500) < 1e-9);
});

test('scene: emits snap targets (endpoints, midpoints, centre, node)', () => {
  const sc = sceneFromDxf(dxfRead(SCENE_DXF));
  const types = new Set(sc.snaps.map((s) => s.type));
  assert.ok(types.has('end') && types.has('mid') && types.has('center') && types.has('node'));
  assert.ok(sc.snaps.some((s) => s.type === 'center' && Math.abs(s.p[0] - 50) < 1e-9 && Math.abs(s.p[1] - 40) < 1e-9));  // circle centre local
  assert.ok(sc.snaps.some((s) => s.type === 'node' && Math.abs(s.p[0] - 25) < 1e-9));                                   // POINT
  assert.ok(sc.snaps.some((s) => s.type === 'end' && s.p[0] === 0 && s.p[1] === 0));                                    // LINE start
});

// ── the working model: live @gcu/dxf Document + undo/redo (SPEC §4) ────────────────
import { Model, emptyDoc } from '../tools/moncad/js/model.js';
import { polylineTool, TOOLS } from '../tools/moncad/js/tools.js';

test('model: empty doc is dxf-shaped; add appends + bumps rev', () => {
  const m = new Model();
  assert.deepEqual(Object.keys(emptyDoc()).sort(), ['blocks', 'features', 'frame', 'layers', 'warnings']);
  assert.equal(m.isEmpty(), true);
  assert.equal(m.rev, 0);
  const f = { type: 'point', geometry: { kind: 'point', position: [1, 2, 0] }, properties: {} };
  m.add(f);
  assert.equal(m.features.length, 1);
  assert.equal(m.features[0], f);
  assert.equal(m.rev, 1);
  assert.equal(m.isEmpty(), false);
});

test('model: undo/redo is the same stack; rev advances; redo cleared by a new edit', () => {
  const m = new Model();
  const a = { type: 'point', geometry: { kind: 'point', position: [0, 0, 0] }, properties: {} };
  const b = { type: 'point', geometry: { kind: 'point', position: [1, 1, 0] }, properties: {} };
  m.add(a); m.add(b);
  assert.equal(m.features.length, 2);
  assert.equal(m.undo(), true);
  assert.deepEqual(m.features, [a]);
  assert.equal(m.canRedo(), true);
  assert.equal(m.redo(), true);
  assert.deepEqual(m.features, [a, b]);
  // a fresh edit clears the redo stack
  m.undo();                       // back to [a]
  m.add(b);                       // new edit
  assert.equal(m.canRedo(), false);
  assert.equal(m.redo(), false);
  // exhaust undo
  assert.equal(m.undo(), true); assert.equal(m.undo(), true);
  assert.equal(m.undo(), false);
  assert.equal(m.isEmpty(), true);
});

// ── the polyline tool: collects local points, commits a WORLD-canonical feature ────
test('tools: polyline commits ≥2 points as a world polyline (local→world via the frame)', () => {
  const frame = { origin: [600000, 7700000, 0], crs: 'EPSG:31983', units: 'm' };
  let committed = null, done = 0;
  const t = polylineTool({ frame, onCommit: (f) => (committed = f), onDone: () => done++ });
  assert.equal(t.count(), 0);
  t.point([10, 5]); t.point([20, 5]); t.point([20, 15]);
  assert.deepEqual(t.last(), [20, 15]);
  t.finish();
  assert.equal(done, 1);
  assert.equal(committed.geometry.kind, 'polyline');
  assert.equal(committed.geometry.closed, false);
  // first vertex local [10,5] → world [600010, 7700005]
  const v = committed.geometry.vertices;
  assert.equal(v.length, 9);
  assert.ok(Math.abs(v[0] - 600010) < 1e-6 && Math.abs(v[1] - 7700005) < 1e-6);
});

test('tools: Close rings the polyline; <2 points commits nothing; preview rubber-bands', () => {
  const frame = { origin: [0, 0, 0], crs: null, units: 'm' };
  let committed = null, done = 0;
  const t = polylineTool({ frame, onCommit: (f) => (committed = f), onDone: () => done++ });
  // preview from last placed point to the cursor
  t.point([0, 0]); t.point([10, 0]);
  const g = t.preview([10, 10]);
  assert.equal(g.lines.length, 2);                 // one placed span + one to-cursor span
  assert.deepEqual(g.lines[1], [[10, 0], [10, 10]]);
  assert.equal(t.keyword('c'), true);              // Close
  assert.equal(committed.geometry.closed, true);
  assert.equal(done, 1);

  // a one-point polyline commits nothing
  committed = null; done = 0;
  const t2 = polylineTool({ frame, onCommit: (f) => (committed = f), onDone: () => done++ });
  t2.point([0, 0]); t2.finish();
  assert.equal(committed, null);
  assert.equal(done, 1);
  assert.ok(TOOLS.polyline);
});

test('tools: Undo keyword drops the last vertex', () => {
  const frame = { origin: [0, 0, 0], crs: null, units: 'm' };
  const t = polylineTool({ frame, onCommit: () => {}, onDone: () => {} });
  t.point([0, 0]); t.point([5, 0]); t.point([5, 5]);
  assert.equal(t.count(), 3);
  assert.equal(t.keyword('u'), true);
  assert.equal(t.count(), 2);
  assert.deepEqual(t.last(), [5, 0]);
});

// ── precision input: the AutoLISP coordinate family (SPEC §3) ──────────────────────
import { parsePoint } from '../tools/moncad/js/input.js';
import { lineTool, circleTool, pointTool } from '../tools/moncad/js/tools.js';

test('input: absolute x,y is WORLD → local (origin subtracted)', () => {
  const frame = { origin: [600000, 7700000, 0], units: 'm' };
  const r = parsePoint('600010, 7700005', null, frame);
  assert.ok(r.ok);
  assert.deepEqual(r.local, [10, 5]);
  // whitespace-separated works too
  assert.deepEqual(parsePoint('600010 7700005', null, frame).local, [10, 5]);
});

test('input: @dx,dy is relative to the last point', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  const r = parsePoint('@10,5', [3, 3], frame);
  assert.ok(r.ok);
  assert.deepEqual(r.local, [13, 8]);
  assert.equal(parsePoint('@10,5', null, frame).ok, false);     // no previous point
});

test('input: polar @d<a (relative) and d<a (absolute world)', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  const r = parsePoint('@10<90', [5, 5], frame);                 // up 10 from (5,5)
  assert.ok(r.ok);
  assert.ok(Math.abs(r.local[0] - 5) < 1e-9 && Math.abs(r.local[1] - 15) < 1e-9);
  const abs = parsePoint('10<0', null, frame);                   // absolute world (10,0)
  assert.ok(Math.abs(abs.local[0] - 10) < 1e-9 && Math.abs(abs.local[1]) < 1e-9);
});

test('input: garbage is rejected with an error, not a throw', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  assert.equal(parsePoint('', null, frame).ok, false);
  assert.equal(parsePoint('10', null, frame).ok, false);        // need x,y
  assert.equal(parsePoint('a,b', null, frame).ok, false);
  assert.equal(parsePoint('10<x', null, frame).ok, false);
});

test('tools: line is two points then auto-commits; circle = centre + radius (point or scalar)', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  let lf = null, ldone = 0;
  const lt = lineTool({ frame, onCommit: (f) => (lf = f), onDone: () => ldone++ });
  lt.point([0, 0]); assert.equal(ldone, 0);
  lt.point([10, 0]);                                            // second point auto-finishes
  assert.equal(ldone, 1);
  assert.equal(lf.type, 'line');
  assert.equal(lf.geometry.vertices.length, 6);

  let cf = null, cdone = 0;
  const ct = circleTool({ frame, onCommit: (f) => (cf = f), onDone: () => cdone++ });
  ct.point([5, 5]);                                             // centre
  assert.equal(ct.text('3'), true);                            // typed radius
  assert.equal(cf.geometry.kind, 'circle');
  assert.equal(cf.geometry.radius, 3);
  assert.ok(Math.abs(cf.geometry.center[0] - 5) < 1e-9);
  assert.equal(cdone, 1);
  // radius-by-point
  cf = null; cdone = 0;
  const ct2 = circleTool({ frame, onCommit: (f) => (cf = f), onDone: () => cdone++ });
  ct2.point([0, 0]); ct2.point([3, 4]);                        // radius = 5
  assert.equal(cf.geometry.radius, 5);

  let pf = null;
  const pt = pointTool({ frame, onCommit: (f) => (pf = f), onDone: () => {} });
  pt.point([2, 7]);
  assert.equal(pf.geometry.kind, 'point');
  assert.ok(Math.abs(pf.geometry.position[0] - 2) < 1e-9 && Math.abs(pf.geometry.position[1] - 7) < 1e-9);
});

test('registry: forAlias resolves typed names to command ids', () => {
  const reg = new CommandRegistry().registerAll([
    { id: 'draw.line', title: 'Line', alias: ['l', 'line'], run: () => {} },
    { id: 'draw.polyline', title: 'Polyline', alias: ['p', 'pl'], run: () => {} },
  ]);
  assert.equal(reg.forAlias('L'), 'draw.line');
  assert.equal(reg.forAlias(' pl '), 'draw.polyline');
  assert.equal(reg.forAlias('nope'), null);
});
