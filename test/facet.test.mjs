// @gcu/facet — structural geology on a triangulated surface.
//
// The load-bearing tests here are the round trips: a synthetic plane built AT a
// known attitude has to come back AT that attitude. The original's failure mode
// was a conversion that looked plausible and was wrong, so "it returned a number"
// proves nothing — only the round trip does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attitude, normalOf, fitTensor, fitPlane,
  brush, distanceToRay,
  geodesic, geodesicField, geodesicBall,
  nodeClasses, detectSets,
  buildAdjacency, components,
} from '../ext/facet/src/main.js';

// ── fixtures ──

// A grid of points ON a plane of the given attitude, centered at `origin`.
// Built by constructing an orthonormal basis in the plane, so the points are
// exact rather than approximately planar.
function planePatch(dipDirection, dip, { n = 9, span = 10, origin = [0, 0, 0], noise = 0 } = {}) {
  const nrm = normalOf(dipDirection, dip);
  // any two in-plane directions
  const seed = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(seed, nrm));
  const v = unit(cross(nrm, u));
  const pts = new Float64Array(n * n * 3);
  const nor = new Float64Array(n * n * 3);
  let k = 0;
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = (i / (n - 1) - 0.5) * span;
      const b = (j / (n - 1) - 0.5) * span;
      const off = noise ? noise * rand() : 0;
      pts[k] = origin[0] + a * u[0] + b * v[0] + off * nrm[0];
      pts[k + 1] = origin[1] + a * u[1] + b * v[1] + off * nrm[1];
      pts[k + 2] = origin[2] + a * u[2] + b * v[2] + off * nrm[2];
      nor[k] = nrm[0]; nor[k + 1] = nrm[1]; nor[k + 2] = nrm[2];
      k += 3;
    }
  }
  return { positions: pts, normals: nor, normal: nrm, count: n * n };
}

// a triangulated n×n grid in the z = 0 plane, spacing 1
function flatMesh(n) {
  const nv = (n + 1) * (n + 1);
  const positions = new Float64Array(nv * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3;
      positions[k] = i; positions[k + 1] = j; positions[k + 2] = 0;
    }
  }
  const triangles = new Uint32Array(n * n * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
      triangles[p++] = a; triangles[p++] = b; triangles[p++] = c;
      triangles[p++] = a; triangles[p++] = c; triangles[p++] = d;
    }
  }
  return { positions, triangles, adj: buildAdjacency(positions, triangles), n };
}

const unit = (v) => { const L = Math.hypot(...v); return [v[0] / L, v[1] / L, v[2] / L]; };
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];

// ── attitude: the conversion boundary ──

test('attitude: a plane built at a known attitude comes back at that attitude', () => {
  for (const dd of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
    for (const dip of [5, 20, 35, 60, 85]) {
      const a = attitude(normalOf(dd, dip));
      assert.ok(Math.abs(a.dip - dip) < 1e-9, `dip ${dip} -> ${a.dip}`);
      assert.ok(azDiff(a.dipDirection, dd) < 1e-9, `dd ${dd} -> ${a.dipDirection}`);
    }
  }
});

test('attitude: the sign of the normal cannot change the answer', () => {
  // this is the property that makes the whole package safe: whichever hemisphere
  // an eigenvector happens to come out in, the attitude is the same
  for (const [dd, dip] of [[120, 35], [300, 70], [0, 10], [200, 45]]) {
    const n = normalOf(dd, dip);
    const up = attitude(n);
    const down = attitude([-n[0], -n[1], -n[2]]);
    assert.deepEqual(up, down, `flipping the pole moved the attitude at ${dd}/${dip}`);
  }
});

test('attitude: the basis really is East/North/Up', () => {
  // a plane dipping 30° toward due East has its downward pole leaning WEST
  const p = normalOf(90, 30);
  assert.ok(p[0] < 0, 'pole leans west (−East)');
  assert.ok(Math.abs(p[1]) < 1e-12, 'no North component');
  assert.ok(p[2] < 0, 'and downward');
  // horizontal
  assert.equal(attitude([0, 0, -1]).dip, 0);
  // vertical plane striking N-S, dipping East
  const vert = attitude(normalOf(90, 90));
  assert.ok(Math.abs(vert.dip - 90) < 1e-9);
});

