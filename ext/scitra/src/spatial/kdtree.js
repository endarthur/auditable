// KDTree — k-dimensional binary tree for fast nearest-neighbor and
// radius queries. Mirrors scipy.spatial.KDTree's API for the methods that
// matter (query, query_ball_point, query_pairs).
//
// Build: O(n log n) via median-of-axis splits, axis cycles by depth.
// Query: O(log n) average for low d; degrades for d > ~10. For our typical
// use cases (geological 2D/3D coordinates), this is exactly the right tool.
//
// Storage layout:
//   nodes are flat arrays for cache-friendliness:
//     splitDim[i]   — int8 axis of the split, or -1 for leaf
//     splitVal[i]   — float median value on that axis
//     leftIdx[i]    — index of left child node, or -1
//     rightIdx[i]   — index of right child node, or -1
//     leafStart[i]  — for leaves, index into perm of the first point
//     leafEnd[i]    —                                 (exclusive)
//   perm — Int32Array of length n giving the permutation of point indices
//          assigned to each leaf (contiguous run [leafStart, leafEnd))

function _normalize(X) {
  if (X instanceof Float64Array) {
    throw new TypeError('flat Float64Array requires opts.n + opts.d (use the constructor opts)');
  }
  if (X && X.data instanceof Float64Array && Array.isArray(X.shape) && X.shape.length === 2) {
    return { data: X.data, n: X.shape[0], d: X.shape[1] };
  }
  if (Array.isArray(X)) {
    if (X.length === 0) return { data: new Float64Array(0), n: 0, d: 0 };
    const d = X[0].length;
    const n = X.length;
    const out = new Float64Array(n * d);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      for (let j = 0; j < d; j++) out[i * d + j] = row[j];
    }
    return { data: out, n, d };
  }
  throw new TypeError('expected ndarray or array of arrays');
}

// Quickselect: partition arr[lo..hi) so that the element at position k
// is the k-th smallest, with all smaller to its left and larger to right.
// arr is a permutation of point indices; we compare on data[idx*d + axis].
function _quickselect(perm, lo, hi, k, data, d, axis) {
  while (lo < hi - 1) {
    // Pivot via median-of-three to avoid worst case on sorted input.
    const mid = (lo + (hi - lo - 1) >> 1);
    const a = data[perm[lo] * d + axis];
    const b = data[perm[mid] * d + axis];
    const c = data[perm[hi - 1] * d + axis];
    let pivotIdx;
    if (a < b) {
      if (b < c) pivotIdx = mid;
      else if (a < c) pivotIdx = hi - 1;
      else pivotIdx = lo;
    } else {
      if (a < c) pivotIdx = lo;
      else if (b < c) pivotIdx = hi - 1;
      else pivotIdx = mid;
    }
    const pivotVal = data[perm[pivotIdx] * d + axis];
    // Move pivot to end
    let tmp = perm[pivotIdx]; perm[pivotIdx] = perm[hi - 1]; perm[hi - 1] = tmp;
    let store = lo;
    for (let i = lo; i < hi - 1; i++) {
      if (data[perm[i] * d + axis] < pivotVal) {
        tmp = perm[i]; perm[i] = perm[store]; perm[store] = tmp;
        store++;
      }
    }
    tmp = perm[store]; perm[store] = perm[hi - 1]; perm[hi - 1] = tmp;
    if (store === k) return;
    if (store < k) lo = store + 1;
    else hi = store;
  }
}

// Min-heap by distance (for query results — keeps the k smallest).
// Used as max-heap by inverting comparisons (so the root is the farthest
// of the current top-k, easily ejectable).
class _MaxHeap {
  constructor(k) {
    this.k = k;
    this.dist = new Float64Array(k);
    this.idx = new Int32Array(k);
    this.size = 0;
  }
  top() { return this.dist[0]; }
  topIdx() { return this.idx[0]; }
  push(d, i) {
    if (this.size < this.k) {
      this.dist[this.size] = d;
      this.idx[this.size] = i;
      this.size++;
      this._up(this.size - 1);
      return;
    }
    if (d < this.dist[0]) {
      this.dist[0] = d;
      this.idx[0] = i;
      this._down(0);
    }
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.dist[i] > this.dist[p]) {
        this._swap(i, p); i = p;
      } else break;
    }
  }
  _down(i) {
    const n = this.size;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.dist[l] > this.dist[m]) m = l;
      if (r < n && this.dist[r] > this.dist[m]) m = r;
      if (m === i) break;
      this._swap(i, m); i = m;
    }
  }
  _swap(a, b) {
    let t = this.dist[a]; this.dist[a] = this.dist[b]; this.dist[b] = t;
    let ti = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = ti;
  }
  // Drain into sorted ascending arrays
  drain() {
    const n = this.size;
    const ds = new Float64Array(n);
    const is = new Int32Array(n);
    // Repeatedly extract max into the back of the result
    for (let k = n - 1; k >= 0; k--) {
      ds[k] = this.dist[0];
      is[k] = this.idx[0];
      this.size--;
      if (this.size > 0) {
        this.dist[0] = this.dist[this.size];
        this.idx[0] = this.idx[this.size];
        this._down(0);
      }
    }
    return { dist: ds, idx: is };
  }
}

