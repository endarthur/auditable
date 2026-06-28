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
import { sceneFromDxf, placeInstance } from '../tools/moncad/js/scene.js';

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
import { lineTool, circleTool, pointTool, arcTool } from '../tools/moncad/js/tools.js';

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
  lt.point([0, 0]); assert.equal(lf, null);                     // first point — nothing committed yet
  lt.point([10, 0]);                                            // second point commits the segment, keeps going
  assert.ok(lf && lf.type === 'line' && lf.geometry.vertices.length === 6);
  assert.equal(ldone, 0);                                       // continuous — not finished
  lt.finish(); assert.equal(ldone, 1);                          // Enter ends the chain

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

// ── snap-control (SPEC §7): the state + resolution layer ───────────────────────────
import { SnapState, pickSnap, OVERRIDE_WORDS } from '../tools/moncad/js/snap-control.js';

test('snap-control: master toggle short-circuits; running types gate eligibility', () => {
  const s = new SnapState();
  assert.equal(s.master, true);
  assert.deepEqual([...s.types].sort(), ['center', 'end', 'mid', 'node']);
  let r = s.resolve();
  assert.equal(r.live, true);
  assert.ok(r.allowed.has('end') && r.allowed.has('mid'));
  // turn off midpoint
  assert.equal(s.toggleType('mid'), false);
  assert.equal(s.resolve().allowed.has('mid'), false);
  // master off → not live
  assert.equal(s.toggleMaster(), false);
  assert.equal(s.resolve().live, false);
});

test('snap-control: one-shot override beats the master toggle, for one pick', () => {
  const s = new SnapState({ master: false });
  assert.equal(s.resolve().live, false);
  s.setOneShot('center');
  const r = s.resolve();
  assert.equal(r.live, true);
  assert.deepEqual([...r.allowed], ['center']);          // ONLY centre, even with master off
  s.clearOneShot();
  assert.equal(s.resolve().live, false);                 // back to master-off
  // the NONE override suppresses snapping for the next pick
  s.setOneShot('NONE');
  assert.equal(s.resolve().live, false);
});

test('snap-control: pickSnap filters by allowed set and cycles with Tab', () => {
  const cands = [
    { snap: { p: [0, 0], type: 'end' }, d: 0.1 },
    { snap: { p: [0, 1], type: 'mid' }, d: 0.2 },
    { snap: { p: [1, 0], type: 'end' }, d: 0.3 },
  ];
  const allowed = new Set(['end']);
  assert.equal(pickSnap(cands, allowed, 0).count, 2);                 // two 'end's eligible
  assert.deepEqual(pickSnap(cands, allowed, 0).hit.p, [0, 0]);        // best
  assert.deepEqual(pickSnap(cands, allowed, 1).hit.p, [1, 0]);        // Tab → next
  assert.deepEqual(pickSnap(cands, allowed, 2).hit.p, [0, 0]);        // wraps
  assert.equal(pickSnap(cands, new Set(['center']), 0).hit, null);   // none eligible
  assert.equal(pickSnap([], allowed, 0).hit, null);
});

test('snap-control: override vocabulary maps osnap words to types', () => {
  assert.equal(OVERRIDE_WORDS.cen, 'center');
  assert.equal(OVERRIDE_WORDS.centre, 'center');
  assert.equal(OVERRIDE_WORDS.end, 'end');
  assert.equal(OVERRIDE_WORDS.non, 'NONE');
  assert.equal(OVERRIDE_WORDS.banana, undefined);
});

test('snap: queryAll returns all candidates within tol, best-first', () => {
  const idx = new SnapIndex([
    { p: [0, 0], type: 'mid' }, { p: [0, 0], type: 'end' }, { p: [0.5, 0], type: 'node' },
  ]);
  const all = idx.queryAll([0, 0], 1);
  assert.equal(all.length, 3);
  assert.equal(all[0].snap.type, 'end');                 // higher priority than mid at same point
  assert.equal(all[1].snap.type, 'node');                // node (pri 4) before mid (pri 2)
});

