// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/groma — Robust geometry base: BVH build and ray queries, CSR mesh topology (vertex-vertex and vertex-face adjacency), connected components. Zero dependencies, typed arrays throughout.

// ── src/bvh.js ──

// BVH (Bounding Volume Hierarchy) construction for triangle meshes
// Flat array layout for GPU-friendly traversal

// (superseded — see the 16-float layout above)
// [min_x, min_y, min_z, max_x, max_y, max_z, left_or_first, count_or_right]
// Leaf: count > 0, first = index into reordered tri_indices
// Internal: count = 0, left/right = child node indices

const NODE_SIZE = 16;
// Node layout (16 floats):
//   [0..5]  min/max bounds
//   [6..7]  data1/data2 (leaf: first/count; internal: left/-(right)-1)
//   [8..10] area-weighted centroid of the subtree's triangles
//   [11..13] vector area (Σ ½·e1×e2 — the far-field dipole strength)
//   [14]    conservative subtree radius (centroid → farthest bbox corner)
//   [15]    pad

function triCentroid(vertices, triangles, triIdx, axis) {
  const i0 = triangles[triIdx * 3] * 3 + axis;
  const i1 = triangles[triIdx * 3 + 1] * 3 + axis;
  const i2 = triangles[triIdx * 3 + 2] * 3 + axis;
  return (vertices[i0] + vertices[i1] + vertices[i2]) / 3;
}

function triBounds(vertices, triangles, triIdx) {
  const a = triangles[triIdx * 3], b = triangles[triIdx * 3 + 1], c = triangles[triIdx * 3 + 2];
  const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
  const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
  const cx = vertices[c * 3], cy = vertices[c * 3 + 1], cz = vertices[c * 3 + 2];
  return [
    Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz),
    Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz),
  ];
}

function triArea2(vertices, triangles, triIdx) {
  // Returns 2x the squared area (avoids sqrt)
  const a = triangles[triIdx * 3], b = triangles[triIdx * 3 + 1], c = triangles[triIdx * 3 + 2];
  const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
  const bx = vertices[b * 3] - ax, by = vertices[b * 3 + 1] - ay, bz = vertices[b * 3 + 2] - az;
  const cx = vertices[c * 3] - ax, cy = vertices[c * 3 + 1] - ay, cz = vertices[c * 3 + 2] - az;
  // cross product magnitude squared
  const nx = by * cz - bz * cy;
  const ny = bz * cx - bx * cz;
  const nz = bx * cy - by * cx;
  return nx * nx + ny * ny + nz * nz;
}

