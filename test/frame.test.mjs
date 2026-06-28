// @gcu/frame — the coordinate-frame contract: world↔local framing + CRS identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFrame, WORLD, sameProjection, frameEq,
  toLocal, toWorld, toLocalCoords, toWorldCoords,
  originFromBounds, frameFromBounds, extentTolerance,
  delta, withFrame, rebaseCoords, canonCrs,
} from '../ext/frame/src/frame.js';

test('makeFrame: normalises origin to [x,y,z], defaults crs/units', () => {
  assert.deepEqual(makeFrame({ origin: [1, 2, 3] }), { origin: [1, 2, 3], crs: null, units: 'm' });
  assert.deepEqual(makeFrame({ origin: [1, 2] }).origin, [1, 2, 0]);          // 2D → z=0
  assert.deepEqual(makeFrame().origin, [0, 0, 0]);                            // no args
  const f = makeFrame({ origin: [5e5, 7.7e6, 1e3], crs: 'EPSG:31983', units: 'm' });
  assert.equal(f.crs, 'EPSG:31983');
  assert.deepEqual(WORLD.origin, [0, 0, 0]);
});

test('toLocal / toWorld: round-trip is lossless at UTM magnitude', () => {
  const f = makeFrame({ origin: [600000, 7700000, 1000] });
  const world = [600123.456, 7700987.654, 1042.5];
  const local = toLocal(world, f);
  assert.ok(Math.abs(local[0] - 123.456) < 1e-6);                             // small magnitude
  assert.ok(Math.abs(local[1] - 987.654) < 1e-6);                             // (f64 slack in the
  assert.equal(local[2], 42.5);                                               //  intermediate is fine)
  assert.deepEqual(toWorld(local, f), world);                                 // round-trip EXACT — the invariant
});

test('toLocal / toWorld: handle 2D points', () => {
  const f = makeFrame({ origin: [600000, 7700000, 1000] });
  assert.deepEqual(toLocal([600010, 7700020], f), [10, 20]);                  // z untouched (absent)
  assert.deepEqual(toWorld([10, 20], f), [600010, 7700020]);
});

test('WORLD is the identity', () => {
  const p = [123.4, 567.8, 9.0];
  assert.deepEqual(toLocal(p, WORLD), p);
  assert.deepEqual(toWorld(p, WORLD), p);
});

test('toLocalCoords / toWorldCoords: bulk f64 recentre, new buffer, round-trip', () => {
  const f = makeFrame({ origin: [600000, 7700000, 1000] });
  const world = Float64Array.from([600001, 7700002, 1003, 600004, 7700005, 1006]);
  const local = toLocalCoords(world, f);
  assert.ok(local instanceof Float64Array);
  assert.deepEqual([...local], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...toWorldCoords(local, f)], [...world]);                 // round-trip
  assert.deepEqual([...world], [600001, 7700002, 1003, 600004, 7700005, 1006]); // input untouched
});

test('toLocalCoords: small locals survive the f32 downcast that world would not', () => {
  const f = makeFrame({ origin: [0, 7700000, 0] });
  const world = Float64Array.from([0, 7700000.1, 0]);                        // +0.1 m at 7.7e6
  // world straight to f32: the 0.1 m detail is below f32 resolution at this magnitude
  assert.equal(Math.fround(7700000.1), 7700000);                             // lost
  // through the frame: local 0.1 survives f32
  const local = toLocalCoords(world, f);
  assert.ok(Math.abs(Math.fround(local[1]) - 0.1) < 1e-6);                   // kept
});

test('originFromBounds: centroid (default) and floor, rounded to a nice anchor', () => {
  const bounds = { min: [600100, 7700100, 950], max: [600900, 7700900, 1050] };
  assert.deepEqual(originFromBounds(bounds), [600500, 7700500, 1000]);       // centroid, round=1
  assert.deepEqual(originFromBounds(bounds, { strategy: 'floor' }), [600100, 7700100, 950]);
  assert.deepEqual(originFromBounds(bounds, { round: 1000 }), [601000, 7701000, 1000]); // snapped (round-to-nearest)
  assert.deepEqual(frameFromBounds(bounds, { crs: 'EPSG:31983' }).origin, [600500, 7700500, 1000]);
  assert.equal(frameFromBounds(bounds, { crs: 'EPSG:31983' }).crs, 'EPSG:31983');
});

test('extentTolerance: scales with the working extent (a fixed 1e-9 would not)', () => {
  const f = makeFrame({ origin: [0, 0, 0], units: 'm' });
  assert.equal(extentTolerance(f, 1000).eps, 1e-9 * 1000);                   // scales with extent
  assert.equal(extentTolerance(f, 1).eps, 1e-9);
  assert.equal(extentTolerance(f, 0).eps, 1e-9);                             // degenerate extent → floor 1
  assert.equal(extentTolerance(f, 1000).units, 'm');
});

