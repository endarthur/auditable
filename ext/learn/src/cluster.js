// Clustering — KMeans + AgglomerativeClustering.
//
// Sklearn-compatible at the contract level (`sklearn.cluster.KMeans`,
// `sklearn.cluster.AgglomerativeClustering`). Same hyperparameter
// names, fitted-attribute names, and result conventions. KMeans
// follows @gcu/line discipline (SPEC §6.4): typed arrays for X /
// centroids / labels, monomorphic scalar accumulators, no allocations
// in the assign or update hot paths.
//
// Performance notes (per SPEC §6.1):
//   - KMeans assign step is n × k squared-distance — the textbook tight
//     loop. We use the row-major X with stride-m gathers; centroid
//     state stays in a Float64Array of length k*m.
//   - AgglomerativeClustering uses Lance-Williams updates over a flat
//     n×n distance matrix (O(n²) memory). Acceptable up to n ≈ 5000
//     in browser memory; above that, sklearn's nearest-neighbour-graph
//     variant is the right answer (deferred until a workflow demands it).

import { BaseEstimator, ClusterMixin } from './base.js';
import { asMatrix, checkNFeatures, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { learnRegistry } from './serialize.js';
// Cross-package: scitra's KDTree for the eps-radius queries DBSCAN needs.
import { KDTree } from '../../scitra/index.js';

const MODULE_ID_CLUSTER = '@gcu/learn.cluster';

// ────────────────────────────────────────────────────────────────────
// KMeans
// ────────────────────────────────────────────────────────────────────

export class KMeans extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_clusters = params.n_clusters ?? 8;
    this.init = params.init ?? 'k-means++';
    this.n_init = params.n_init ?? 10;
    this.max_iter = params.max_iter ?? 300;
    this.tol = params.tol ?? 1e-4;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_CLUSTER;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (n < this.n_clusters) {
      throw new ValidationError(
        `KMeans: n_clusters=${this.n_clusters} > n_samples=${n}`);
    }
    const k = this.n_clusters;
    // Run the algorithm n_init times with different seeds, keep the
    // best (lowest inertia) result. Seeds derive from random_state so
    // the whole fit is reproducible.
    const baseSeed = this.random_state == null
      ? Math.floor(Math.random() * 0x7fffffff)
      : this.random_state;
    let best = null;
    for (let trial = 0; trial < this.n_init; trial++) {
      const rng = mulberry32(baseSeed + trial);
      const centroids = this._initCentroids(data, n, m, k, rng);
      const result = _lloyd(data, n, m, k, centroids, this.max_iter, this.tol);
      if (best == null || result.inertia < best.inertia) best = result;
    }
    this.cluster_centers_ = best.centroids;
    this.cluster_centers_.shape = [k, m];
    this.labels_ = best.labels;
    this.inertia_ = best.inertia;
    this.n_iter_ = best.n_iter;
    this.n_features_in_ = m;
    return this;
  }

  predict(X) {
    const { data, shape } = asMatrix(X);
    if (this.cluster_centers_ == null) {
      throw new ValidationError('KMeans: not fitted');
    }
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_clusters;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best_d = Infinity, best_c = 0;
      const off_x = i * m;
      for (let c = 0; c < k; c++) {
        const off_c = c * m;
        let d = 0;
        for (let j = 0; j < m; j++) {
          const diff = data[off_x + j] - this.cluster_centers_[off_c + j];
          d += diff * diff;
        }
        if (d < best_d) { best_d = d; best_c = c; }
      }
      out[i] = best_c;
    }
    return out;
  }

  transform(X) {
    // Distance matrix to each centroid (sklearn's KMeans.transform).
    const { data, shape } = asMatrix(X);
    if (this.cluster_centers_ == null) {
      throw new ValidationError('KMeans: not fitted');
    }
    checkNFeatures(this, shape, { name: 'X' });
    const [n, m] = shape;
    const k = this.n_clusters;
    const out = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      const off_x = i * m;
      for (let c = 0; c < k; c++) {
        const off_c = c * m;
        let d = 0;
        for (let j = 0; j < m; j++) {
          const diff = data[off_x + j] - this.cluster_centers_[off_c + j];
          d += diff * diff;
        }
        out[i * k + c] = Math.sqrt(d);
      }
    }
    out.shape = [n, k];
    return out;
  }

  /** Initialize centroids per the chosen strategy. */
  _initCentroids(data, n, m, k, rng) {
    const init = this.init;
    if (init === 'random') {
      // Sample k distinct rows uniformly.
      const idx = _sampleWithoutReplacement(n, k, rng);
      const centroids = new Float64Array(k * m);
      for (let c = 0; c < k; c++) {
        const src = idx[c] * m;
        const dst = c * m;
        for (let j = 0; j < m; j++) centroids[dst + j] = data[src + j];
      }
      return centroids;
    }
    if (init === 'k-means++') return _kmeansPlusPlusInit(data, n, m, k, rng);
    if (Array.isArray(init) || init instanceof Float64Array) {
      // Allow user-supplied initial centroids (k × m).
      const arr = init instanceof Float64Array ? init
        : Float64Array.from(Array.isArray(init[0]) ? init.flat() : init);
      if (arr.length !== k * m) {
        throw new ValidationError(
          `KMeans: init array length ${arr.length} != n_clusters*n_features (${k*m})`);
      }
      return arr;
    }
    throw new ValidationError(
      `KMeans: init='${init}' must be 'k-means++' | 'random' | array`);
  }
}

