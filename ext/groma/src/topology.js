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
export function buildAdjacency(vertices, triangles, { vertexCount } = {}) {
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
export function neighbors(adj, v) {
  return adj.vvNeighbors.subarray(adj.vvOffsets[v], adj.vvOffsets[v + 1]);
}

/** Faces incident to vertex `v` as a subarray view (no copy). */
export function incidentFaces(adj, v) {
  return adj.vfFaces.subarray(adj.vfOffsets[v], adj.vfOffsets[v + 1]);
}

/** Degree of vertex `v` in the vertex->vertex graph. */
export function degree(adj, v) {
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
export function components(adj, subset) {
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
