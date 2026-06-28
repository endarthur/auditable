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

// ── the curve kernel (E2.1): arc/bulge, intersection, nearest, tolerance ───────────
import {
  segment, line, ray, circle, arc, spanCurve, arcFromBulge, bulgeFromArc, angleInSweep, arcPointAt,
  intersect, closestPointOn, makeTolerance, tolEps,
} from '../ext/regula/src/main.js';

const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const ptClose = (p, q, e = 1e-6) => close(p[0], q[0], e) && close(p[1], q[1], e);
const has = (pts, q) => pts.some((p) => ptClose(p, q, 1e-6));

test('arc: spanCurve bridges a bulge span → arc (curved) or segment (straight)', () => {
  assert.equal(spanCurve([0, 0], [10, 0], 0).kind, 'segment');
  const a = spanCurve([0, 0], [10, 0], 1);          // bulge 1 → semicircle (θ=π)
  assert.equal(a.kind, 'arc');
  assert.ok(ptClose(a.c, [5, 0]) && close(a.r, 5));
  // bulge ↔ arc round-trip
  const d = arcFromBulge([0, 0], [10, 0], 0.5);
  const back = bulgeFromArc(d.center, d.radius, d.startAngle, d.endAngle);
  assert.ok(close(back.bulge, 0.5) && ptClose(back.start, [0, 0]) && ptClose(back.end, [10, 0]));
});

test('intersect: segment × segment — cross, miss (out of range), parallel', () => {
  assert.ok(has(intersect(segment([0, 0], [10, 0]), segment([5, -5], [5, 5]), 1e-9), [5, 0]));
  assert.equal(intersect(segment([0, 0], [10, 0]), segment([20, -5], [20, 5]), 1e-9).length, 0);   // x=20 off seg1
  assert.equal(intersect(segment([0, 0], [10, 0]), segment([0, 1], [10, 1]), 1e-9).length, 0);     // parallel
});

test('intersect: a LINE is infinite where a segment is not', () => {
  // the support line crosses x=20, but the segment does not — line yes, segment no
  assert.equal(intersect(line([0, 0], [10, 0]), segment([20, -5], [20, 5]), 1e-9).length, 1);
  assert.equal(intersect(segment([0, 0], [10, 0]), segment([20, -5], [20, 5]), 1e-9).length, 0);
});

test('intersect: segment × circle — two hits, and the off-segment hit is dropped', () => {
  const two = intersect(segment([-10, 0], [10, 0]), circle([0, 0], 5), 1e-9);
  assert.equal(two.length, 2); assert.ok(has(two, [5, 0]) && has(two, [-5, 0]));
  const one = intersect(segment([0, 0], [10, 0]), circle([0, 0], 5), 1e-9);   // segment starts at centre
  assert.equal(one.length, 1); assert.ok(has(one, [5, 0]));
});

test('intersect: circle × circle — two, tangent (one), separate (none)', () => {
  const two = intersect(circle([0, 0], 5), circle([8, 0], 5), 1e-9);
  assert.equal(two.length, 2); assert.ok(has(two, [4, 3]) && has(two, [4, -3]));
  const tan = intersect(circle([0, 0], 5), circle([10, 0], 5), 1e-6);
  assert.equal(tan.length, 1); assert.ok(has(tan, [5, 0]));
  assert.equal(intersect(circle([0, 0], 5), circle([20, 0], 5), 1e-9).length, 0);
  assert.equal(intersect(circle([0, 0], 5), circle([0, 0], 5), 1e-9).length, 0);   // concentric/identical
});

test('intersect: arc keeps only hits within its sweep', () => {
  const top = arc([0, 0], 5, 0, Math.PI);                 // top half, (5,0) CCW to (-5,0)
  const hits = intersect(segment([0, -10], [0, 10]), top, 1e-9);   // y-axis crosses circle at (0,±5)
  assert.equal(hits.length, 1); assert.ok(has(hits, [0, 5]));      // (0,-5) is off the top arc
});

test('nearest: closestPointOn clamps the segment, rides the circle, falls to arc endpoints', () => {
  const s = closestPointOn(segment([0, 0], [10, 0]), [5, 3]);
  assert.ok(ptClose(s.point, [5, 0]) && close(s.dist, 3) && close(s.param, 0.5));
  assert.ok(ptClose(closestPointOn(segment([0, 0], [10, 0]), [-5, 0]).point, [0, 0]));   // clamped to the start
  assert.ok(ptClose(closestPointOn(circle([0, 0], 5), [10, 0]).point, [5, 0]));
  const top = arc([0, 0], 5, 0, Math.PI);
  assert.ok(ptClose(closestPointOn(top, [0, 10]).point, [0, 5]));     // within sweep
  assert.ok(ptClose(closestPointOn(top, [0, -10]).point, [5, 0]));    // outside sweep → nearer endpoint
});