Object.assign(KMeans.prototype, ClusterMixin);
KMeans._estimator_type = 'clusterer';

// ────────────────────────────────────────────────────────────────────
// Lloyd's algorithm (KMeans inner loop)
// ────────────────────────────────────────────────────────────────────

function _lloyd(data, n, m, k, centroids_init, max_iter, tol) {
  const centroids = new Float64Array(centroids_init);
  const labels = new Float64Array(n);
  const sums = new Float64Array(k * m);     // accumulator for update step
  const counts = new Int32Array(k);          // samples per cluster
  let prev_inertia = Infinity;
  let inertia = 0;
  let iter = 0;
  for (iter = 0; iter < max_iter; iter++) {
    // ── Assign step ──
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best_d = Infinity, best_c = 0;
      const off_x = i * m;
      for (let c = 0; c < k; c++) {
        const off_c = c * m;
        let d = 0;
        for (let j = 0; j < m; j++) {
          const diff = data[off_x + j] - centroids[off_c + j];
          d += diff * diff;
        }
        if (d < best_d) { best_d = d; best_c = c; }
      }
      labels[i] = best_c;
      inertia += best_d;
    }
    // ── Convergence check ──
    // Skip on iter 0 — prev_inertia is +Infinity then, and the
    // tolerance comparison incorrectly satisfies on Infinity arithmetic.
    if (iter > 0 && Math.abs(prev_inertia - inertia)
                    <= tol * Math.max(1, Math.abs(prev_inertia))) {
      break;
    }
    prev_inertia = inertia;
    // ── Update step ──
    for (let s = 0; s < sums.length; s++) sums[s] = 0;
    for (let c = 0; c < k; c++) counts[c] = 0;
    for (let i = 0; i < n; i++) {
      const c = labels[i] | 0;
      counts[c]++;
      const off_x = i * m;
      const off_s = c * m;
      for (let j = 0; j < m; j++) sums[off_s + j] += data[off_x + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;  // empty cluster — leave centroid in place
      const inv = 1 / counts[c];
      const off = c * m;
      for (let j = 0; j < m; j++) centroids[off + j] = sums[off + j] * inv;
    }
  }
  return { centroids, labels, inertia, n_iter: iter + 1 };
}

// ────────────────────────────────────────────────────────────────────
// k-means++ initialization
// ────────────────────────────────────────────────────────────────────

function _kmeansPlusPlusInit(data, n, m, k, rng) {
  const centroids = new Float64Array(k * m);
  // Pick first center uniformly at random.
  const i0 = Math.floor(rng() * n);
  for (let j = 0; j < m; j++) centroids[j] = data[i0 * m + j];
  // For each subsequent center, sample with probability ∝ squared
  // distance to the nearest existing centroid.
  const min_d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) min_d2[i] = Infinity;
  _updateMinD2(min_d2, data, n, m, centroids, 0);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += min_d2[i];
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= min_d2[i];
      if (r <= 0) { pick = i; break; }
    }
    for (let j = 0; j < m; j++) centroids[c * m + j] = data[pick * m + j];
    _updateMinD2(min_d2, data, n, m, centroids, c);
  }
  return centroids;
}

function _updateMinD2(min_d2, data, n, m, centroids, c) {
  const off_c = c * m;
  for (let i = 0; i < n; i++) {
    const off_x = i * m;
    let d = 0;
    for (let j = 0; j < m; j++) {
      const diff = data[off_x + j] - centroids[off_c + j];
      d += diff * diff;
    }
    if (d < min_d2[i]) min_d2[i] = d;
  }
}

