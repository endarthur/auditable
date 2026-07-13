// @gcu/winding — raycastBVH: the CPU half of mesh picking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBVH, raycastBVH } from '../ext/winding/index.js';

// a unit cube centred on the origin, 12 triangles, outward-wound
function cube(s = 1) {
  const h = s / 2;
  const vertices = new Float32Array([
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,           // 0..3 bottom
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,               // 4..7 top
  ]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2,       // −Z
    4, 5, 6, 4, 6, 7,       // +Z
    0, 1, 5, 0, 5, 4,       // −Y
    3, 7, 6, 3, 6, 2,       // +Y
    0, 4, 7, 0, 7, 3,       // −X
    1, 2, 6, 1, 6, 5,       // +X
  ]);
  return { vertices, triangles };
}
const mesh = (m) => ({ ...m, ...buildBVH(m.vertices, m.triangles) });

// The independent oracle: Möller–Trumbore against EVERY triangle, no BVH at all.
// (Feeding a doctored triIndices back into raycastBVH is not a brute force — the
// leaf offsets index the original array. It has to be its own implementation.)
function bruteNearest({ vertices, triangles }, [ox, oy, oz], [dx, dy, dz]) {
  const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
  let best = Infinity;
  for (let t = 0; t < triangles.length / 3; t++) {
    const a = triangles[t * 3] * 3, b = triangles[t * 3 + 1] * 3, c = triangles[t * 3 + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const e1 = [vertices[b] - ax, vertices[b + 1] - ay, vertices[b + 2] - az];
    const e2 = [vertices[c] - ax, vertices[c + 1] - ay, vertices[c + 2] - az];
    const p = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv = [ox - ax, oy - ay, oz - az];
    const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (dx * q[0] + dy * q[1] + dz * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (tt > 1e-7 && tt < best) best = tt;
  }
  return best;
}

test('a ray from above hits the top face at z = +h', () => {
  const m = mesh(cube(2));                                 // h = 1
  const hit = raycastBVH(m, [0.2, -0.1, 10], [0, 0, -1]);
  assert.ok(hit, 'the ray must hit');
  assert.ok(Math.abs(hit.point[2] - 1) < 1e-5, `z=${hit.point[2]}`);
  assert.ok(Math.abs(hit.t - 9) < 1e-5, `t=${hit.t} (distance, not a parametric scale)`);
  assert.deepEqual(hit.normal.map(Math.round), [0, 0, 1], 'normal faces the ray');
});

test('the NEAREST surface wins — not the far side of the same solid', () => {
  const m = mesh(cube(2));
  const hit = raycastBVH(m, [0, 0, 5], [0, 0, -1]);
  assert.ok(Math.abs(hit.point[2] - 1) < 1e-5, 'the top, not the bottom');
  const back = raycastBVH(m, [0, 0, -5], [0, 0, 1]);
  assert.ok(Math.abs(back.point[2] + 1) < 1e-5, 'from below: the bottom');
  assert.deepEqual(back.normal.map(Math.round), [0, 0, -1], 'the normal flips to face the ray');
});

test('two-sided: a ray from INSIDE the solid still hits', () => {
  const m = mesh(cube(2));
  const hit = raycastBVH(m, [0, 0, 0], [0, 0, 1]);
  assert.ok(hit, 'inconsistently-wound geological wireframes must still pick');
  assert.ok(Math.abs(hit.point[2] - 1) < 1e-5);
});

test('a miss returns null (no phantom hit behind the ray)', () => {
  const m = mesh(cube(2));
  assert.equal(raycastBVH(m, [5, 5, 5], [1, 1, 1]), null, 'aimed away');
  assert.equal(raycastBVH(m, [0, 0, 10], [0, 0, 1]), null, 'aimed away from the cube behind it');
  assert.equal(raycastBVH(m, [10, 0, 0], [0, 1, 0]), null, 'parallel, missing');
});

test('maxT bounds the search', () => {
  const m = mesh(cube(2));
  assert.equal(raycastBVH(m, [0, 0, 10], [0, 0, -1], { maxT: 5 }), null, 'the cube is 9 away');
  assert.ok(raycastBVH(m, [0, 0, 10], [0, 0, -1], { maxT: 20 }), 'within reach');
});

test('the triangle index is real and its vertices bracket the hit', () => {
  const m = mesh(cube(2));
  const hit = raycastBVH(m, [0.3, 0.2, 10], [0, 0, -1]);
  assert.ok(hit.tri >= 0 && hit.tri < m.triangles.length / 3, `tri ${hit.tri} in range`);
  assert.equal(hit.verts.length, 3);
  for (const v of hit.verts) assert.ok(Math.abs(m.vertices[v * 3 + 2] - 1) < 1e-6, 'all three corners on the top face');
  const bsum = hit.bary.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(bsum - 1) < 1e-5, `barycentric sums to 1 (${bsum})`);
});

test('an unnormalised direction gives the same hit (t stays a distance)', () => {
  const m = mesh(cube(2));
  const a = raycastBVH(m, [0, 0, 10], [0, 0, -1]);
  const b = raycastBVH(m, [0, 0, 10], [0, 0, -37]);
  assert.equal(a.tri, b.tri);
  assert.ok(Math.abs(a.t - b.t) < 1e-5, `${a.t} vs ${b.t}`);
});

test('an empty mesh raycasts to null, it does not throw', () => {
  assert.equal(raycastBVH({ vertices: new Float32Array(0), triangles: new Uint32Array(0), nodes: new Float32Array(0), triIndices: new Uint32Array(0) }, [0, 0, 0], [0, 0, 1]), null);
});

test('a big fan: the BVH agrees with brute force on 200 random rays', () => {
  // a lumpy heightfield — the shape micro actually picks (topography, pit shells)
  const N = 24, verts = [], tris = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++)
    verts.push(i, j, Math.sin(i * 0.7) * Math.cos(j * 0.5) * 2);
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i;
    tris.push(a, a + N, a + N + 1, a, a + N + 1, a + 1);
  }
  const m = mesh({ vertices: new Float32Array(verts), triangles: new Uint32Array(tris) });
  const brute = { vertices: m.vertices, triangles: m.triangles, nodes: null, triIndices: null };
  let checked = 0;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 200; k++) {
    const o = [rnd() * N, rnd() * N, 20];
    const hit = raycastBVH(m, o, [0, 0, -1]);
    if (!hit) continue;
    checked++;
    const bt = bruteNearest(m, o, [0, 0, -1]);             // every triangle, no BVH, nearest wins
    assert.ok(Math.abs(hit.t - bt) < 1e-4, `ray ${k}: bvh ${hit.t} vs brute ${bt}`);
  }
  assert.ok(checked > 150, `${checked}/200 rays hit the sheet`);
});