// ── model edits: replace / addMany / remove, all invertible (E1 undo) ──────────────
test('model: applyEdit replaces in place and undo restores the prior features', () => {
  const m = new Model();
  const a = { type: 'point', geometry: { kind: 'point', position: [0, 0, 0] }, properties: {} };
  const b = { type: 'point', geometry: { kind: 'point', position: [1, 1, 0] }, properties: {} };
  m.add(a); m.add(b);
  const a2 = { type: 'point', geometry: { kind: 'point', position: [9, 9, 0] }, properties: {} };
  m.applyEdit([{ i: 0, feature: a2 }]);
  assert.equal(m.features[0], a2);
  assert.equal(m.undo(), true);
  assert.equal(m.features[0], a);                    // prior restored
  assert.equal(m.redo(), true);
  assert.equal(m.features[0], a2);
});

test('model: remove deletes by index and undo re-inserts at the same spots', () => {
  const m = new Model();
  const fs = [0, 1, 2, 3].map((k) => ({ type: 'point', geometry: { kind: 'point', position: [k, 0, 0] }, properties: {} }));
  m.addMany(fs);
  assert.equal(m.features.length, 4);
  m.remove([1, 3]);
  assert.deepEqual(m.features.map((f) => f.geometry.position[0]), [0, 2]);
  assert.equal(m.undo(), true);
  assert.deepEqual(m.features.map((f) => f.geometry.position[0]), [0, 1, 2, 3]);   // back in place
  // addMany undo removes them all in one step
  m.undo();
  assert.equal(m.features.length, 0);
});

// ── pick: entity hit-test + window select ─────────────────────────────────────────
import { pickFeature, pickWindow } from '../tools/moncad/js/pick.js';

test('pick: nearest feature within tolerance; circle by its rim, point by position', () => {
  const features = [
    { geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 10, 0, 0]), bulges: null, closed: false } },
    { geometry: { kind: 'circle', center: [50, 0, 0], radius: 5 } },
    { geometry: { kind: 'point', position: [0, 20, 0] } },
  ];
  assert.equal(pickFeature(features, [5, 0.5], 1), 0);       // on the segment
  assert.equal(pickFeature(features, [55, 0], 1), 1);        // on the circle rim (r=5)
  assert.equal(pickFeature(features, [50, 0], 1), -1);       // circle CENTRE is not the circle
  assert.equal(pickFeature(features, [0, 20.3], 1), 2);      // near the node
  assert.equal(pickFeature(features, [100, 100], 1), -1);    // nothing in range
});

test('pick: window select returns features whose bbox overlaps the box', () => {
  const features = [
    { geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 10, 10, 0]), bulges: null, closed: false } },
    { geometry: { kind: 'circle', center: [100, 100, 0], radius: 2 } },
  ];
  assert.deepEqual(pickWindow(features, [-1, -1, 11, 11]), [0]);
  assert.deepEqual(pickWindow(features, [-1, -1, 200, 200]), [0, 1]);
  assert.deepEqual(pickWindow(features, [40, 40, 60, 60]), []);
});

// ── edit-ops: the affine edit tools transform the selection ───────────────────────
import { makeEditTool } from '../tools/moncad/js/edit-ops.js';
import { translate as T, rotate as R, mirror as Mi } from '../ext/regula/src/transform.js';

function editFixture(kind) {
  const frame = { origin: [0, 0, 0], units: 'm' };
  const feat = { type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 10, 0, 0]), bulges: null, closed: false }, properties: { layer: '0' } };
  let result = null, done = 0;
  const t = makeEditTool({
    kind, frame, selectedGeoms: [{ i: 0, feature: feat }],
    xform: { translate: T, rotate: R, mirror: Mi },
    toLocalSegments: () => [],
    onResolve: (r) => (result = r), onDone: () => done++,
  });
  return { t, get result() { return result; }, get done() { return done; } };
}

test('edit-ops: move applies the base→destination delta to the selection', () => {
  const f = editFixture('move');
  f.t.point([2, 3]); f.t.point([12, 8]);             // delta = (10, 5)
  assert.equal(f.done, 1);
  const v = f.result.edit[0].feature.geometry.vertices;
  assert.deepEqual([v[0], v[1], v[3], v[4]], [10, 5, 20, 5]);
});