// ── the plane fit ──

test('fitPlane: recovers a synthetic plane at 35/120 exactly', () => {
  const { positions, normals, count } = planePatch(120, 35);
  const f = fitPlane(positions, null, { normals });
  assert.ok(Math.abs(f.dip - 35) < 1e-8, `dip ${f.dip}`);
  assert.ok(Math.abs(f.dipDirection - 120) < 1e-8, `dd ${f.dipDirection}`);
  assert.equal(f.n, count);
  assert.ok(f.eig[2] < 1e-18, 'a perfect plane has no perpendicular variance');
  assert.ok(f.rms < 1e-9, 'and zero RMS misfit');
  assert.equal(f.degenerate, null);
});

test('fitPlane: recovers attitude across the whole compass', () => {
  for (const dd of [0, 30, 90, 170, 200, 275, 340]) {
    for (const dip of [2, 15, 40, 65, 88]) {
      const { positions, normals } = planePatch(dd, dip);
      const f = fitPlane(positions, null, { normals });
      assert.ok(Math.abs(f.dip - dip) < 1e-7, `dip ${dip} -> ${f.dip} (dd ${dd})`);
      assert.ok(azDiff(f.dipDirection, dd) < 1e-6, `dd ${dd} -> ${f.dipDirection} (dip ${dip})`);
    }
  }
});

test('fitPlane: survives UTM-magnitude coordinates', () => {
  // the reason both passes work in shifted coordinates: at x ≈ 5e5 the raw
  // squares eat six significant digits before the subtraction happens
  const { positions, normals } = planePatch(120, 35, { origin: [456789.123, 6789012.345, 812.5] });
  const f = fitPlane(positions, null, { normals });
  assert.ok(Math.abs(f.dip - 35) < 1e-6, `dip drifted to ${f.dip}`);
  assert.ok(Math.abs(f.dipDirection - 120) < 1e-6, `dd drifted to ${f.dipDirection}`);
  assert.ok(Math.abs(f.centroid[0] - 456789.123) < 1e-6);
  assert.ok(Math.abs(f.centroid[1] - 6789012.345) < 1e-6);
});

test('fitPlane: it is a fit to POSITIONS, not an average of normals', () => {
  // mean-centering is what separates this from bearing's orientationTensor.
  // A patch far from the origin whose normals were all thrown away must still
  // fit correctly — the un-centered tensor would return the direction to the
  // centroid instead, which is the silent-wrongness case the spec warns about.
  const { positions } = planePatch(120, 35, { origin: [1000, 2000, 300] });
  const f = fitPlane(positions);                     // no normals at all
  assert.ok(Math.abs(f.dip - 35) < 1e-7, `dip ${f.dip}`);
  assert.ok(Math.abs(f.dipDirection - 120) < 1e-7, `dd ${f.dipDirection}`);
  // and the direction to the centroid is emphatically NOT the answer
  const toCentroid = unit([1000, 2000, 300]);
  assert.ok(Math.abs(f.normal[0] * toCentroid[0] + f.normal[1] * toCentroid[1]
    + f.normal[2] * toCentroid[2]) < 0.99, 'normal must not be the centroid direction');
});

test('fitPlane: eigenvalues describe the dispersion honestly', () => {
  const clean = fitPlane(planePatch(120, 35).positions);
  const rough = fitPlane(planePatch(120, 35, { noise: 0.5 }).positions);
  assert.ok(rough.eig[2] > clean.eig[2], 'a rough patch has more perpendicular variance');
  assert.ok(rough.eigRatio21 > clean.eigRatio21, 'and a worse quality ratio');
  assert.ok(rough.rms > 0.05 && rough.rms < 0.3, `rms ${rough.rms} tracks the noise`);
  // eig is descending, and e2 is the variance along the normal
  assert.ok(clean.eig[0] >= clean.eig[1] && clean.eig[1] >= clean.eig[2]);
  assert.ok(Math.abs(rough.rms - Math.sqrt(rough.eig[2])) < 1e-12);
});