test('sameProjection / delta: a frame shift is allowed, a reprojection throws', () => {
  const a = makeFrame({ origin: [600000, 7700000, 0], crs: 'EPSG:31983' });
  const b = makeFrame({ origin: [600500, 7700500, 0], crs: 'EPSG:31983' });
  assert.equal(sameProjection(a, b), true);
  assert.deepEqual(delta(a, b), [-500, -500, 0]);                            // localB = localA + (-500,-500)

  const c = makeFrame({ origin: [0, 0, 0], crs: 'EPSG:32723' });            // different CRS
  assert.equal(sameProjection(a, c), false);
  assert.throws(() => delta(a, c), /reprojection, which @gcu\/frame does not perform/);

  const m = makeFrame({ origin: [0, 0, 0], units: 'ft' });                  // different units
  assert.equal(sameProjection(a, m), false);
  assert.throws(() => delta(a, m), /reprojection/);

  // null crs is a wildcard — unstamped frames don't block on a check nobody declared
  assert.equal(sameProjection(makeFrame({ origin: [0, 0, 0] }), a), true);
});

test('delta consistency: rebasing via delta equals world round-trip', () => {
  const a = makeFrame({ origin: [600000, 7700000, 1000] });
  const b = makeFrame({ origin: [600500, 7700200, 1000] });
  const localA = [123, 456, 7];
  const viaWorld = toLocal(toWorld(localA, a), b);
  const d = delta(a, b);
  const viaDelta = localA.map((v, i) => v + d[i]);
  assert.deepEqual(viaDelta, viaWorld);
});

test('withFrame: stamps .frame without moving coordinates', () => {
  const f = makeFrame({ origin: [600000, 7700000, 0] });
  const artifact = { id: 'x', coords: [1, 2, 3] };
  const stamped = withFrame(artifact, f);
  assert.equal(stamped.frame, f);
  assert.deepEqual(stamped.coords, [1, 2, 3]);                              // unchanged
  assert.equal(artifact.frame, undefined);                                  // pure (original untouched)
});

test('rebaseCoords: re-expresses a buffer and returns an accountable record', () => {
  const a = makeFrame({ origin: [600000, 7700000, 1000], crs: 'EPSG:31983' });
  const b = makeFrame({ origin: [600100, 7700100, 1000], crs: 'EPSG:31983' });
  const inA = Float64Array.from([100, 200, 5]);                             // local-in-a
  const { coords, record } = rebaseCoords(inA, a, b);
  assert.deepEqual([...coords], [0, 100, 5]);                               // local-in-b
  assert.equal(record.op, 'rebase');
  assert.deepEqual(record.delta, [-100, -100, 0]);
  assert.deepEqual(record.from.origin, [600000, 7700000, 1000]);
  assert.deepEqual(record.to.origin, [600100, 7700100, 1000]);
  assert.deepEqual([...inA], [100, 200, 5]);                                // input untouched
  // round-trip through world agrees
  assert.deepEqual(toLocalCoords(toWorldCoords(inA, a), b), coords);
});

test('rebaseCoords: refuses to cross CRS (it is not a reprojection)', () => {
  const a = makeFrame({ origin: [0, 0, 0], crs: 'EPSG:31983' });
  const c = makeFrame({ origin: [0, 0, 0], crs: 'EPSG:32723' });
  assert.throws(() => rebaseCoords(Float64Array.from([1, 2, 3]), a, c), /reprojection/);
});

test('frameEq: full structural equality', () => {
  const a = makeFrame({ origin: [1, 2, 3], crs: 'EPSG:31983', units: 'm' });
  assert.equal(frameEq(a, makeFrame({ origin: [1, 2, 3], crs: 'EPSG:31983' })), true);
  assert.equal(frameEq(a, makeFrame({ origin: [1, 2, 4], crs: 'EPSG:31983' })), false);
  assert.equal(frameEq(a, makeFrame({ origin: [1, 2, 3], crs: 'EPSG:32723' })), false);
});

test('canonCrs / sameProjection: EPSG codes compare by identity, not spelling', () => {
  assert.equal(canonCrs('EPSG:31983'), '31983');
  assert.equal(canonCrs('epsg:31983'), '31983');
  assert.equal(canonCrs('  31983 '), '31983');
  assert.equal(canonCrs(null), null);
  // the bug this fixes: differently-spelled codes must NOT spuriously read as a reprojection
  const a = makeFrame({ origin: [6e5, 7.7e6, 0], crs: 'EPSG:31983' });
  const b = makeFrame({ origin: [6e5 + 100, 7.7e6, 0], crs: '31983' });
  const c = makeFrame({ origin: [6e5, 7.7e6, 0], crs: 'epsg:31983' });
  assert.equal(sameProjection(a, b), true);
  assert.deepEqual(delta(a, b), [-100, 0, 0]);            // does NOT throw on the spelling difference
  assert.equal(frameEq(a, c), true);                      // same projection + origin + units
  assert.equal(sameProjection(a, makeFrame({ origin: [0, 0, 0], crs: 'EPSG:32723' })), false);  // genuinely different still blocks
});