test('edit-ops: copy yields NEW features (does not edit in place)', () => {
  const f = editFixture('copy');
  f.t.point([0, 0]); f.t.point([0, 100]);
  assert.ok(f.result.copy && !f.result.edit);
  assert.equal(f.result.copy[0].geometry.vertices[1], 100);
});

test('edit-ops: rotate takes a typed angle in degrees (text path)', () => {
  const f = editFixture('rotate');
  f.t.point([0, 0]);                                  // pivot at origin
  assert.equal(f.t.text('90'), true);                 // 90° CCW
  const v = f.result.edit[0].feature.geometry.vertices;
  assert.ok(Math.abs(v[0]) < 1e-9 && Math.abs(v[1]) < 1e-9);          // (0,0) fixed
  assert.ok(Math.abs(v[3]) < 1e-9 && Math.abs(v[4] - 10) < 1e-9);     // (10,0) → (0,10)
});

test('edit-ops: mirror reflects across the picked axis', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  const feat = { type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([0, 2, 0, 10, 2, 0]), bulges: null, closed: false }, properties: {} };
  let result = null;
  const t = makeEditTool({ kind: 'mirror', frame, selectedGeoms: [{ i: 0, feature: feat }], xform: { translate: T, rotate: R, mirror: Mi }, toLocalSegments: () => [], onResolve: (r) => (result = r), onDone: () => {} });
  t.point([0, 0]); t.point([1, 0]);                   // axis = x-axis → y:2 reflects to -2
  const v = result.edit[0].feature.geometry.vertices;
  assert.deepEqual([v[1], v[4]], [-2, -2]);
});

// ── reference grid + grid-snap (deferred furniture) ───────────────────────────────
import { niceStep, computeGrid, snapToGrid } from '../tools/moncad/js/grid.js';

test('grid: niceStep rounds to 1/2/5×10ⁿ', () => {
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(2.9), 2);
  assert.equal(niceStep(6), 5);
  assert.equal(niceStep(8), 10);
  assert.equal(niceStep(73), 100);
  assert.equal(niceStep(0.35), 0.5);
});

test('grid: computeGrid picks a screen-relative step and emits ruled lines', () => {
  const v = new Viewport({ width: 700, height: 500, center: [0, 0], scale: 7, dpr: 1 });   // 70/7 = 10
  const g = computeGrid(v);
  assert.equal(g.step, 10);
  assert.ok(g.lines.length > 0 && g.lines.length % 9 === 0);
});

test('grid: snapToGrid returns the nearest node within tolerance, else null', () => {
  assert.deepEqual(snapToGrid([2, 3], 10, 4), [0, 0]);
  assert.equal(snapToGrid([2, 3], 10, 2), null);
  assert.deepEqual(snapToGrid([12, 18], 10, 3), [10, 20]);
});

// ── layers (L1): hydrate, bylayer colour, visibility, opacity ─────────────────────
import { hydrateLayers, LAYER_PALETTE } from '../tools/moncad/js/model.js';

test('layers: hydrate ensures 0 + feature layers, with visible/opacity defaults', () => {
  const doc = { frame: { origin: [0, 0, 0] }, layers: {}, features: [{ properties: { layer: 'PIT' }, geometry: { kind: 'point', position: [0, 0, 0] } }] };
  hydrateLayers(doc);
  assert.ok(doc.layers['0'] && doc.layers['PIT']);
  assert.equal(doc.layers['0'].visible, true);
  assert.equal(doc.layers['PIT'].opacity, 1);
  assert.ok(LAYER_PALETTE.length >= 6);
});

test('model: addLayer + layerList; new Model auto-hydrates', () => {
  const m = new Model();
  assert.deepEqual(m.layerList().map((l) => l.name), ['0']);
  m.addLayer('TOPO', { mode: 'aci', index: 3 });
  assert.deepEqual(m.layerList().map((l) => l.name), ['0', 'TOPO']);
  assert.equal(m.getLayer('TOPO').color.index, 3);
});

function layerDoc(extra = {}) {
  return {
    frame: { origin: [0, 0, 0] },
    layers: { '0': { name: '0', color: { mode: 'aci', index: 7 }, visible: true, opacity: 1 }, A: { name: 'A', color: { mode: 'aci', index: 1 }, visible: true, opacity: 1, ...extra } },
    features: [{ type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 10, 0, 0]), bulges: null, closed: false }, properties: { layer: 'A', color: { mode: 'bylayer' } } }],
  };
}