test('fitPlane: radius is the reach of the patch', () => {
  const f = fitPlane(planePatch(120, 35, { span: 10 }).positions);
  // corners of a 10×10 patch sit at 5√2 from the center
  assert.ok(Math.abs(f.radius - Math.hypot(5, 5)) < 1e-9, `radius ${f.radius}`);
});

test('fitPlane: refuses to guess from fewer than three points', () => {
  const p = new Float64Array([0, 0, 0, 1, 0, 0]);
  assert.equal(fitPlane(p), null, 'two points do not determine a plane');
  assert.equal(fitPlane(new Float64Array(0)), null);
  assert.notEqual(fitPlane(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0])), null);
});

test('fitPlane: flags collinear points instead of inventing a plane', () => {
  const p = new Float64Array(30);
  for (let i = 0; i < 10; i++) { p[i * 3] = i; p[i * 3 + 1] = i * 2; p[i * 3 + 2] = i * 3; }
  const f = fitPlane(p);
  assert.equal(f.degenerate, 'collinear');
});

test('fitPlane: orients toward the surface normals when they are given', () => {
  const { positions, normals, normal } = planePatch(120, 35);
  const f = fitPlane(positions, null, { normals });
  const agree = f.normal[0] * normal[0] + f.normal[1] * normal[1] + f.normal[2] * normal[2];
  assert.ok(agree > 0.999, 'fitted normal agrees with the mesh normals');
  // flip every mesh normal and the fitted vector must follow — while the
  // attitude, which is what gets recorded, must not move at all
  const flipped = normals.map((x) => -x);
  const g = fitPlane(positions, null, { normals: flipped });
  assert.ok(g.normal[0] * f.normal[0] + g.normal[1] * f.normal[1]
    + g.normal[2] * f.normal[2] < -0.999, 'vector follows the normals');
  assert.ok(Math.abs(g.dip - f.dip) < 1e-12 && Math.abs(g.dipDirection - f.dipDirection) < 1e-12,
    'attitude is invariant');
});

test('fitPlane: without normals the pole points down, by convention', () => {
  const f = fitPlane(planePatch(120, 35).positions);
  assert.ok(f.normal[2] <= 0, 'lower hemisphere');
});

test('fitPlane: finishes the Fisher statistics CAPIVARAS left half-done', () => {
  const { positions, normals } = planePatch(120, 35);
  const f = fitPlane(positions, null, { normals });
  assert.ok(f.fisher, 'fisher stats present when normals are given');
  assert.ok(Math.abs(f.fisher.Rbar - 1) < 1e-9, 'identical normals give R̄ = 1');
  assert.ok(!Number.isFinite(f.fisher.kappa) || f.fisher.kappa > 1e6, 'and infinite concentration');
  assert.equal(fitPlane(positions).fisher, undefined, 'absent without normals');
});

test('fitPlane: indices select a subset without copying the mesh', () => {
  const a = planePatch(120, 35, { n: 9 });
  const b = planePatch(300, 70, { n: 9, origin: [100, 100, 100] });
  const merged = new Float64Array(a.positions.length + b.positions.length);
  merged.set(a.positions);
  merged.set(b.positions, a.positions.length);
  const idxB = Uint32Array.from({ length: b.count }, (_, i) => a.count + i);
  const f = fitPlane(merged, idxB);
  assert.ok(Math.abs(f.dip - 70) < 1e-7, `dip ${f.dip}`);
  assert.ok(Math.abs(f.dipDirection - 300) < 1e-6, `dd ${f.dipDirection}`);
  assert.equal(f.n, b.count);
});

test('fitTensor: the tensor is symmetric and its trace is the total variance', () => {
  const { positions } = planePatch(120, 35);
  const { tensor, centroid, n } = fitTensor(positions);
  assert.equal(n, 81);
  assert.ok(Math.abs(tensor[1] - tensor[3]) < 1e-15);
  assert.ok(Math.abs(tensor[2] - tensor[6]) < 1e-15);
  assert.ok(Math.abs(tensor[5] - tensor[7]) < 1e-15);
  for (const c of centroid) assert.ok(Math.abs(c) < 1e-12, 'patch is centered on the origin');
});

// ── the brush ──