export class KDTree {
  constructor(data, opts = {}) {
    const { data: pts, n, d } = _normalize(data);
    this._data = pts;
    this._n = n;
    this._d = d;
    this._leafsize = opts.leafsize ?? 16;

    // Initial permutation [0, 1, ..., n-1].
    this._perm = new Int32Array(n);
    for (let i = 0; i < n; i++) this._perm[i] = i;

    // Pre-allocate node arrays. A balanced k-d tree on n points with
    // leafsize L has at most ~2*ceil(n/L) - 1 nodes; round up generously.
    const cap = Math.max(1, 4 * Math.ceil(n / Math.max(1, this._leafsize)));
    this._splitDim = new Int8Array(cap);
    this._splitVal = new Float64Array(cap);
    this._leftIdx = new Int32Array(cap);
    this._rightIdx = new Int32Array(cap);
    this._leafStart = new Int32Array(cap);
    this._leafEnd = new Int32Array(cap);
    this._nodeCount = 0;
    this._cap = cap;

    if (n > 0) {
      this._root = this._build(0, n, 0);
    } else {
      this._root = -1;
    }
  }

  get n() { return this._n; }
  get d() { return this._d; }
  get data() { return this._data; }

  _ensureCap() {
    if (this._nodeCount < this._cap) return;
    const newCap = this._cap * 2;
    const grow = (arr, ctor) => {
      const out = new ctor(newCap);
      out.set(arr);
      return out;
    };
    this._splitDim = grow(this._splitDim, Int8Array);
    this._splitVal = grow(this._splitVal, Float64Array);
    this._leftIdx = grow(this._leftIdx, Int32Array);
    this._rightIdx = grow(this._rightIdx, Int32Array);
    this._leafStart = grow(this._leafStart, Int32Array);
    this._leafEnd = grow(this._leafEnd, Int32Array);
    this._cap = newCap;
  }

  _build(lo, hi, depth) {
    this._ensureCap();
    const nodeId = this._nodeCount++;
    const len = hi - lo;
    if (len <= this._leafsize) {
      this._splitDim[nodeId] = -1;
      this._leafStart[nodeId] = lo;
      this._leafEnd[nodeId] = hi;
      this._leftIdx[nodeId] = -1;
      this._rightIdx[nodeId] = -1;
      return nodeId;
    }
    // Choose axis with largest spread (more robust than cycling).
    const data = this._data, d = this._d, perm = this._perm;
    let bestAxis = 0, bestSpread = -1;
    for (let a = 0; a < d; a++) {
      let lo2 = Infinity, hi2 = -Infinity;
      for (let i = lo; i < hi; i++) {
        const v = data[perm[i] * d + a];
        if (v < lo2) lo2 = v;
        if (v > hi2) hi2 = v;
      }
      const spread = hi2 - lo2;
      if (spread > bestSpread) { bestSpread = spread; bestAxis = a; }
    }
    if (bestSpread === 0) {
      // All points coincide on every axis — make a leaf.
      this._splitDim[nodeId] = -1;
      this._leafStart[nodeId] = lo;
      this._leafEnd[nodeId] = hi;
      this._leftIdx[nodeId] = -1;
      this._rightIdx[nodeId] = -1;
      return nodeId;
    }
    const axis = bestAxis;
    const mid = (lo + hi) >> 1;
    _quickselect(perm, lo, hi, mid, data, d, axis);
    const splitVal = data[perm[mid] * d + axis];
    this._splitDim[nodeId] = axis;
    this._splitVal[nodeId] = splitVal;
    // Build children — depth+1 cycles axis if you want to use it instead of spread.
    this._leftIdx[nodeId] = this._build(lo, mid, depth + 1);
    this._rightIdx[nodeId] = this._build(mid, hi, depth + 1);
    return nodeId;
  }

