// @gcu/groma — BVH + CSR mesh topology.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBVH, raycastBVH, buildAdjacency, neighbors, incidentFaces, degree, components,
} from '../ext/groma/src/main.js';

// a unit quad in the z=0 plane, split into two triangles sharing the 1-2 edge
//   3---2
//   | \ |
//   0---1
const QUAD_V = new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_T = new Uint32Array([0, 1, 2, 0, 2, 3]);

// an N×N grid of quads → a regular triangulated plane
function grid(n) {
  const nv = (n + 1) * (n + 1);
  const v = new Float64Array(nv * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3;
      v[k] = i; v[k + 1] = j; v[k + 2] = 0;
    }
  }
  const t = new Uint32Array(n * n * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
      t[p++] = a; t[p++] = b; t[p++] = c;
      t[p++] = a; t[p++] = c; t[p++] = d;
    }
  }
  return { vertices: v, triangles: t, n };
}

test('adjacency: vertex→face is exact, and every face lists its three corners', () => {
  const a = buildAdjacency(QUAD_V, QUAD_T);
  assert.equal(a.vertexCount, 4);
  assert.equal(a.faceCount, 2);
  assert.equal(a.vfFaces.length, 6);                       // 2 faces × 3 corners
  assert.deepEqual([...incidentFaces(a, 0)], [0, 1]);      // the split corner
  assert.deepEqual([...incidentFaces(a, 1)], [0]);
  assert.deepEqual([...incidentFaces(a, 2)], [0, 1]);
  assert.deepEqual([...incidentFaces(a, 3)], [1]);
});

test('adjacency: vertex→vertex deduplicates the shared edge', () => {
  const a = buildAdjacency(QUAD_V, QUAD_T);
  // vertex 0 touches both triangles; 2 is a corner of each, and must appear ONCE
  const n0 = [...neighbors(a, 0)].sort((x, y) => x - y);
  assert.deepEqual(n0, [1, 2, 3]);
  assert.equal(degree(a, 0), 3);
  const n2 = [...neighbors(a, 2)].sort((x, y) => x - y);
  assert.deepEqual(n2, [0, 1, 3]);
});

test('adjacency: offsets are EXACT — no padding, no sentinel', () => {
  const a = buildAdjacency(QUAD_V, QUAD_T);
  assert.equal(a.vvOffsets[0], 0);
  assert.equal(a.vvOffsets[a.vertexCount], a.vvNeighbors.length);
  for (let v = 0; v < a.vertexCount; v++) {
    assert.ok(a.vvOffsets[v] <= a.vvOffsets[v + 1], 'offsets monotonic');
    // a raw 0 in the array is a real vertex index, not an empty slot
    for (const w of neighbors(a, v)) assert.ok(w >= 0 && w < a.vertexCount);
  }
  assert.ok([...a.vvNeighbors].includes(0), 'vertex 0 appears unbiased');
});

test('adjacency: the graph is symmetric (v→w implies w→v)', () => {
  const g = grid(8);
  const a = buildAdjacency(g.vertices, g.triangles);
  for (let v = 0; v < a.vertexCount; v++) {
    for (const w of neighbors(a, v)) {
      assert.ok([...neighbors(a, w)].includes(v), `asymmetric ${v}→${w}`);
    }
  }
});

test('adjacency: a regular grid has the degrees the topology predicts', () => {
  const n = 6;
  const g = grid(n);
  const a = buildAdjacency(g.vertices, g.triangles);
  // this diagonal split gives interior vertices 6 neighbors; corners 2 or 3
  const interior = (n + 1) * 1 + 1;                        // (1,1)
  assert.equal(degree(a, interior), 6);
  assert.equal(degree(a, 0), 3);                           // the split corner
  assert.equal(degree(a, n), 2);                           // the off-diagonal corner
  assert.equal(a.faceCount, n * n * 2);
  assert.equal(a.vfFaces.length, n * n * 6);
});