test('brush: paints within the cylinder and stops outside it', () => {
  const m = flatMesh(20);
  const seed = 10 * 21 + 10;                          // vertex at (10, 10)
  const ray = { origin: [10, 10, 5], direction: [0, 0, -1] };
  const painted = brush(seed, ray, 3.5, m.adj, m.positions);
  assert.ok(painted.length > 20, `painted ${painted.length}`);
  for (const v of painted) {
    const d = Math.hypot(m.positions[v * 3] - 10, m.positions[v * 3 + 1] - 10);
    assert.ok(d <= 3.5 + 1e-9, `vertex at distance ${d} escaped the cylinder`);
  }
  // and everything inside that is reachable did get painted
  const inside = [...Array(m.adj.vertexCount).keys()].filter((v) =>
    Math.hypot(m.positions[v * 3] - 10, m.positions[v * 3 + 1] - 10) <= 3.5);
  assert.equal(painted.length, inside.length, 'no interior vertex was missed');
});

test('brush: connectivity, not proximity — paint does not jump a gap', () => {
  // two disjoint strips 0.5 apart: a radius query would take both, a surface
  // walk takes only the one the user touched
  const left = flatMesh(4);
  const nvL = left.adj.vertexCount;
  const positions = new Float64Array(nvL * 3 * 2);
  positions.set(left.positions);
  for (let v = 0; v < nvL; v++) {                     // right strip, offset in x
    positions[(nvL + v) * 3] = left.positions[v * 3] + 4.5;
    positions[(nvL + v) * 3 + 1] = left.positions[v * 3 + 1];
    positions[(nvL + v) * 3 + 2] = 0;
  }
  const tri = new Uint32Array(left.triangles.length * 2);
  tri.set(left.triangles);
  for (let i = 0; i < left.triangles.length; i++) tri[left.triangles.length + i] = left.triangles[i] + nvL;
  const adj = buildAdjacency(positions, tri);

  const ray = { origin: [4, 2, 5], direction: [0, 0, -1] };
  const painted = brush(0, ray, 100, adj, positions);   // radius covers BOTH strips
  assert.ok(painted.length > 0);
  for (const v of painted) assert.ok(v < nvL, `vertex ${v} leaked onto the far strip`);
  assert.equal(painted.length, nvL, 'the whole near strip, and only it');
});

test('brush: always returns the seed, even outside the cylinder', () => {
  const m = flatMesh(4);
  const ray = { origin: [100, 100, 5], direction: [0, 0, -1] };
  const painted = brush(0, ray, 0.1, m.adj, m.positions);
  assert.deepEqual([...painted], [0]);
});

test('brush: an exclude mask keeps sets from overlapping', () => {
  const m = flatMesh(20);
  const seed = 10 * 21 + 10;
  const ray = { origin: [10, 10, 5], direction: [0, 0, -1] };
  const first = brush(seed, ray, 2, m.adj, m.positions);
  const exclude = new Uint8Array(m.adj.vertexCount);
  for (const v of first) exclude[v] = 1;
  const second = brush(seed, ray, 4, m.adj, m.positions, { exclude });
  // the seed is always returned, but nothing else already-painted comes back
  assert.deepEqual([...second], [seed], 'walled in by the previous set');
});

test('brush: results are sorted and deterministic', () => {
  const m = flatMesh(12);
  const ray = { origin: [6, 6, 5], direction: [0, 0, -1] };
  const a = brush(6 * 13 + 6, ray, 3, m.adj, m.positions);
  const b = brush(6 * 13 + 6, ray, 3, m.adj, m.positions);
  assert.deepEqual([...a], [...b]);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], 'ascending, no duplicates');
});

test('brush: an oblique ray still measures perpendicular distance to the line', () => {
  const m = flatMesh(20);
  const dir = unit([1, 0, -1]);
  const ray = { origin: [10 - 5 * dir[0], 10, 5], direction: dir };
  const painted = brush(10 * 21 + 10, ray, 2, m.adj, m.positions);
  for (const v of painted) {
    const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
    assert.ok(distanceToRay(p, ray) <= 2 + 1e-9);
  }
  assert.ok(painted.length > 5);
});