function buildBVH(vertices, triangles, { maxLeafSize = 4, degenerateEpsilon = 1e-6 } = {}) {
  const nTris = triangles.length / 3;
  if (nTris === 0) return { nodes: new Float32Array(0), triIndices: new Uint32Array(0), degenerateCount: 0 };

  // Compute mesh bounding box diagonal for degenerate threshold
  let mx0 = Infinity, my0 = Infinity, mz0 = Infinity;
  let mx1 = -Infinity, my1 = -Infinity, mz1 = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    mx0 = Math.min(mx0, vertices[i]); my0 = Math.min(my0, vertices[i + 1]); mz0 = Math.min(mz0, vertices[i + 2]);
    mx1 = Math.max(mx1, vertices[i]); my1 = Math.max(my1, vertices[i + 1]); mz1 = Math.max(mz1, vertices[i + 2]);
  }
  const diag = Math.sqrt((mx1 - mx0) ** 2 + (my1 - my0) ** 2 + (mz1 - mz0) ** 2);
  const areaThresh = (degenerateEpsilon * diag) ** 2;

  // Filter out degenerate triangles
  const validIndices = [];
  let degenerateCount = 0;
  for (let i = 0; i < nTris; i++) {
    if (triArea2(vertices, triangles, i) < areaThresh) {
      degenerateCount++;
    } else {
      validIndices.push(i);
    }
  }

  const n = validIndices.length;
  if (n === 0) return { nodes: new Float32Array(NODE_SIZE), triIndices: new Uint32Array(0), degenerateCount };

  // Working array of triangle indices (will be reordered by BVH build)
  const triIdx = new Uint32Array(validIndices);

  // Pre-allocate nodes (worst case: 2n-1 nodes for n leaves)
  const maxNodes = Math.max(2 * n, 1);
  const nodes = new Float32Array(maxNodes * NODE_SIZE);
  let nodeCount = 0;

  function allocNode() {
    return nodeCount++;
  }

  function computeBounds(start, count) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const b = triBounds(vertices, triangles, triIdx[i]);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]);
      x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]);
    }
    return [x0, y0, z0, x1, y1, z1];
  }

  function buildNode(start, count) {
    const idx = allocNode();
    const off = idx * NODE_SIZE;
    const bounds = computeBounds(start, count);
    nodes[off] = bounds[0]; nodes[off + 1] = bounds[1]; nodes[off + 2] = bounds[2];
    nodes[off + 3] = bounds[3]; nodes[off + 4] = bounds[4]; nodes[off + 5] = bounds[5];

    // Barill-style far-field data (Fast Winding Numbers, SIGGRAPH 2018):
    // the subtree's triangles as one dipole — area-weighted centroid, vector
    // area, and a conservative radius. Computed per node from its (contiguous,
    // already-partitioned) triangle range.
    {
      let aw = 1e-30, cxs = 0, cys = 0, czs = 0, nxs = 0, nys = 0, nzs = 0;
      for (let i = start; i < start + count; i++) {
        const ti = triIdx[i];
        const a = triangles[ti * 3] * 3, b = triangles[ti * 3 + 1] * 3, c = triangles[ti * 3 + 2] * 3;
        const e1x = vertices[b] - vertices[a], e1y = vertices[b + 1] - vertices[a + 1], e1z = vertices[b + 2] - vertices[a + 2];
        const e2x = vertices[c] - vertices[a], e2y = vertices[c + 1] - vertices[a + 1], e2z = vertices[c + 2] - vertices[a + 2];
        const vx = (e1y * e2z - e1z * e2y) / 2, vy = (e1z * e2x - e1x * e2z) / 2, vz = (e1x * e2y - e1y * e2x) / 2;
        const area = Math.sqrt(vx * vx + vy * vy + vz * vz);
        aw += area;
        cxs += area * (vertices[a] + vertices[b] + vertices[c]) / 3;
        cys += area * (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3;
        czs += area * (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3;
        nxs += vx; nys += vy; nzs += vz;
      }
      const ccx = cxs / aw, ccy = cys / aw, ccz = czs / aw;
      let r2 = 0;
      for (let ci = 0; ci < 8; ci++) {
        const px2 = bounds[(ci & 1) ? 3 : 0] - ccx;
        const py2 = bounds[(ci & 2) ? 4 : 1] - ccy;
        const pz2 = bounds[(ci & 4) ? 5 : 2] - ccz;
        const d2 = px2 * px2 + py2 * py2 + pz2 * pz2;
        if (d2 > r2) r2 = d2;
      }
      nodes[off + 8] = ccx; nodes[off + 9] = ccy; nodes[off + 10] = ccz;
      nodes[off + 11] = nxs; nodes[off + 12] = nys; nodes[off + 13] = nzs;
      nodes[off + 14] = Math.sqrt(r2);
      nodes[off + 15] = 0;
    }

    if (count <= maxLeafSize) {
      // Leaf node
      nodes[off + 6] = start;  // first
      nodes[off + 7] = count;  // count > 0 means leaf
      return idx;
    }

    // Split along longest axis
    const dx = bounds[3] - bounds[0];
    const dy = bounds[4] - bounds[1];
    const dz = bounds[5] - bounds[2];
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;

    // Median split: partition triIdx[start..start+count) by centroid
    const mid = start + (count >> 1);
    // Partial sort: nth_element approximation via simple partitioning
    partialSort(vertices, triangles, triIdx, start, start + count, mid, axis);

    const leftChild = buildNode(start, mid - start);
    const rightChild = buildNode(mid, start + count - mid);

    // Internal node
    nodes[off + 6] = leftChild;
    nodes[off + 7] = rightChild;
    // count = 0 means internal (already 0 from Float32Array init, but be explicit)
    // Wait — we used off+7 for right child. We need a way to distinguish leaf vs internal.
    // Convention: encode count in a separate way. Let's use:
    // off+6: for leaf = first_tri_index, for internal = left_child (as float, reinterpreted as int)
    // off+7: for leaf = count (> 0), for internal = right_child (reinterpreted, count=0 not possible since we store right)
    // Problem: right_child could be 0. Let's use negative count trick:
    // Actually, let's use a simpler approach: store count separately.
    // Revised layout: [minx, miny, minz, maxx, maxy, maxz, data1, data2]
    // Leaf: data1 = first, data2 = count (> 0)
    // Internal: data1 = left, data2 = -(right) - 1 (negative = internal flag)
    // Or even simpler: use the sign of data2. Positive = leaf count, negative = encode right child.

    // Use negative data2 to indicate internal node:
    // data2 < 0: internal, left = data1, right = -(data2) - 1
    // data2 > 0: leaf, first = data1, count = data2
    nodes[off + 6] = leftChild;
    nodes[off + 7] = -(rightChild) - 1;

    return idx;
  }

  buildNode(0, n);

  return {
    nodes: nodes.slice(0, nodeCount * NODE_SIZE),
    triIndices: triIdx,
    degenerateCount,
    nodeCount,
  };
}

function partialSort(vertices, triangles, indices, lo, hi, mid, axis) {
  // Simple quickselect to partition around median
  if (hi - lo <= 1) return;

  let left = lo, right = hi - 1;
  const pivotIdx = lo + ((hi - lo) >> 1);
  const pivotVal = triCentroid(vertices, triangles, indices[pivotIdx], axis);

  // Move pivot to end
  const tmp0 = indices[pivotIdx]; indices[pivotIdx] = indices[right]; indices[right] = tmp0;

  let store = lo;
  for (let i = lo; i < right; i++) {
    if (triCentroid(vertices, triangles, indices[i], axis) < pivotVal) {
      const t = indices[store]; indices[store] = indices[i]; indices[i] = t;
      store++;
    }
  }
  const t = indices[store]; indices[store] = indices[right]; indices[right] = t;

  if (store < mid) partialSort(vertices, triangles, indices, store + 1, hi, mid, axis);
  else if (store > mid) partialSort(vertices, triangles, indices, lo, store, mid, axis);
}

// ── src/ray.js ──

// Ray → mesh, over the BVH this package already builds.
//
// The GPU ID-buffer answers WHICH layer is under the cursor; it cannot answer
// which TRIANGLE (WebGL2 has no gl_PrimitiveID, and un-indexing a mesh just to
// carry a per-vertex triangle id would triple its vertex memory). So the CPU
// answers it — against the same BVH the solid queries use, so a mesh that has
// been interrogated once picks for free.
//
// Möller–Trumbore, TWO-SIDED: geological wireframes are rarely consistently
// wound, and a surface you can see from below is a surface you can click from
// below. The returned normal is flipped to face the ray, matching the shading.


/**
 * Nearest hit of a ray against a BVH-accelerated triangle mesh.
 *
 * @param {object} mesh   { vertices, triangles, nodes, triIndices } — the shape
 *                        micro caches per mesh layer (bvh fields flattened in).
 * @param {number[]} origin  ray origin, same space as `vertices`
 * @param {number[]} dir     ray direction (need not be normalised)
 * @param {object} [opts]  { maxT } — ignore hits beyond this distance
 * @returns {?{tri:number, t:number, point:number[], normal:number[], bary:number[]}}
 */
function raycastBVH(mesh, origin, dir, { maxT = Infinity } = {}) {
  const { vertices, triangles, nodes, triIndices } = mesh;
  if (!nodes || !nodes.length || !triIndices || !triIndices.length) return null;

  const [ox, oy, oz] = origin;
  let [dx, dy, dz] = dir;
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl > 0)) return null;
  dx /= dl; dy /= dl; dz /= dl;                            // unit ray → t IS a distance
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;             // ±Infinity is fine: the slab test handles it

  let best = maxT, bestTri = -1, bu = 0, bv = 0;
  const stack = [0];

  while (stack.length) {
    const off = stack.pop() * NODE_SIZE;

    // slab test against the node's bounds — miss, or entirely behind our best hit
    const t1x = (nodes[off] - ox) * ix, t2x = (nodes[off + 3] - ox) * ix;
    const t1y = (nodes[off + 1] - oy) * iy, t2y = (nodes[off + 4] - oy) * iy;
    const t1z = (nodes[off + 2] - oz) * iz, t2z = (nodes[off + 5] - oz) * iz;
    const tNear = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z), 0);
    const tFar = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
    if (!(tNear <= tFar) || tNear >= best) continue;

    const data2 = nodes[off + 7];
    if (data2 > 0) {                                       // leaf: data1 = first, data2 = count
      const first = nodes[off + 6];
      for (let i = first; i < first + data2; i++) {
        const ti = triIndices[i];
        const a = triangles[ti * 3] * 3, b = triangles[ti * 3 + 1] * 3, c = triangles[ti * 3 + 2] * 3;
        const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
        const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
        const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
        // p = d × e2;  det = e1 · p   (det ≈ 0 → ray parallel to the triangle)
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;               // two-sided: only PARALLEL is rejected
        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-7 && t < best) { best = t; bestTri = ti; bu = u; bv = v; }
      }
    } else {                                               // internal: data1 = left, data2 = -(right)-1
      stack.push(nodes[off + 6]);
      stack.push(-data2 - 1);
    }
  }

  if (bestTri < 0) return null;

  const a = triangles[bestTri * 3] * 3, b = triangles[bestTri * 3 + 1] * 3, c = triangles[bestTri * 3 + 2] * 3;
  const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
  const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
  const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }   // face the viewer, like the shading

  return {
    tri: bestTri,
    t: best,
    point: [ox + dx * best, oy + dy * best, oz + dz * best],
    normal: [nx, ny, nz],
    bary: [1 - bu - bv, bu, bv],
    verts: [triangles[bestTri * 3], triangles[bestTri * 3 + 1], triangles[bestTri * 3 + 2]],
  };
}