function _sampleWithoutReplacement(n, k, rng) {
  const out = new Int32Array(k);
  const all = new Int32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const t = all[i]; all[i] = all[j]; all[j] = t;
    out[i] = all[i];
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// AgglomerativeClustering
// ────────────────────────────────────────────────────────────────────

export class AgglomerativeClustering extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.n_clusters = params.n_clusters ?? 2;
    this.linkage = params.linkage ?? 'ward';
    this.metric = params.metric ?? 'euclidean';
    this._module = MODULE_ID_CLUSTER;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (n < this.n_clusters) {
      throw new ValidationError(
        `AgglomerativeClustering: n_clusters=${this.n_clusters} > n_samples=${n}`);
    }
    if (this.metric !== 'euclidean') {
      throw new ValidationError(
        `AgglomerativeClustering: metric='${this.metric}' not supported in v0.1 (use 'euclidean')`);
    }
    const linkage_idx = ['single', 'complete', 'average', 'ward'].indexOf(this.linkage);
    if (linkage_idx === -1) {
      throw new ValidationError(
        `AgglomerativeClustering: linkage='${this.linkage}' must be 'ward' | 'single' | 'complete' | 'average'`);
    }
    this.labels_ = _agglomerative(data, n, m, this.n_clusters, this.linkage);
    this.n_clusters_ = this.n_clusters;
    this.n_leaves_ = n;
    this.n_features_in_ = m;
    return this;
  }
}

Object.assign(AgglomerativeClustering.prototype, ClusterMixin);
AgglomerativeClustering._estimator_type = 'clusterer';

// ────────────────────────────────────────────────────────────────────
// Lance-Williams agglomerative algorithm
// ────────────────────────────────────────────────────────────────────
//
// Maintains a flat n×n distance matrix (only the upper triangle is
// meaningful; the diagonal is +Inf to avoid self-merges). For Ward
// linkage we work with squared distances so the update formula stays
// linear in the squared inputs:
//
//   d²(merged, k) = ((|A|+|k|) d²(A,k) + (|B|+|k|) d²(B,k) - |k| d²(A,B))
//                   / (|A|+|B|+|k|)
//
// For 'single'/'complete'/'average' we work with raw distances and
// apply min/max/weighted-mean respectively.

function _agglomerative(data, n, m, n_clusters, linkage) {
  const ward = linkage === 'ward';
  const D = new Float64Array(n * n);
  // Initialize pairwise distances. Upper triangle holds d (or d² for ward);
  // the diagonal stays at +Inf so it never wins a min query.
  for (let i = 0; i < n; i++) D[i * n + i] = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d2 = 0;
      const off_i = i * m;
      const off_j = j * m;
      for (let k = 0; k < m; k++) {
        const diff = data[off_i + k] - data[off_j + k];
        d2 += diff * diff;
      }
      const v = ward ? d2 : Math.sqrt(d2);
      D[i * n + j] = v;
      D[j * n + i] = v;
    }
  }
  const sizes = new Int32Array(n);
  for (let i = 0; i < n; i++) sizes[i] = 1;
  // membership[i] = current cluster id for original sample i (root id).
  const membership = new Int32Array(n);
  for (let i = 0; i < n; i++) membership[i] = i;
  // alive[i] is 1 if cluster i still exists.
  const alive = new Uint8Array(n);
  alive.fill(1);

  let n_active = n;
  while (n_active > n_clusters) {
    // Find the closest pair (a, b) with a < b among alive clusters.
    let best = Infinity, ba = -1, bb = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const v = D[i * n + j];
        if (v < best) { best = v; ba = i; bb = j; }
      }
    }
    if (ba === -1) break;  // no merges left

    // Merge bb into ba.
    const sa = sizes[ba], sb = sizes[bb];
    for (let i = 0; i < n; i++) {
      if (membership[i] === bb) membership[i] = ba;
    }
    sizes[ba] = sa + sb;

    // Lance-Williams update for distances from the merged cluster.
    for (let kk = 0; kk < n; kk++) {
      if (!alive[kk] || kk === ba || kk === bb) continue;
      const sk = sizes[kk];
      const dak = D[ba * n + kk];
      const dbk = D[bb * n + kk];
      const dab = D[ba * n + bb];
      let dnew;
      if (linkage === 'single')   dnew = Math.min(dak, dbk);
      else if (linkage === 'complete') dnew = Math.max(dak, dbk);
      else if (linkage === 'average')  dnew = (sa * dak + sb * dbk) / (sa + sb);
      else /* ward */ {
        // Squared-distance update.
        dnew = ((sa + sk) * dak + (sb + sk) * dbk - sk * dab) / (sa + sb + sk);
      }
      D[ba * n + kk] = dnew;
      D[kk * n + ba] = dnew;
    }
    alive[bb] = 0;
    n_active--;
  }

  // Relabel surviving clusters to 0..n_clusters-1.
  const label_map = new Map();
  let next = 0;
  const labels = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = membership[i];
    if (!label_map.has(c)) label_map.set(c, next++);
    labels[i] = label_map.get(c);
  }
  return labels;
}