test('adjacency: degenerate input is tolerated, not fatal', () => {
  // a triangle with a repeated corner, and one pointing off the end
  const t = new Uint32Array([0, 1, 2, 0, 0, 1, 0, 1, 99]);
  const a = buildAdjacency(QUAD_V, t);
  assert.equal(a.skipped, 1, 'the out-of-range face is skipped');
  assert.ok(!([...neighbors(a, 0)].includes(0)), 'no self-loop from the repeated corner');
  for (let v = 0; v < a.vertexCount; v++) {
    const row = [...neighbors(a, v)];
    assert.equal(new Set(row).size, row.length, `duplicates in row ${v}`);
  }
});

test('components: one painted patch per plane, deterministic ids', () => {
  // two grids side by side in one mesh → a subset spanning both must split in 2
  const g = grid(4);
  const a = buildAdjacency(g.vertices, g.triangles);
  const left = [0, 1, 5, 6];                               // a 2×2 block of vertices
  const right = [3, 4, 8, 9];                              // disjoint from `left`
  const { labels, count } = components(a, [...left, ...right]);
  assert.equal(count, 2);
  assert.equal(new Set(left.map((v) => labels[v])).size, 1, 'left is one component');
  assert.equal(new Set(right.map((v) => labels[v])).size, 1, 'right is one component');
  assert.notEqual(labels[left[0]], labels[right[0]]);
  assert.equal(labels[2], -1, 'vertices outside the subset are unlabeled');
  // ids ascend with vertex order, so a rerun cannot relabel
  assert.equal(labels[0], 0);
});

test('components: a fully connected subset is one component', () => {
  const g = grid(5);
  const a = buildAdjacency(g.vertices, g.triangles);
  const all = [...Array(a.vertexCount).keys()];
  assert.equal(components(a, all).count, 1);
});

test('BVH + raycast still work after the move to groma', () => {
  const bvh = buildBVH(QUAD_V, QUAD_T);
  const mesh = { vertices: QUAD_V, triangles: QUAD_T, nodes: bvh.nodes, triIndices: bvh.triIndices };
  // NB pick points OFF the shared diagonal (y = x): a ray down the seam may
  // legitimately return either triangle, which says nothing about correctness
  const lower = raycastBVH(mesh, [0.6, 0.25, 5], [0, 0, -1]);   // below y = x → tri 0
  const upper = raycastBVH(mesh, [0.25, 0.6, 5], [0, 0, -1]);   // above y = x → tri 1
  assert.ok(lower && upper, 'ray hits the quad on both halves');
  assert.equal(lower.tri, 0);
  assert.equal(upper.tri, 1);
  const hit = lower;
  assert.ok(Math.abs(hit.t - 5) < 1e-9);
  assert.ok(Math.abs(hit.point[2]) < 1e-9);
  assert.ok(Math.abs(Math.abs(hit.normal[2]) - 1) < 1e-9, 'plane normal is ±z');
  assert.equal(raycastBVH(mesh, [5, 5, 5], [0, 0, -1]), null, 'a miss is null');
});

test('raycast is two-sided and flips the normal toward the ray', () => {
  const bvh = buildBVH(QUAD_V, QUAD_T);
  const mesh = { vertices: QUAD_V, triangles: QUAD_T, nodes: bvh.nodes, triIndices: bvh.triIndices };
  const above = raycastBVH(mesh, [0.6, 0.25, 5], [0, 0, -1]);
  const below = raycastBVH(mesh, [0.6, 0.25, -5], [0, 0, 1]);
  assert.ok(above && below, 'hit from both sides');
  assert.ok(above.normal[2] > 0, 'normal faces the ray from above');
  assert.ok(below.normal[2] < 0, 'and from below');
});

test('adjacency scales linearly enough to be usable on a real mesh', () => {
  const g = grid(220);                                     // ~48k verts, ~96k tris
  const t0 = performance.now();
  const a = buildAdjacency(g.vertices, g.triangles);
  const ms = performance.now() - t0;
  assert.equal(a.vertexCount, 221 * 221);
  assert.ok(ms < 2000, `adjacency took ${ms.toFixed(0)} ms`);
  // and the CSR is internally consistent at scale
  assert.equal(a.vvOffsets[a.vertexCount], a.vvNeighbors.length);
  assert.equal(a.vfOffsets[a.vertexCount], a.vfFaces.length);
});