// ── src/topology.js ──

// @gcu/groma — mesh topology in CSR form.
//
// Two adjacency graphs, built once in linear time, that everything walking a
// surface needs: a geodesic brush, a flood fill, Dijkstra along the surface,
// rebuilding a selection's index buffer, closed/open detection.
//
//   vertex -> vertex   (who is one edge away)
//   vertex -> face     (which triangles touch me)
//
// Both are stored as compressed sparse rows: an offsets array of length n+1
// and a packed neighbor array, so row `v` is `neighbors[offsets[v] …
// offsets[v+1]]`. Offsets are EXACT — there is no padding and therefore no
// empty-slot sentinel.
//
// (CAPIVARAS stored neighbors as `v+1` so that 0 could mean "empty", and every
// consumer wrote `const w = nbr[i] - 1; if (w < 0) break;`. That is only needed
// when rows are fixed-stride and padded. Exact rows make the sentinel, the bias
// and the break condition all disappear — one less invariant for every caller
// to remember, and no wasted memory. This is a deliberate departure from the
// original; the geometry is identical.)
//
// Degenerate input is tolerated rather than rejected: a triangle referencing a
// vertex out of range is skipped, and a triangle with a repeated corner
// contributes its real edges only. Field meshes are not clean.

/**
 * Build the CSR adjacency graphs for an indexed triangle mesh.
 *
 * @param {ArrayLike<number>} vertices   flat xyz, length 3·nv (only its length is read)
 * @param {ArrayLike<number>} triangles  flat vertex indices, length 3·nt
 * @param {object} [opts]
 * @param {number} [opts.vertexCount]    override nv (when `vertices` is not flat xyz)
 * @returns {{
 *   vertexCount: number, faceCount: number,
 *   vvOffsets: Uint32Array, vvNeighbors: Uint32Array,
 *   vfOffsets: Uint32Array, vfFaces: Uint32Array,
 *   skipped: number
 * }}
 */