test('scene: a bylayer feature takes its layer colour (ACI 1 = red)', () => {
  const sc = sceneFromDxf(layerDoc());
  // line format [p0x,p0y,p1x,p1y, width, r,g,b,a]; the layer colour is red
  assert.deepEqual([sc.lines[5], sc.lines[6], sc.lines[7]], [1, 0, 0]);
});

test('scene: a hidden layer is off the board (no segments, no snaps)', () => {
  const sc = sceneFromDxf(layerDoc({ visible: false }));
  assert.equal(sc.lines.length, 0);
  assert.equal(sc.snaps.length, 0);
});

test('scene: layer opacity carries into the segment alpha', () => {
  const sc = sceneFromDxf(layerDoc({ opacity: 0.4 }));
  assert.ok(Math.abs(sc.lines[8] - 0.4) < 1e-6);   // the alpha channel (Float32 buffer)
});

// ── layers L2: rename / delete (non-destructive) / reorder + render z-order ────────
test('model: renameLayer repoints features; refuses 0, clash, missing', () => {
  const m = new Model({ frame: { origin: [0, 0, 0] }, layers: {}, features: [{ properties: { layer: 'A' }, geometry: { kind: 'point', position: [0, 0, 0] } }] });
  assert.equal(m.renameLayer('A', 'PIT'), true);
  assert.ok(m.getLayer('PIT') && !m.getLayer('A'));
  assert.equal(m.features[0].properties.layer, 'PIT');     // feature repointed
  assert.equal(m.renameLayer('0', 'X'), false);            // can't rename '0'
  assert.equal(m.renameLayer('PIT', '0'), false);          // clash
});

test('model: removeLayer is non-destructive — geometry moves to 0', () => {
  const m = new Model({ frame: { origin: [0, 0, 0] }, layers: {}, features: [{ properties: { layer: 'A' }, geometry: { kind: 'point', position: [0, 0, 0] } }] });
  assert.equal(m.removeLayer('A'), true);
  assert.equal(m.getLayer('A'), undefined);
  assert.equal(m.features[0].properties.layer, '0');        // geometry preserved, on '0'
  assert.equal(m.removeLayer('0'), false);                  // can't delete '0'
});

test('model: moveLayer swaps the render z-order', () => {
  const m = new Model();
  m.addLayer('A'); m.addLayer('B');
  assert.deepEqual(m.layerList().map((l) => l.name), ['0', 'A', 'B']);   // ascending order
  assert.equal(m.moveLayer('A', 1), true);                                // raise A above B
  assert.deepEqual(m.layerList().map((l) => l.name), ['0', 'B', 'A']);
});

test('scene: features draw in layer z-order (low order behind)', () => {
  const doc = {
    frame: { origin: [0, 0, 0] },
    layers: { '0': { name: '0', color: { mode: 'aci', index: 7 }, visible: true, opacity: 1, order: 5 }, BK: { name: 'BK', color: { mode: 'aci', index: 1 }, visible: true, opacity: 1, order: 0 } },
    features: [
      { type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 1, 0, 0]), bulges: null, closed: false }, properties: { layer: '0' } },     // front (order 5)
      { type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([9, 9, 0, 8, 9, 0]), bulges: null, closed: false }, properties: { layer: 'BK' } },    // back (order 0)
    ],
  };
  const sc = sceneFromDxf(doc);
  // BK (order 0) draws first → its segment (starting at 9,9) leads
  assert.equal(sc.lines[0], 9); assert.equal(sc.lines[1], 9);
});

test('model: reorderLayer drag-places a layer in front of a target (z-order)', () => {
  const m = new Model();
  m.addLayer('A'); m.addLayer('B');                       // ascending: 0, A, B
  assert.equal(m.reorderLayer('0', 'B'), true);           // drop '0' above B → highest z
  assert.deepEqual(m.layerList().map((l) => l.name), ['A', 'B', '0']);
  assert.equal(m.reorderLayer('A', 'A'), false);          // no self-drop
});

