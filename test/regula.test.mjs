// @gcu/regula — the transform tier (similarity + reflection of the bulge-primitive).
// The correctness focus is the BULGE: preserved under similarities, negated under mirror,
// and the geometry is always returned fresh (inputs never mutated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, rotate, scale, mirror } from '../ext/regula/src/transform.js';

const pline = (pts, bulges = null, closed = false) => {
  const v = new Float64Array(pts.length * 3);
  pts.forEach((p, i) => { v[i * 3] = p[0]; v[i * 3 + 1] = p[1]; v[i * 3 + 2] = p[2] || 0; });
  return { kind: 'polyline', vertices: v, bulges: bulges ? Float64Array.from(bulges) : null, closed };
};
const xy = (g) => { const v = g.vertices, out = []; for (let i = 0; i < v.length; i += 3) out.push([v[i], v[i + 1]]); return out; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('translate: shifts every vertex; bulge + closed flag carried through', () => {
  const g = pline([[0, 0], [10, 0], [10, 5]], [0, 0.5], true);
  const r = translate(g, [3, -2]);
  assert.deepEqual(xy(r), [[3, -2], [13, -2], [13, 3]]);
  assert.deepEqual([...r.bulges], [0, 0.5]);          // bulge unchanged
  assert.equal(r.closed, true);
  assert.deepEqual(xy(g), [[0, 0], [10, 0], [10, 5]]); // input not mutated
});

test('translate / scale: circle centre moves, radius only scales', () => {
  const c = { kind: 'circle', center: [5, 5, 0], radius: 4 };
  assert.deepEqual(translate(c, [1, 2]).center, [6, 7, 0]);
  assert.equal(translate(c, [1, 2]).radius, 4);
  const s = scale(c, 2, [0, 0]);
  assert.deepEqual(s.center, [10, 10, 0]);
  assert.equal(s.radius, 8);
});

test('rotate: 90° about origin; bulge UNCHANGED (a similarity preserves arc shape)', () => {
  const g = pline([[1, 0], [2, 0]], [0.3]);
  const r = rotate(g, Math.PI / 2);
  const p = xy(r);
  assert.ok(near(p[0][0], 0) && near(p[0][1], 1));
  assert.ok(near(p[1][0], 0) && near(p[1][1], 2));
  assert.deepEqual([...r.bulges], [0.3]);
});

test('scale: about a pivot; negative factor is a point-reflection → bulge still UNCHANGED', () => {
  const g = pline([[2, 0], [4, 0]], [0.5]);
  const r = scale(g, -1, [0, 0]);                     // 180° point reflection
  assert.deepEqual(xy(r), [[-2, 0], [-4, 0]]);
  assert.deepEqual([...r.bulges], [0.5]);             // orientation preserved → bulge kept
  assert.equal(scale(g, 3, [2, 0]).vertices[0], 2);   // pivot stays fixed
});

test('mirror: reflects across an axis and NEGATES the bulge (orientation reverses)', () => {
  const g = pline([[0, 1], [4, 1]], [0.5]);
  const r = mirror(g, [0, 0], [1, 0]);                // reflect across the x-axis
  assert.deepEqual(xy(r), [[0, -1], [4, -1]]);
  assert.deepEqual([...r.bulges], [-0.5]);            // the signature mirror behaviour
  // a degenerate axis (a==b) is the identity, not a crash
  assert.deepEqual(xy(mirror(g, [2, 2], [2, 2])), [[0, 1], [4, 1]]);
});

test('point geometry transforms too', () => {
  const pt = { kind: 'point', position: [3, 4, 0] };
  assert.deepEqual(translate(pt, [1, 1]).position, [4, 5, 0]);
  assert.deepEqual(rotate(pt, Math.PI, [0, 0]).position.map((n) => Math.round(n)), [-3, -4, 0]);
});

test('round-trip: rotate then rotate back recovers the geometry', () => {
  const g = pline([[1, 2], [5, 7], [9, 3]], [0.2, -0.4], true);
  const there = rotate(g, 0.7, [3, 3]);
  const back = rotate(there, -0.7, [3, 3]);
  xy(back).forEach((p, i) => { assert.ok(near(p[0], xy(g)[i][0]) && near(p[1], xy(g)[i][1])); });
  assert.deepEqual([...back.bulges], [0.2, -0.4]);
});