function buildAdjacency(vertices, triangles, { vertexCount } = {}) {
  const nv = vertexCount != null ? vertexCount : Math.floor(vertices.length / 3);
  const nt = Math.floor(triangles.length / 3);
  if (nv <= 0) {
    return {
      vertexCount: 0, faceCount: 0,
      vvOffsets: new Uint32Array(1), vvNeighbors: new Uint32Array(0),
      vfOffsets: new Uint32Array(1), vfFaces: new Uint32Array(0), skipped: nt,
    };
  }

  // ── vertex -> face. Exact by construction: every valid triangle contributes
  //    one entry to each of its three corners. ──
  const vfOffsets = new Uint32Array(nv + 1);
  let skipped = 0;
  const ok = new Uint8Array(nt);                           // remember which faces counted
  for (let f = 0; f < nt; f++) {
    const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
    if (a >= nv || b >= nv || c >= nv || a < 0 || b < 0 || c < 0) { skipped++; continue; }
    ok[f] = 1;
    vfOffsets[a + 1]++; vfOffsets[b + 1]++; vfOffsets[c + 1]++;
  }
  for (let v = 0; v < nv; v++) vfOffsets[v + 1] += vfOffsets[v];
  const vfFaces = new Uint32Array(vfOffsets[nv]);
  {
    const cursor = vfOffsets.slice(0, nv);                 // a moving write head per row
    for (let f = 0; f < nt; f++) {
      if (!ok[f]) continue;
      const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
      vfFaces[cursor[a]++] = f;
      vfFaces[cursor[b]++] = f;
      vfFaces[cursor[c]++] = f;
    }
  }

  // ── vertex -> vertex, derived from vertex -> face.
  //    A vertex's neighbors are the other two corners of each incident face,
  //    deduplicated: an interior edge is shared by two faces, so every neighbor
  //    would otherwise appear twice. Vertex degree is small (typically 4-8 on a
  //    triangulated surface), so a linear scan over the row-so-far is the right
  //    dedup — no Set per vertex, no allocation in the loop. ──
  const vvOffsets = new Uint32Array(nv + 1);
  let scratch = new Uint32Array(64);
  const gather = (v) => {                                  // unique neighbors of v -> scratch
    let k = 0;
    for (let i = vfOffsets[v], e = vfOffsets[v + 1]; i < e; i++) {
      const f = vfFaces[i] * 3;
      for (let j = 0; j < 3; j++) {
        const w = triangles[f + j];
        if (w === v) continue;                             // self, and a repeated corner
        let dup = false;
        for (let q = 0; q < k; q++) if (scratch[q] === w) { dup = true; break; }
        if (dup) continue;
        if (k === scratch.length) {                        // a pathological fan; grow once
          const bigger = new Uint32Array(scratch.length * 2);
          bigger.set(scratch);
          scratch = bigger;
        }
        scratch[k++] = w;
      }
    }
    return k;
  };

  for (let v = 0; v < nv; v++) vvOffsets[v + 1] = gather(v);
  for (let v = 0; v < nv; v++) vvOffsets[v + 1] += vvOffsets[v];
  const vvNeighbors = new Uint32Array(vvOffsets[nv]);
  for (let v = 0; v < nv; v++) {
    const k = gather(v);
    const at = vvOffsets[v];
    for (let q = 0; q < k; q++) vvNeighbors[at + q] = scratch[q];
  }

  return { vertexCount: nv, faceCount: nt, vvOffsets, vvNeighbors, vfOffsets, vfFaces, skipped };
}