test('tools: polyline arc mode draws tangent arcs (PLINE-arc gesture)', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  let committed = null;
  const t = polylineTool({ frame, onCommit: (f) => (committed = f), onDone: () => {} });
  t.point([0, 0]); t.point([10, 0]);          // straight span → tangent at (10,0) is +x
  assert.equal(t.keyword('a'), true);          // switch to arc mode
  t.point([20, 10]);                           // arc tangent to +x, ending (20,10) → 45° chord
  t.finish();
  const b = committed.geometry.bulges;
  assert.ok(b && b[0] === 0);                   // first span straight
  assert.ok(Math.abs(b[1] - Math.tan(Math.PI / 8)) < 1e-9);   // tangent-arc bulge = tan(45°/2)
  assert.equal(t.keyword('l'), true);          // and back to line mode works
});

test('tools: arc tool — 3-point arc passes through the middle point', () => {
  const frame = { origin: [0, 0, 0], units: 'm' };
  let committed = null;
  const t = arcTool({ frame, onCommit: (f) => (committed = f), onDone: () => {} });
  t.point([10, 0]); t.point([0, 10]); t.point([-10, 0]);     // top semicircle through (0,10)
  assert.equal(committed.type, 'arc');
  assert.ok(Math.abs(committed.geometry.bulges[0] - 1) < 1e-9);   // semicircle bulge = tan(π/4) = 1
  const v = committed.geometry.vertices;
  assert.deepEqual([v[0], v[1], v[3], v[4]], [10, 0, -10, 0]);    // start, end = 1st, 3rd picks
});

// ── blocks: definitions + live instances ──────────────────────────────────────────
const SQUARE = { type: 'polyline', geometry: { kind: 'polyline', vertices: Float64Array.from([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0]), bulges: null, closed: true }, properties: { layer: '0' } };

test('placeInstance: transforms a block geometry by position/scale/rotation about the base', () => {
  // scale ×2, rotate 90°, at (30,20); base origin → vertex (4,0) → (30,28)
  const g = placeInstance(SQUARE.geometry, { position: [30, 20, 0], scale: [2, 2, 2], rotation: 90 }, [0, 0, 0]);
  const v = g.vertices;
  assert.ok(Math.abs(v[0] - 30) < 1e-9 && Math.abs(v[1] - 20) < 1e-9);     // (0,0) → position
  assert.ok(Math.abs(v[3] - 30) < 1e-9 && Math.abs(v[4] - 28) < 1e-9);     // (4,0)·2 rot90 → (0,8) + pos
});

test('model: addBlock + swap (make-block is one undoable step)', () => {
  const m = new Model();
  m.add(SQUARE); m.add({ ...SQUARE, type: 'point', geometry: { kind: 'point', position: [1, 1, 0] } });
  assert.equal(m.features.length, 2);
  m.addBlock('sq', [SQUARE], [0, 0, 0]);
  assert.deepEqual(m.blockNames(), ['sq']);
  const insert = { type: 'insert', geometry: { kind: 'insert', block: 'sq', transform: { position: [10, 10, 0], scale: [1, 1, 1], rotation: 0 } }, properties: { layer: '0' } };
  m.swap([0, 1], [insert]);                       // drop the two originals, add the instance
  assert.equal(m.features.length, 1);
  assert.equal(m.features[0].type, 'insert');
  m.undo();                                        // restores the two originals, removes the instance
  assert.equal(m.features.length, 2);
  assert.equal(m.features[0].type, 'polyline');
});

test('scene: an INSERT renders the block body placed (live instance)', () => {
  const doc = { frame: { origin: [0, 0, 0], units: 'm' }, layers: {}, blocks: { sq: { name: 'sq', base: [0, 0, 0], features: [SQUARE] } },
    features: [{ type: 'insert', geometry: { kind: 'insert', block: 'sq', transform: { position: [10, 0, 0], scale: [1, 1, 1], rotation: 0 } }, properties: { layer: '0' } }] };
  const sc = sceneFromDxf(doc, { eps: 0.2 });
  assert.equal(sc.lines.length / 9, 4);            // the square's 4 spans, placed
  assert.equal(sc.snaps.length, 1);                // the insertion point
});