// ────────────────────────────────────────────────────────────────────
// DBSCAN
// ────────────────────────────────────────────────────────────────────

/**
 * Density-Based Spatial Clustering of Applications with Noise.
 *
 * Hyperparameters:
 *   - eps          (number, default 0.5) — radius of the neighborhood
 *   - min_samples  (int,    default 5)   — points required to form a core
 *   - metric       'euclidean'           (only one in v0.2)
 *
 * Fitted attributes:
 *   - labels_                (Float64Array, n) — cluster id 0..k-1, or -1 for noise
 *   - core_sample_indices_   (Int32Array)      — indices of core points
 *   - components_            (Float64Array)    — coordinates of core points
 *   - n_features_in_
 *
 * Algorithm: standard DBSCAN. Builds a KDTree over X for fast
 * eps-radius neighbor queries (scitra.query_ball_point), then BFS-
 * expands clusters from core points. fit-only — sklearn's DBSCAN has no
 * predict method either.
 */
export class DBSCAN extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.eps = params.eps ?? 0.5;
    this.min_samples = params.min_samples ?? 5;
    this.metric = params.metric ?? 'euclidean';
    this._module = MODULE_ID_CLUSTER;
  }

  fit(X, _y, _opts) {
    const { data, shape } = asMatrix(X);
    const [n, m] = shape;
    if (this.metric !== 'euclidean') {
      throw new ValidationError(
        `DBSCAN: metric='${this.metric}' not supported in v0.2 (use 'euclidean')`);
    }
    if (this.eps <= 0) {
      throw new ValidationError(`DBSCAN: eps=${this.eps} must be > 0`);
    }
    // Build KDTree.
    const points = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = new Array(m);
      for (let j = 0; j < m; j++) row[j] = data[i * m + j];
      points[i] = row;
    }
    const tree = new KDTree(points);
    // Pre-compute eps-neighbors for each point (kept for the BFS).
    const neighbors = new Array(n);
    const isCore = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const idx = tree.query_ball_point(points[i], this.eps);
      neighbors[i] = idx;
      if (idx.length >= this.min_samples) isCore[i] = 1;
    }
    // Assign cluster labels via BFS from each unvisited core point.
    const labels = new Float64Array(n);
    labels.fill(-1);
    let cluster_id = 0;
    const queue = [];
    for (let i = 0; i < n; i++) {
      if (labels[i] !== -1 || !isCore[i]) continue;
      // Start a new cluster.
      labels[i] = cluster_id;
      queue.length = 0;
      for (const j of neighbors[i]) if (j !== i) queue.push(j);
      while (queue.length > 0) {
        const j = queue.pop();
        if (labels[j] === -1) labels[j] = cluster_id;
        else if (labels[j] !== cluster_id) continue;  // already in another cluster
        if (isCore[j]) {
          // Add j's neighbors not yet in this cluster.
          for (const k of neighbors[j]) {
            if (labels[k] !== cluster_id) queue.push(k);
          }
        }
      }
      cluster_id++;
    }
    // Expose core sample data.
    const core_arr = [];
    for (let i = 0; i < n; i++) if (isCore[i]) core_arr.push(i);
    const core_indices = Int32Array.from(core_arr);
    const components = new Float64Array(core_indices.length * m);
    for (let i = 0; i < core_indices.length; i++) {
      const src = core_indices[i] * m;
      const dst = i * m;
      for (let j = 0; j < m; j++) components[dst + j] = data[src + j];
    }
    components.shape = [core_indices.length, m];
    this.labels_ = labels;
    this.core_sample_indices_ = core_indices;
    this.components_ = components;
    this.n_features_in_ = m;
    return this;
  }
}

Object.assign(DBSCAN.prototype, ClusterMixin);
DBSCAN._estimator_type = 'clusterer';

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('KMeans', KMeans, { module: MODULE_ID_CLUSTER });
learnRegistry.register('AgglomerativeClustering', AgglomerativeClustering, { module: MODULE_ID_CLUSTER });
learnRegistry.register('DBSCAN', DBSCAN, { module: MODULE_ID_CLUSTER });