/** Neighbors of vertex `v` as a subarray view (no copy). */
function neighbors(adj, v) {
  return adj.vvNeighbors.subarray(adj.vvOffsets[v], adj.vvOffsets[v + 1]);
}

/** Faces incident to vertex `v` as a subarray view (no copy). */
function incidentFaces(adj, v) {
  return adj.vfFaces.subarray(adj.vfOffsets[v], adj.vfOffsets[v + 1]);
}

/** Degree of vertex `v` in the vertex->vertex graph. */
function degree(adj, v) {
  return adj.vvOffsets[v + 1] - adj.vvOffsets[v];
}

/**
 * Connected components over a SUBSET of vertices — the operation that turns a
 * painted patch into individual measurable planes: one component is one plane.
 *
 * @param {object} adj        from buildAdjacency
 * @param {ArrayLike<number>|Set<number>} subset  vertices to consider
 * @returns {{ labels: Int32Array, count: number }}  labels[v] = component id, or
 *          -1 for vertices outside the subset. Ids are assigned in ascending
 *          vertex order, so the result is deterministic.
 */
function components(adj, subset) {
  const nv = adj.vertexCount;
  const inSet = new Uint8Array(nv);
  const members = [];
  for (const v of subset) {
    if (v >= 0 && v < nv && !inSet[v]) { inSet[v] = 1; members.push(v); }
  }
  members.sort((a, b) => a - b);                           // determinism, not correctness

  const labels = new Int32Array(nv).fill(-1);
  const stack = new Uint32Array(members.length);
  let count = 0;
  for (const seed of members) {
    if (labels[seed] !== -1) continue;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = count;
    while (top > 0) {
      const v = stack[--top];
      for (let i = adj.vvOffsets[v], e = adj.vvOffsets[v + 1]; i < e; i++) {
        const w = adj.vvNeighbors[i];
        if (inSet[w] && labels[w] === -1) { labels[w] = count; stack[top++] = w; }
      }
    }
    count++;
  }
  return { labels, count };
}

// ── src/main.js ──

// @gcu/groma — the robust-geometry base of the GCU stack.
//
// Named for the Roman surveyor's cross-staff, alongside regula (drafting
// geometry) and libella (elevation). What lives here is the geometry every
// other package kept re-implementing:
//
//   BVH        build + ray queries — one copy, instead of one per consumer
//   topology   CSR vertex->vertex and vertex->face adjacency for triangle meshes
//
// Consumers: @gcu/winding (generalized winding number ON groma), @gcu/facet
// (structural geology ON groma), micro. @gcu/peel still carries its own BVH;
// folding it in is the follow-up, once this API has two real consumers proving
// its shape rather than one speculative one.
//
// Zero dependencies. Everything is plain typed arrays — no classes to
// serialize, so a BVH or an adjacency crosses a worker boundary by transfer.

export {
  buildBVH,
  NODE_SIZE,
  triArea2,
  raycastBVH,
  buildAdjacency,
  neighbors,
  incidentFaces,
  degree,
  components,
};