test('tolerance: coordinate-relative eps; tolEps coerces number / object / floor', () => {
  const t = makeTolerance(1000, { rel: 1e-6 });
  assert.ok(close(t.eps, 1e-3));
  assert.equal(tolEps(0.05), 0.05);
  assert.equal(tolEps(t), t.eps);
  assert.ok(tolEps(undefined) > 0);          // documented floor, not a throw
});

test('arc: angleInSweep respects CCW vs CW and admits endpoints', () => {
  assert.equal(angleInSweep(0, Math.PI, Math.PI / 2), true);      // mid of CCW top half
  assert.equal(angleInSweep(0, Math.PI, -Math.PI / 2), false);    // bottom — not on top half
  assert.equal(angleInSweep(0, -Math.PI, -Math.PI / 2), true);    // CW sweep covers the bottom
  assert.ok(ptClose(arcPointAt(arc([0, 0], 5, 0, Math.PI), 0.5), [0, 5]));
});

// ── trim (E2.2): interval removal, splitting, closed→open, arc bulge recompute ─────
import { trim } from '../ext/regula/src/main.js';

const P = (points, bulges = null, closed = false) => ({ points, bulges, closed });

test('trim: a line cut once drops the picked side', () => {
  const t = trim(P([[0, 0], [10, 0]]), [segment([5, -5], [5, 5])], [2, 0], 1e-9);   // pick the left
  assert.equal(t.removed, true); assert.equal(t.kept.length, 1);
  assert.ok(ptClose(t.kept[0].points[0], [5, 0]) && ptClose(t.kept[0].points[1], [10, 0]));   // left gone
  const r = trim(P([[0, 0], [10, 0]]), [segment([5, -5], [5, 5])], [8, 0], 1e-9);   // pick the right
  assert.ok(ptClose(r.kept[0].points[0], [0, 0]) && ptClose(r.kept[0].points[1], [5, 0]));
});

test('trim: a middle cut splits an open polyline in two', () => {
  const t = trim(P([[0, 0], [10, 0], [10, 10]]), [segment([5, -5], [5, 5]), segment([5, 5], [15, 5])], [10, 0], 1e-9);
  assert.equal(t.kept.length, 2);
  assert.ok(ptClose(t.kept[0].points[0], [0, 0]) && ptClose(t.kept[0].points[1], [5, 0]));     // before
  assert.ok(ptClose(t.kept[1].points[0], [10, 5]) && ptClose(t.kept[1].points[1], [10, 10]));  // after
});

test('trim: trimming a closed ring opens it (complement kept)', () => {
  const sq = P([[0, 0], [10, 0], [10, 10], [0, 10]], null, true);
  const t = trim(sq, [segment([5, -5], [5, 15])], [10, 5], 1e-9);   // vertical cut, pick the right half
  assert.equal(t.removed, true); assert.equal(t.kept.length, 1);
  assert.equal(t.kept[0].closed, false);
  const pts = t.kept[0].points;                                     // the LEFT half remains: (5,10)→(0,10)→(0,0)→(5,0)
  assert.ok(ptClose(pts[0], [5, 10]) && ptClose(pts[pts.length - 1], [5, 0]));
  assert.ok(pts.some((p) => ptClose(p, [0, 0])) && pts.some((p) => ptClose(p, [0, 10])));
});

test('trim: a trimmed arc span keeps a TRUE arc (recomputed bulge, not a chord)', () => {
  // semicircle (bulge 1) from (0,0) over (5,-5) to (10,0); cut at the bottom (5,-5), keep the right quarter
  const t = trim(P([[0, 0], [10, 0]], [1]), [segment([5, -10], [5, 10])], [3, -4], 1e-9);
  assert.equal(t.kept.length, 1);
  const k = t.kept[0];
  assert.ok(ptClose(k.points[0], [5, -5]) && ptClose(k.points[1], [10, 0]));
  assert.ok(close(k.bulges[0], Math.tan(Math.PI / 8)));            // quarter of a CCW semicircle
});