test('brush: the limit is opt-in, not a hidden ceiling', () => {
  const m = flatMesh(20);
  const ray = { origin: [10, 10, 5], direction: [0, 0, -1] };
  const all = brush(10 * 21 + 10, ray, 100, m.adj, m.positions);
  assert.equal(all.length, m.adj.vertexCount, 'no cap by default');
  assert.equal(brush(10 * 21 + 10, ray, 100, m.adj, m.positions, { limit: 7 }).length, 7);
});

// ── geodesics ──

test('geodesic: a path along a flat grid has the length the geometry predicts', () => {
  const m = flatMesh(10);
  const a = 0;                                        // (0, 0)
  const b = 10 * 11 + 10;                             // (10, 10)
  const g = geodesic(a, b, m.adj, m.positions);
  assert.ok(g, 'reachable');
  assert.equal(g.path[0], a);
  assert.equal(g.path[g.path.length - 1], b);
  // the diagonal of this triangulation is an edge, so the shortest route is the
  // straight diagonal: 10 steps of √2
  assert.ok(Math.abs(g.length - 10 * Math.SQRT2) < 1e-9, `length ${g.length}`);
  assert.equal(g.path.length, 11);
});

test('geodesic: consecutive path vertices are genuinely adjacent', () => {
  const m = flatMesh(10);
  const g = geodesic(3, 10 * 11 + 7, m.adj, m.positions);
  for (let i = 1; i < g.path.length; i++) {
    const row = m.adj.vvNeighbors.subarray(
      m.adj.vvOffsets[g.path[i - 1]], m.adj.vvOffsets[g.path[i - 1] + 1]);
    assert.ok([...row].includes(g.path[i]), `${g.path[i - 1]} and ${g.path[i]} are not neighbors`);
  }
});

test('geodesic: measures ALONG the surface, not through the air', () => {
  // a tent: two 45° ramps meeting at a ridge. Straight-line distance across the
  // base is 4; over the surface it is 4√2.
  const positions = new Float64Array([
    0, 0, 0, 0, 1, 0,     // x = 0
    2, 0, 2, 2, 1, 2,     // ridge at x = 2, z = 2
    4, 0, 0, 4, 1, 0,     // x = 4
  ]);
  const triangles = new Uint32Array([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4]);
  const adj = buildAdjacency(positions, triangles);
  const g = geodesic(0, 4, adj, positions);
  assert.ok(Math.abs(g.length - 4 * Math.SQRT2) < 1e-9, `over the ridge: ${g.length}`);
  assert.ok(g.length > 4, 'longer than the straight line through the tent');
});

test('geodesic: unreachable is null, not an exception or a wrong number', () => {
  const m = flatMesh(3);
  const nv = m.adj.vertexCount;
  const positions = new Float64Array(nv * 3 + 3);
  positions.set(m.positions);
  positions[nv * 3] = 99;                             // an isolated vertex
  const adj = buildAdjacency(positions, m.triangles, { vertexCount: nv + 1 });
  assert.equal(geodesic(0, nv, adj, positions), null);
  assert.deepEqual([...geodesic(5, 5, adj, positions).path], [5]);
});

test('geodesicField: distances are exact on a regular grid', () => {
  const m = flatMesh(8);
  const { dist } = geodesicField(0, m.adj, m.positions);
  // (i, j): the diagonal edge covers min(i,j) steps of √2, the rest are axial
  for (const [i, j] of [[3, 0], [0, 5], [4, 4], [6, 2], [8, 8]]) {
    const d = min2(i, j) * Math.SQRT2 + Math.abs(i - j);
    assert.ok(Math.abs(dist[j * 9 + i] - d) < 1e-9, `(${i},${j}) = ${dist[j * 9 + i]}, want ${d}`);
  }
});

test('geodesicBall: grows a disc measured over the surface', () => {
  const m = flatMesh(20);
  const seed = 10 * 21 + 10;
  const ball = geodesicBall(seed, 3, m.adj, m.positions);
  assert.ok(ball.length > 10);
  const { dist } = geodesicField(seed, m.adj, m.positions);
  for (const v of ball) assert.ok(dist[v] <= 3 + 1e-9);
  // straight-line distance is a lower bound on surface distance, so the ball is
  // contained in the euclidean disc of the same radius
  for (const v of ball) {
    assert.ok(Math.hypot(m.positions[v * 3] - 10, m.positions[v * 3 + 1] - 10) <= 3 + 1e-9);
  }
});