  // Squared euclidean dist from point at perm[i] to query point q.
  _sqDist(i, q) {
    const data = this._data, d = this._d;
    const base = i * d;
    let s = 0;
    for (let k = 0; k < d; k++) {
      const t = data[base + k] - q[k];
      s += t * t;
    }
    return s;
  }

  // Find k nearest neighbors. Returns { dist, idx } both length k (or
  // shorter if n < k).
  query(point, kArg = 1, opts = {}) {
    const k = Math.min(kArg, this._n);
    const q = point instanceof Float64Array ? point : Float64Array.from(point);
    if (q.length !== this._d) {
      throw new RangeError(`query dim ${q.length} != tree dim ${this._d}`);
    }
    if (k === 0) {
      return { dist: new Float64Array(0), idx: new Int32Array(0) };
    }
    const heap = new _MaxHeap(k);
    this._knn(this._root, q, heap, opts.distance_upper_bound);
    const drained = heap.drain();
    if (opts.p === 2 || opts.p === undefined) {
      // Convert squared-dist to euclidean.
      for (let i = 0; i < drained.dist.length; i++) drained.dist[i] = Math.sqrt(drained.dist[i]);
    }
    return drained;
  }

  _knn(nodeId, q, heap, distUpper) {
    if (nodeId < 0) return;
    if (this._splitDim[nodeId] === -1) {
      // Leaf — scan all
      const lo = this._leafStart[nodeId];
      const hi = this._leafEnd[nodeId];
      for (let i = lo; i < hi; i++) {
        const sq = this._sqDist(this._perm[i], q);
        if (distUpper !== undefined && sq > distUpper * distUpper) continue;
        heap.push(sq, this._perm[i]);
      }
      return;
    }
    const axis = this._splitDim[nodeId];
    const splitVal = this._splitVal[nodeId];
    const diff = q[axis] - splitVal;
    const near = diff < 0 ? this._leftIdx[nodeId] : this._rightIdx[nodeId];
    const far = diff < 0 ? this._rightIdx[nodeId] : this._leftIdx[nodeId];
    this._knn(near, q, heap, distUpper);
    // Visit far subtree only if its bounding plane is closer than current worst.
    const bound = diff * diff;
    if (heap.size < heap.k || bound < heap.top()) {
      if (distUpper !== undefined && bound > distUpper * distUpper) return;
      this._knn(far, q, heap, distUpper);
    }
  }

  // All points within radius r of the query point. Returns Int32Array of indices.
  query_ball_point(point, r) {
    const q = point instanceof Float64Array ? point : Float64Array.from(point);
    if (q.length !== this._d) {
      throw new RangeError(`query dim ${q.length} != tree dim ${this._d}`);
    }
    const r2 = r * r;
    const out = [];
    this._ball(this._root, q, r2, out);
    return Int32Array.from(out);
  }

  _ball(nodeId, q, r2, out) {
    if (nodeId < 0) return;
    if (this._splitDim[nodeId] === -1) {
      const lo = this._leafStart[nodeId];
      const hi = this._leafEnd[nodeId];
      for (let i = lo; i < hi; i++) {
        if (this._sqDist(this._perm[i], q) <= r2) out.push(this._perm[i]);
      }
      return;
    }
    const axis = this._splitDim[nodeId];
    const splitVal = this._splitVal[nodeId];
    const diff = q[axis] - splitVal;
    if (diff < 0) {
      this._ball(this._leftIdx[nodeId], q, r2, out);
      if (diff * diff <= r2) this._ball(this._rightIdx[nodeId], q, r2, out);
    } else {
      this._ball(this._rightIdx[nodeId], q, r2, out);
      if (diff * diff <= r2) this._ball(this._leftIdx[nodeId], q, r2, out);
    }
  }

  // All pairs of points within distance r. Returns array of [i, j] pairs (i < j).
  query_pairs(r) {
    const out = [];
    const r2 = r * r;
    for (let i = 0; i < this._n; i++) {
      const q = new Float64Array(this._d);
      for (let k = 0; k < this._d; k++) q[k] = this._data[i * this._d + k];
      const ball = [];
      this._ball(this._root, q, r2, ball);
      for (const j of ball) {
        if (j > i) out.push([i, j]);
      }
    }
    return out;
  }
}