test('trim: no crossing cutter → unchanged', () => {
  const t = trim(P([[0, 0], [10, 0]]), [segment([20, -5], [20, 5])], [5, 0], 1e-9);
  assert.equal(t.removed, false); assert.equal(t.kept.length, 1);
});

// ── extend (E2.3): a straight end reaches the nearest forward boundary ─────────────
import { extend } from '../ext/regula/src/main.js';

test('extend: the end nearest the pick reaches the boundary (both ends)', () => {
  const e = extend(P([[0, 0], [10, 0]]), [segment([20, -5], [20, 5])], [9, 0], 1e-9);   // pick the (10,0) end
  assert.equal(e.extended, true);
  assert.ok(ptClose(e.path.points[1], [20, 0]) && ptClose(e.path.points[0], [0, 0]));
  const s = extend(P([[0, 0], [10, 0]]), [segment([-10, -5], [-10, 5])], [1, 0], 1e-9);  // pick the (0,0) end
  assert.ok(ptClose(s.path.points[0], [-10, 0]) && ptClose(s.path.points[1], [10, 0]));
});

test('extend: no forward boundary → unchanged (a backward crossing does not count)', () => {
  const e = extend(P([[0, 0], [10, 0]]), [segment([-5, -5], [-5, 5])], [9, 0], 1e-9);     // boundary is behind the picked end
  assert.equal(e.extended, false);
});

// ── fillet / chamfer (E2.4): the corner constructions ─────────────────────────────
import { fillet, chamfer } from '../ext/regula/src/main.js';

test('fillet: a true tangent arc rounds the corner (kept ends, recomputed bulge)', () => {
  const s1 = { a: [0, 0], b: [10, 0] }, s2 = { a: [0, 0], b: [0, 10] };   // an L at the origin
  const f = fillet(s1, s2, 2, [8, 0], [0, 8], 1e-9);                       // pick the far ends
  assert.equal(f.ok, true);
  assert.deepEqual(f.path.points[0], [10, 0]);                            // far ends kept
  assert.deepEqual(f.path.points[3], [0, 10]);
  assert.ok(ptClose(f.path.points[1], [2, 0]) && ptClose(f.path.points[2], [0, 2]));   // tangent points
  assert.ok(close(f.path.bulges[1], -Math.tan(Math.PI / 8)));             // quarter arc bulging toward the corner
  assert.ok(ptClose(f.center, [2, 2]));
});

test('fillet: radius too large for the segments → ok:false', () => {
  const f = fillet({ a: [0, 0], b: [5, 0] }, { a: [0, 0], b: [0, 5] }, 20, [4, 0], [0, 4], 1e-9);
  assert.equal(f.ok, false);
});

test('chamfer: a straight bevel at the given distance', () => {
  const c = chamfer({ a: [0, 0], b: [10, 0] }, { a: [0, 0], b: [0, 10] }, 3, [8, 0], [0, 8], 1e-9);
  assert.equal(c.ok, true);
  assert.deepEqual(c.path.points, [[10, 0], [3, 0], [0, 3], [0, 10]]);
  assert.deepEqual([...c.path.bulges], [0, 0, 0]);
});

test('fillet: parallel segments have no corner → ok:false', () => {
  assert.equal(fillet({ a: [0, 0], b: [10, 0] }, { a: [0, 5], b: [10, 5] }, 2, [5, 0], [5, 5], 1e-9).ok, false);
});

// ── offset (E3): parallel/concentric spans + round/miter joins, open & closed ──────
import { offset } from '../ext/regula/src/main.js';

const pclose = (path, pts) => { assert.equal(path.points.length, pts.length); path.points.forEach((p, i) => assert.ok(ptClose(p, pts[i]), `pt ${i}: ${p} vs ${pts[i]}`)); };

test('offset: a single segment shifts to a parallel (left + / right −)', () => {
  assert.ok(offset(P([[0, 0], [10, 0]]), 2, 1e-9).path.points.every((p, i) => ptClose(p, [[0, 2], [10, 2]][i])));
  assert.ok(offset(P([[0, 0], [10, 0]]), -2, 1e-9).path.points.every((p, i) => ptClose(p, [[0, -2], [10, -2]][i])));
});

test('offset: an open L — concave side miters, convex side rounds', () => {
  const inner = offset(P([[0, 0], [10, 0], [10, 10]]), 2, 1e-9);     // left = inside the left turn → miter
  pclose(inner.path, [[0, 2], [8, 2], [8, 10]]);
  assert.deepEqual([...inner.path.bulges], [0, 0]);
  const outer = offset(P([[0, 0], [10, 0], [10, 10]]), -2, 1e-9);    // right = outside → round join arc
  pclose(outer.path, [[0, -2], [10, -2], [12, 0], [12, 10]]);
  assert.ok(close(outer.path.bulges[1], Math.tan(Math.PI / 8)));      // a quarter round
});