test('geodesic: a mask confines the walk to a painted set', () => {
  const m = flatMesh(10);
  const mask = new Uint8Array(m.adj.vertexCount);
  for (let v = 0; v < m.adj.vertexCount; v++) if (m.positions[v * 3 + 1] < 0.5) mask[v] = 1;
  const g = geodesic(0, 10, m.adj, m.positions, { mask });   // along the y = 0 row
  assert.ok(g);
  assert.ok(Math.abs(g.length - 10) < 1e-9, 'forced along the row');
  assert.equal(geodesic(0, 5 * 11, m.adj, m.positions, { mask }), null, 'cannot leave the mask');
});

// ── network topology ──

test('nodeClasses: I, Y and X are what the degrees say they are', () => {
  //   free end (I) ── a chain of degree-2 points ── free end (I)
  const line = nodeClasses([[0, 1, 2, 3]]);
  assert.equal(line.counts.I, 2);
  assert.equal(line.counts.Y, 0);
  assert.equal(line.counts.X, 0);
  assert.equal(line.nodes.length, 2, 'interior points are not nodes');
  assert.deepEqual(line.nodes.map((n) => n.vertex), [0, 3]);

  // a T: one trace abutting the middle of another → a Y
  const tee = nodeClasses([[0, 1, 2], [10, 1]]);
  assert.equal(tee.counts.Y, 1);
  assert.equal(tee.counts.I, 3);
  assert.equal(tee.nodes.find((n) => n.vertex === 1).kind, 'Y');

  // a cross: two traces sharing an interior vertex → an X
  const cross_ = nodeClasses([[0, 1, 2], [10, 1, 12]]);
  assert.equal(cross_.counts.X, 1);
  assert.equal(cross_.counts.I, 4);
  assert.equal(cross_.nodes.find((n) => n.vertex === 1).kind, 'X');
});

test('nodeClasses: derives the Sanderson & Nixon connectivity numbers', () => {
  const x = nodeClasses([[0, 1, 2], [10, 1, 12]]);
  // N_I = 4, N_Y = 0, N_X = 1  →  N_B = (4 + 0 + 4)/2 = 4, N_L = (4 + 0)/2 = 2
  assert.equal(x.branches, 4);
  assert.equal(x.lines, 2);
  assert.equal(x.connectivityPerBranch, 1);           // (0 + 4)/4
  assert.equal(x.connectivityPerLine, 1);             // 2(0 + 1)/2
  // an isolated trace connects to nothing
  const iso = nodeClasses([[0, 1, 2]]);
  assert.equal(iso.connectivityPerBranch, 0);
  assert.equal(iso.branches, 1);
});

test('nodeClasses: retracing the same segment does not invent nodes', () => {
  const once = nodeClasses([[0, 1, 2, 3]]);
  const twice = nodeClasses([[0, 1, 2, 3], [1, 2]]);
  assert.deepEqual(twice.counts, once.counts, 'a duplicate segment changes nothing');
  const stutter = nodeClasses([[0, 1, 1, 2, 3]]);
  assert.deepEqual(stutter.counts, once.counts, 'a repeated click changes nothing');
});

test('nodeClasses: high degrees are reported, not folded into X', () => {
  const star = nodeClasses([[0, 5], [1, 5], [2, 5], [3, 5], [4, 5]]);
  assert.equal(star.counts.other, 1);
  assert.equal(star.counts.X, 0);
  assert.equal(star.nodes.find((n) => n.vertex === 5).degree, 5);
});

test('nodeClasses: a lone pinned point is a free end', () => {
  const r = nodeClasses([[7]]);
  assert.equal(r.counts.I, 1);
  assert.equal(r.nodes[0].vertex, 7);
});

// ── painted sets ──

test('detectSets: picks saturated paint out of photographic color', () => {
  // 3 red, 2 green, and 4 vertices of plausible outcrop brown
  const colors = new Float32Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0,
    0, 1, 0, 0, 1, 0,
    0.55, 0.42, 0.31, 0.61, 0.48, 0.35, 0.49, 0.38, 0.27, 0.72, 0.6, 0.44,
  ]);
  const sets = detectSets(colors);
  assert.equal(sets.length, 2);
  const red = sets.find((s) => s.key === '100');
  const green = sets.find((s) => s.key === '010');
  assert.deepEqual([...red.vertices], [0, 1, 2]);
  assert.deepEqual([...green.vertices], [3, 4]);
  assert.deepEqual(red.color, [1, 0, 0]);
});

