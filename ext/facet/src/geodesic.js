// @gcu/facet — shortest paths ALONG a surface.
//
// Distance here is measured through the mesh, not through the air: the cost of
// an edge is its Euclidean length, and a path may only follow edges. That is
// what makes a digitized trace follow the outcrop over a bulge instead of
// cutting through it, and what makes a brush stop at a gap instead of leaking
// onto the far wall of a fracture that happens to be nearby in space.
//
// Dijkstra over a binary heap. The original walked a plain array and spliced out
// the minimum each pop, which is O(n) per pop and O(n²) overall — fine on the
// toy meshes it was demoed with, quadratic on a real photogrammetry model. The
// heap here is two flat typed arrays, so a search allocates once and never
// touches the garbage collector in its inner loop.

/** A min-heap of (distance, vertex) pairs over flat typed arrays. */
class MinHeap {
  constructor(capacity = 1024) {
    this.key = new Float64Array(capacity);
    this.val = new Uint32Array(capacity);
    this.size = 0;
  }

  push(key, val) {
    if (this.size === this.key.length) this._grow();
    let i = this.size++;
    this.key[i] = key; this.val[i] = val;
    while (i > 0) {                                  // sift up
      const p = (i - 1) >> 1;
      if (this.key[p] <= this.key[i]) break;
      this._swap(p, i);
      i = p;
    }
  }

  pop() {
    const topKey = this.key[0], topVal = this.val[0];
    const last = --this.size;
    this.key[0] = this.key[last]; this.val[0] = this.val[last];
    let i = 0;
    for (;;) {                                       // sift down
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.size && this.key[l] < this.key[m]) m = l;
      if (r < this.size && this.key[r] < this.key[m]) m = r;
      if (m === i) break;
      this._swap(m, i);
      i = m;
    }
    return { key: topKey, val: topVal };
  }

  _swap(a, b) {
    const k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
    const v = this.val[a]; this.val[a] = this.val[b]; this.val[b] = v;
  }

  _grow() {
    const k = new Float64Array(this.key.length * 2); k.set(this.key); this.key = k;
    const v = new Uint32Array(this.val.length * 2); v.set(this.val); this.val = v;
  }
}

/**
 * Dijkstra from one or more seeds over the vertex→vertex graph.
 *
 * Lazy deletion: a vertex may be pushed more than once, and a pop whose key no
 * longer matches the recorded distance is a stale entry and is skipped. That is
 * cheaper than a decrease-key and needs no index-into-heap bookkeeping.
 *
 * @param {number|ArrayLike<number>} seeds  a vertex, or several (all at distance 0)
 * @param {object} adj                      from groma's buildAdjacency
 * @param {ArrayLike<number>} positions     flat xyz
 * @param {object} [opts]
 * @param {number} [opts.maxDist=Infinity]  stop expanding past this surface distance
 * @param {number} [opts.target=-1]         stop as soon as this vertex is settled
 * @param {Uint8Array} [opts.mask]          if given, only vertices with mask[v] are walkable
 * @returns {{dist: Float64Array, prev: Int32Array, settled: number}}
 *          `dist` is Infinity for unreached vertices; `prev` is -1 at a seed or
 *          where unreached.
 */
export function geodesicField(seeds, adj, positions, opts = {}) {
  const { maxDist = Infinity, target = -1, mask } = opts;
  const nv = adj.vertexCount;
  const dist = new Float64Array(nv).fill(Infinity);
  const prev = new Int32Array(nv).fill(-1);
  const done = new Uint8Array(nv);
  const heap = new MinHeap(Math.min(nv, 1024) || 1);

  const seedList = typeof seeds === 'number' ? [seeds] : seeds;
  for (const s of seedList) {
    if (s >= 0 && s < nv && !(mask && !mask[s])) { dist[s] = 0; heap.push(0, s); }
  }

  let settled = 0;
  while (heap.size > 0) {
    const { key, val: v } = heap.pop();
    if (done[v] || key > dist[v]) continue;          // stale entry
    done[v] = 1;
    settled++;
    if (v === target) break;

    const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
    for (let i = adj.vvOffsets[v], e = adj.vvOffsets[v + 1]; i < e; i++) {
      const w = adj.vvNeighbors[i];
      if (done[w] || (mask && !mask[w])) continue;
      const d = key + Math.hypot(
        positions[w * 3] - vx, positions[w * 3 + 1] - vy, positions[w * 3 + 2] - vz,
      );
      if (d < dist[w] && d <= maxDist) { dist[w] = d; prev[w] = v; heap.push(d, w); }
    }
  }
  return { dist, prev, settled };
}

/**
 * The shortest path along the surface from `a` to `b`.
 *
 * @returns {null | {path: Uint32Array, length: number}}  `null` when `b` is not
 *          reachable from `a` — which on a real mesh usually means the two
 *          points are on genuinely disconnected shells, and is information the
 *          caller wants rather than an error.
 */
export function geodesic(a, b, adj, positions, opts = {}) {
  if (a === b) return { path: Uint32Array.of(a), length: 0 };
  const { dist, prev } = geodesicField(a, adj, positions, { ...opts, target: b });
  if (!isFinite(dist[b])) return null;

  let n = 1;
  for (let v = b; v !== a; v = prev[v]) n++;
  const path = new Uint32Array(n);
  let k = n;
  for (let v = b; ; v = prev[v]) { path[--k] = v; if (v === a) break; }
  return { path, length: dist[b] };
}

/**
 * Every vertex within `maxDist` of the seed, measured along the surface — the
 * "grow the selection" operation.
 *
 * @returns {Uint32Array} vertex indices, ascending
 */
export function geodesicBall(seed, maxDist, adj, positions, opts = {}) {
  const { dist } = geodesicField(seed, adj, positions, { ...opts, maxDist });
  const out = [];
  for (let v = 0; v < dist.length; v++) if (dist[v] <= maxDist) out.push(v);
  return Uint32Array.from(out);
}