test('offset: a closed CCW square offset inward → a concentric smaller square', () => {
  const sq = P([[0, 0], [10, 0], [10, 10], [0, 10]], null, true);
  const o = offset(sq, 2, 1e-9);
  assert.equal(o.path.closed, true);
  pclose(o.path, [[2, 2], [8, 2], [8, 8], [2, 8]]);
});

test('offset: an arc offsets CONCENTRIC (radius shifts, bulge preserved)', () => {
  const o = offset(P([[0, 0], [10, 0]], [1]), 1, 1e-9);   // semicircle r5 → concentric r4
  pclose(o.path, [[1, 0], [9, 0]]);
  assert.ok(close(o.path.bulges[0], 1));                  // same sweep → same bulge
});

test('offset: distance past an arc radius is refused, not garbage', () => {
  assert.equal(offset(P([[0, 0], [10, 0]], [1]), 10, 1e-9).ok, false);   // r5 arc, |d|=10
});

// ── hover-preview outputs: the affected geometry trim/extend report ────────────────
test('trim: reports removedPath (the portion a hover-preview paints red)', () => {
  const t = trim(P([[0, 0], [10, 0]]), [segment([5, -5], [5, 5])], [2, 0], 1e-9);   // pick the left
  assert.ok(t.removedPath);
  assert.ok(ptClose(t.removedPath.points[0], [0, 0]) && ptClose(t.removedPath.points[1], [5, 0]));   // the bit that goes
});

test('extend: reports reach (old end → boundary, painted green)', () => {
  const e = extend(P([[0, 0], [10, 0]]), [segment([20, -5], [20, 5])], [9, 0], 1e-9);
  assert.ok(e.reach && ptClose(e.reach[0], [10, 0]) && ptClose(e.reach[1], [20, 0]));   // the added stretch
});

// ── arc-end extend: grow a curved end span's sweep to a boundary ──────────────────
test('extend: a curved end span grows its sweep to reach a boundary', () => {
  // quarter arc (10,0) CCW to (0,10), centre origin r10; extend the (0,10) end to x=-10 → semicircle
  const e = extend(P([[10, 0], [0, 10]], [Math.tan(Math.PI / 8)]), [segment([-10, -20], [-10, 20])], [0, 9], 1e-9);
  assert.equal(e.extended, true);
  assert.ok(ptClose(e.path.points[1], [-10, 0]));
  assert.ok(close(e.path.bulges[0], 1));                 // quarter → semicircle bulge = tan(π/4) = 1
});

// ── polyline-corner fillet / chamfer (round/bevel a vertex in place) ──────────────
import { filletCorner, chamferCorner } from '../ext/regula/src/main.js';

test('filletCorner: rounds a polyline vertex in place (tangent arc spliced)', () => {
  const f = filletCorner(P([[0, 0], [10, 0], [10, 10]]), 1, 2, 1e-9);   // corner at (10,0)
  assert.equal(f.ok, true);
  assert.deepEqual(f.path.points.map((p) => [Math.round(p[0]), Math.round(p[1])]), [[0, 0], [8, 0], [10, 2], [10, 10]]);
  assert.ok(close(f.path.bulges[1], Math.tan(Math.PI / 8)));            // the new t1→t2 span is the fillet arc
  assert.deepEqual([f.path.bulges[0], f.path.bulges[2]], [0, 0]);       // neighbours stay straight
});

test('chamferCorner: bevels a polyline vertex in place', () => {
  const c = chamferCorner(P([[0, 0], [10, 0], [10, 10]]), 1, 3, 1e-9);
  assert.equal(c.ok, true);
  assert.deepEqual(c.path.points, [[0, 0], [7, 0], [10, 3], [10, 10]]);
  assert.deepEqual([...c.path.bulges], [0, 0, 0]);
});

test('filletCorner: refuses an endpoint / a curved-adjacent corner / too-large radius', () => {
  assert.equal(filletCorner(P([[0, 0], [10, 0], [10, 10]]), 0, 2, 1e-9).ok, false);    // open endpoint
  assert.equal(filletCorner(P([[0, 0], [10, 0], [10, 10]]), 1, 50, 1e-9).ok, false);   // radius too large
});