test('detectSets: reads 8-bit colors as readily as floats', () => {
  const bytes = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 140, 107, 79]);
  const sets = detectSets(bytes);
  assert.equal(sets.length, 2);
  assert.deepEqual([...sets.find((s) => s.key === '100').vertices], [0, 1]);
  assert.deepEqual([...sets.find((s) => s.key === '001').vertices], [2]);
});

test('detectSets: black and white are unpainted', () => {
  const colors = new Float32Array([0, 0, 0, 1, 1, 1, 1, 1, 0]);
  const sets = detectSets(colors);
  assert.equal(sets.length, 1, 'only the yellow counts');
  assert.equal(sets[0].key, '110');
  assert.equal(detectSets(colors, { includeWhite: true }).length, 2);
});

test('detectSets: ordering is stable across runs', () => {
  const colors = new Float32Array([0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0]);
  const keys = detectSets(colors).map((s) => s.key);
  assert.deepEqual(keys, ['001', '010', '100'], 'sorted by key, not by first appearance');
});

// ── the whole path, end to end ──

test('end to end: paint two patches, split them, and measure both', () => {
  // one mesh, two differently-oriented faces, joined at a ridge — the shape of a
  // real outcrop measurement. Paint across both, split by connectivity within
  // each painted set, and each component should recover its own attitude.
  const A = planePatch(90, 30, { n: 7, span: 6, origin: [0, 0, 0] });
  const B = planePatch(270, 60, { n: 7, span: 6, origin: [50, 0, 0] });
  const positions = new Float64Array(A.positions.length + B.positions.length);
  positions.set(A.positions);
  positions.set(B.positions, A.positions.length);

  // triangulate each 7×7 patch independently → two disconnected shells
  const tris = [];
  for (const base of [0, A.count]) {
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 6; i++) {
        const a = base + j * 7 + i, b = a + 1, c = a + 8, d = a + 7;
        tris.push(a, b, c, a, c, d);
      }
    }
  }
  const adj = buildAdjacency(positions, Uint32Array.from(tris));

  const all = [...Array(adj.vertexCount).keys()];
  const { labels, count } = components(adj, all);
  assert.equal(count, 2, 'two disconnected faces');

  const measured = [];
  for (let c = 0; c < count; c++) {
    const idx = Uint32Array.from(all.filter((v) => labels[v] === c));
    measured.push(fitPlane(positions, idx));
  }
  measured.sort((a, b) => a.dip - b.dip);
  assert.ok(Math.abs(measured[0].dip - 30) < 1e-6, `face A dip ${measured[0].dip}`);
  assert.ok(Math.abs(measured[0].dipDirection - 90) < 1e-5, `face A dd ${measured[0].dipDirection}`);
  assert.ok(Math.abs(measured[1].dip - 60) < 1e-6, `face B dip ${measured[1].dip}`);
  assert.ok(Math.abs(measured[1].dipDirection - 270) < 1e-5, `face B dd ${measured[1].dipDirection}`);
});

test('performance: brushing and fitting a 100k-vertex mesh stays interactive', () => {
  const m = flatMesh(316);                            // ~100k vertices
  const t0 = performance.now();
  const ray = { origin: [158, 158, 5], direction: [0, 0, -1] };
  const painted = brush(158 * 317 + 158, ray, 40, m.adj, m.positions);
  const f = fitPlane(m.positions, painted);
  const ms = performance.now() - t0;
  assert.ok(painted.length > 4000, `painted ${painted.length}`);
  assert.ok(Math.abs(f.dip) < 1e-9, 'a flat mesh is flat');
  assert.ok(ms < 1000, `brush + fit took ${ms.toFixed(0)} ms`);
});

function min2(a, b) { return a < b ? a : b; }

// smallest angle between two azimuths, in degrees — 359° and 1° are 2° apart
function azDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
