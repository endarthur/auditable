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
