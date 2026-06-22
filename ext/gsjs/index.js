// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/gsjs — Modern pure-JS geostatistics for the browser — the evolving sibling to the frozen @gcu/gslib oracle. A neighbourhood-driven kriging engine (krige) exposing intermediate state (the BlockEstimateTensor: weights + sample indices + variance + status + QKNA diagnostics), plus realization, aggregation, cross-validation, declustering — validated bit-for-bit against GSLIB kt3d. WebGPU acceleration is roadmapped behind a backend seam.

// ── src/realize.js ──

// @gcu/gsjs — realization: the reference SpMV-with-predicate that turns a
// BlockEstimateTensor (kriging weights + sample indices, captured mid-flight
// by gsjs.kriging) into per-block estimates.
//
// This pure-JS implementation is the ORACLE. The WebGPU realize kernel (later)
// is validated against it to f32 tolerance, and it is the CPU fallback when
// WebGPU is unavailable (the network-none / file:// case). It carries no
// dependency on atra or the GPU — it's just the math.
//
// Spec: spec_inbox/gsjs-SPEC.md §"Realization formula" + §"Core data structures".

// STATUS enum (u8) — separate metadata, never a value sentinel. Realization
// produces a mathematically defined output for every block regardless of
// status; consumers (viz, aggregation, GT) mask by status. No -999 / NaN codes.
const STATUS = Object.freeze({
  OK: 0,                 // valid estimate
  INSUFFICIENT_DATA: 1,  // na < ndmin
  SINGULAR_SYSTEM: 2,    // ktsol failed (typically duplicate samples)
  NOT_ATTEMPTED: 3,      // block outside any active domain
});

// Per-element value transforms (the realization predicates). Each is
// T(z, d, params): a pure, (piecewise-)linear-in-z function of the sample
// value z and its distance d to the target block. Linearity in z is the key
// property — it makes live cap / HGR sliders a free re-realize (no re-kriging).
//
//   none      → z
//   topcut    → min(z, cap)
//   hgr_hard  → (d > d_thresh ∧ z > grade_thresh) ? min(z, cap) : z
//   hgr_soft  → z ≤ grade_thresh ? z : (1−t)·z + t·min(z,cap),  t = min(d/d_max, 1)
function makeTransform(mode = 'none', params = {}) {
  const cap = params.cap ?? Infinity;
  const dThresh = params.d_thresh ?? 0;
  const dMax = params.d_max ?? 1;
  const gradeThresh = params.grade_thresh ?? Infinity;
  switch (mode) {
    case 'none':
      return (z) => z;
    case 'topcut':
      return (z) => Math.min(z, cap);
    case 'hgr_hard':
      return (z, d) => (d > dThresh && z > gradeThresh) ? Math.min(z, cap) : z;
    case 'hgr_soft':
      return (z, d) => {
        if (z <= gradeThresh) return z;
        const t = Math.min(d / dMax, 1);
        return (1 - t) * z + t * Math.min(z, cap);
      };
    default:
      throw new Error(`gsjs: unknown transform mode '${mode}'`);
  }
}

// Realize a BlockEstimateTensor against the sample values.
//
//   tensor: {
//     indices:  Int32Array   [n_blocks * K]   sample indices, padded
//     weights:  Float64Array [n_blocks * K]   kriging weights, padded
//     n_actual: Int32Array   [n_blocks]       valid entries per block (≤ K)
//     status:   Uint8Array   [n_blocks]       STATUS enum
//     distances?: Float64Array [n_blocks * K] present iff requested (needed by HGR)
//     sk_mean:  null | number | Float64Array  OK / global-SK / SK+LVM
//     K, n_blocks
//   }
//   values: Float64Array — sample values, gathered indirectly via tensor.indices
//   opts:   { transform?, params? }
//
// Returns Float64Array[n_blocks].
//
//   est[b] = Σᵢ wᵢ·T(z(idx_i), d_i) + (1 − Σᵢ wᵢ)·m
//
// where m is 0 for OK (Σw = 1 by construction), a scalar for global SK, or
// sk_mean[b] for SK with locally varying mean. Padded slots [n_actual..K-1]
// are ignored. Every block gets a defined value; mask by status downstream.
function realize(tensor, values, opts = {}) {
  const { indices, weights, n_actual, distances, sk_mean, K, n_blocks } = tensor;
  const T = makeTransform(opts.transform || 'none', opts.params || {});
  const needsDist = opts.transform === 'hgr_hard' || opts.transform === 'hgr_soft';
  if (needsDist && !distances) {
    throw new Error(`gsjs: transform '${opts.transform}' needs distances; re-run krige() with distances:true`);
  }
  const meanOf = sk_mean == null
    ? () => 0
    : (typeof sk_mean === 'number' ? () => sk_mean : (b) => sk_mean[b]);

  const out = new Float64Array(n_blocks);
  for (let b = 0; b < n_blocks; b++) {
    const na = n_actual[b];
    const base = b * K;
    let acc = 0.0, sumW = 0.0;
    for (let k = 0; k < na; k++) {
      const off = base + k;
      const z = values[indices[off]];
      const d = distances ? distances[off] : 0;
      acc += weights[off] * T(z, d);
      sumW += weights[off];
    }
    out[b] = acc + (1 - sumW) * meanOf(b);
  }
  return out;
}

// ── src/aggregate.js ──

// @gcu/gsjs — CPU aggregations over realized block estimates.
//
// All bandwidth-bound reductions over the realized estimates. Every one masks
// by status: only STATUS.OK blocks contribute (no -999 / NaN sentinels to
// filter). Pure JS — this is the default backend AND the oracle a future
// WebGPU aggregation kernel validates against (see backend.js).
//
// These are the "cheap, frequently-changing" tail of the pipeline (binning /
// cutoffs are live-slider targets); the expensive stages (search, solve) sit
// upstream and cache. Spec: spec_inbox/gsjs-SPEC.md §"Aggregations".


// Decompose a row-major block index into integer ijk (matches kt3d's layout:
// index = iz*nx*ny + iy*nx + ix).
function ijk(index, nx, ny) {
  const ix = index % nx;
  const iy = ((index - ix) / nx) % ny;
  const iz = (index - ix - iy * nx) / (nx * ny);
  return [ix, iy, iz];
}

// sum / mean / min / max over estimated blocks.
function stats(est, status) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    const v = est[i];
    n++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n, sum, mean: n ? sum / n : NaN, min: n ? min : NaN, max: n ? max : NaN };
}

// Fixed-bin histogram. Bin edges are predetermined (min/max/nbins) so live
// updates reuse the same bins; auto-ranged from the data when omitted.
function histogram(est, status, opts = {}) {
  const nbins = opts.nbins || 50;
  let { min, max } = opts;
  if (min == null || max == null) {
    const s = stats(est, status);
    if (min == null) min = s.min;
    if (max == null) max = s.max;
  }
  const counts = new Int32Array(nbins);
  const span = max - min;
  const scale = span > 0 ? nbins / span : 0;
  let n = 0;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    let b = scale ? Math.floor((est[i] - min) * scale) : 0;
    if (b < 0) b = 0; else if (b >= nbins) b = nbins - 1;
    counts[b]++; n++;
  }
  const edges = new Float64Array(nbins + 1);
  for (let k = 0; k <= nbins; k++) edges[k] = min + (span * k) / nbins;
  return { edges, counts, n, min, max };
}

// Swath plot: mean estimate (and count) per slice along one axis — the standard
// check that the estimate reproduces the data trend. `geom` is either a kriging
// result's `geom` ({ grid } for full-grid runs → one slice per grid layer, or
// { coords } for target runs → binned across the coordinate range). The kriging
// result carries `geom` directly, so call swath(est, r.status, r.geom, {axis}).
function swath(est, status, geom, opts = {}) {
  const axis = opts.axis || 'x';
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

  // Full grid, no override → exact per-layer (centres = layer coordinates).
  if (geom.grid && !opts.nbins) {
    const g = geom.grid;
    const { nx, ny } = g;
    const dim = ai === 0 ? g.nx : ai === 1 ? g.ny : g.nz;
    const mn = ai === 0 ? g.xmn : ai === 1 ? g.ymn : g.zmn;
    const siz = ai === 0 ? g.xsiz : ai === 1 ? g.ysiz : g.zsiz;
    const sum = new Float64Array(dim), count = new Int32Array(dim);
    for (let i = 0; i < est.length; i++) {
      if (status[i] !== STATUS.OK) continue;
      sum[ijk(i, nx, ny)[ai]] += est[i]; count[ijk(i, nx, ny)[ai]]++;
    }
    const centers = new Float64Array(dim), mean = new Float64Array(dim);
    for (let k = 0; k < dim; k++) { centers[k] = mn + k * siz; mean[k] = count[k] ? sum[k] / count[k] : NaN; }
    return { axis, centers, mean, count };
  }

  // Arbitrary targets → bin across the coordinate range.
  const coords = geom.coords;
  if (!coords) throw new Error('gsjs.swath: geom needs { grid } or { coords }');
  const nbins = opts.nbins || 20;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    const c = coords[i * 3 + ai];
    if (c < lo) lo = c; if (c > hi) hi = c;
  }
  const span = hi - lo, scale = span > 0 ? nbins / span : 0;
  const sum = new Float64Array(nbins), count = new Int32Array(nbins);
  for (let i = 0; i < est.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    let b = scale ? Math.floor((coords[i * 3 + ai] - lo) * scale) : 0;
    if (b < 0) b = 0; else if (b >= nbins) b = nbins - 1;
    sum[b] += est[i]; count[b]++;
  }
  const centers = new Float64Array(nbins), mean = new Float64Array(nbins);
  for (let k = 0; k < nbins; k++) { centers[k] = lo + span * (k + 0.5) / nbins; mean[k] = count[k] ? sum[k] / count[k] : NaN; }
  return { axis, centers, mean, count };
}

// Grade–tonnage curve: for each cutoff, the tonnage, contained metal, and mean
// grade of all OK blocks at or above it. Exact (CPU can afford the O(n·ncut)
// pass — the histogram-derived approximation is a GPU concern). blockTonnage is
// per-block mass (volume × density); default 1 → tonnage is block count.
function gradeTonnage(est, status, opts = {}) {
  const cutoffs = opts.cutoffs || [0];
  const t = opts.blockTonnage != null ? opts.blockTonnage : 1;
  const tonnage = new Float64Array(cutoffs.length);
  const metal = new Float64Array(cutoffs.length);
  const grade = new Float64Array(cutoffs.length);
  for (let c = 0; c < cutoffs.length; c++) {
    const cut = cutoffs[c];
    let ton = 0, met = 0;
    for (let i = 0; i < est.length; i++) {
      if (status[i] !== STATUS.OK) continue;
      if (est[i] >= cut) { ton += t; met += est[i] * t; }
    }
    tonnage[c] = ton;
    metal[c] = met;
    grade[c] = ton > 0 ? met / ton : NaN;
  }
  return { cutoffs: Float64Array.from(cutoffs), tonnage, metal, grade };
}

// ── src/backend.js ──

// @gcu/gsjs — the swappable compute backend.
//
// realize + the aggregations are the contract; the implementation is
// selectable. The CPU (pure-JS) backend is the default — and the oracle every
// other backend validates against bit-for-bit (selection) / to tolerance
// (float estimates, widest on GPU f32). A WebGPU backend (later) implements the
// same interface; an atra/WASM backend can replace any kernel measured faster.
//
// This is the seam that keeps GPU off the critical path: the whole usable v1
// runs on `cpuBackend`; GPU is a drop-in added once the CPU path is complete.
// Spec: spec_inbox/gsjs-SPEC.md §"Initial implementation order" (GPU last) +
// SPEC-neigh §8 (per-kernel measured backend choice).


const cpuBackend = {
  name: 'cpu',
  realize,
  stats,
  histogram,
  swath,
  gradeTonnage,
};

let _backend = cpuBackend;

// Select the active backend (a future WebGPU / atra backend object). Passing a
// falsy value resets to CPU.
function setBackend(b) {
  _backend = b || cpuBackend;
}

function getBackend() {
  return _backend;
}

// ── src/orient.js ──

// @gcu/gsjs — orientation conventions. The search ellipsoid / variogram anisotropy
// can be oriented in several mutually-incompatible parameterizations (GSLIB
// azimuth/dip/rake, Leapfrog dip/dip-azimuth/pitch, Isatis's nine, …). This module
// is the registry that maps each to ONE canonical form — the orthonormal 3×3
// rotation matrix whose ROWS are the ellipsoid axes in world coordinates:
//   row0 = major (Maximum range), row1 = semi-major (Intermediate), row2 = minor.
// World frame: X = East, Y = North, Z = up. `sqdist` / the kd-tree consume the
// matrix (after anisotropy scaling), so conversions go THROUGH the matrix — we
// never hand-derive cross-convention angle trig.
//
// Convention facts pinned by research (2026-06-21, see SPEC-neigh + memory):
//   GSLIB  — intrinsic Z·X·Y, major = North at zero, dip POSITIVE-UP (the quirk).
//            Our setrot port (validated f64 vs gslib wasm). 'gslib' producer.
//   Leapfrog — intrinsic Z·X·Z clockwise (dipAz·Z, dip·X, pitch·Z); pitch measured
//            FROM STRIKE (pitch 0 → major along strike, 90 → down-dip), per
//            Seequent's developer rotation schema. Built here by DIRECT geometric
//            construction of the axis vectors (no Euler sign ambiguity).
//   Isatis.neo — nine named conventions + a conversion tool; same matrix-canonical
//            idea. Future producers slot in here as data (axis order + signs).
//
// UNVERIFIED-vs-real-Leapfrog (single-line toggles, flagged): the strike SENSE
// (right-hand-rule, dipAz−90) and the pitch sign. Confirm against a real Leapfrog
// export when convenient; the geometry below is self-consistent with the docs.

// GSLIB's setrot.for uses a TRUNCATED pi literal (3.141592654) — a 1998 Fortran
// artifact. The 'gslib' producer defaults to Math.PI (modern) and takes GSLIB_PI
// for bit-identical oracle parity (atra's sin/cos are JS Math imports, so this
// literal is the only divergence). Leapfrog etc. always use Math.PI.
const GSLIB_PI = 3.141592654;

// ── GSLIB setrot / sqdist (the validated baseline, ported from gslib.atra) ──

// Port of gslib.setrot (gslib.atra:196). GSLIB angle convention: ang1=azimuth
// (CW from N), ang2=dip, ang3=rake. Row-major 3×3; anisotropy ratios fold into
// rows 2,3 (anis1=minorRange/majorRange, anis2=vertRange/majorRange). `pi` picks
// accurate (Math.PI) vs faithful (GSLIB_PI).
function setrot(ang1, ang2, ang3, anis1, anis2, pi = Math.PI) {
  const DEG = pi / 180;
  const alpha = (ang1 >= 0 && ang1 < 270 ? (90 - ang1) : (450 - ang1)) * DEG;
  const beta = -ang2 * DEG;
  const theta = ang3 * DEG;
  const sina = Math.sin(alpha), sinb = Math.sin(beta), sint = Math.sin(theta);
  const cosa = Math.cos(alpha), cosb = Math.cos(beta), cost = Math.cos(theta);
  const afac1 = 1 / Math.max(anis1, 1e-20);
  const afac2 = 1 / Math.max(anis2, 1e-20);
  return [
    cosb * cosa, cosb * sina, -sinb,
    afac1 * (-cost * sina + sint * sinb * cosa), afac1 * (cost * cosa + sint * sinb * sina), afac1 * (sint * cosb),
    afac2 * (sint * sina + cost * sinb * cosa), afac2 * (-sint * cosa + cost * sinb * sina), afac2 * (cost * cosb),
  ];
}

// Port of gslib.sqdist (gslib.atra:245) — squared anisotropic distance under R.
function sqdist(x1, y1, z1, x2, y2, z2, R) {
  const dx = x1 - x2, dy = y1 - y2, dz = z1 - z2;
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const c = R[i * 3] * dx + R[i * 3 + 1] * dy + R[i * 3 + 2] * dz;
    s += c * c;
  }
  return s;
}

// Scale an orthonormal rotation R (rows = major/semi-major/minor axes) into the
// anisotropic distance matrix sqdist wants: rows 1,2 divided by the range ratios
// (so distance along a short axis counts more). Identical to setrot's afac folding.
function applyAnis(R, anis1, anis2) {
  const a1 = 1 / Math.max(anis1, 1e-20), a2 = 1 / Math.max(anis2, 1e-20);
  return [
    R[0], R[1], R[2],
    a1 * R[3], a1 * R[4], a1 * R[5],
    a2 * R[6], a2 * R[7], a2 * R[8],
  ];
}

// ── vector helpers ──
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
// horizontal unit vector at azimuth (radians, CW from North): East=sin, North=cos
const unitH = (azRad) => [Math.sin(azRad), Math.cos(azRad), 0];

// ── Leapfrog producer (direct geometric construction) ──
//
// leapfrogToRotmat({ dip, dipAzimuth, pitch }) → orthonormal R (pure rotation).
// dip = angle below horizontal of the major-semimajor plane; dipAzimuth = compass
// direction of dip (CW from N); pitch = angle of the major axis IN the plane,
// measured from strike (0 → along strike, 90 → down-dip). Built straight from
// these meanings — pitch-from-strike falls out by construction, so there's no
// Euler-order/sign trap. Strike uses the right-hand rule (dip to the right →
// strike = dipAzimuth − 90°); see the UNVERIFIED note up top. This is the standard
// structural-geology convention (Leapfrog and others use it); the public name is
// 'structural' (leapfrogToRotmat is kept as a quiet alias).
function structuralToRotmat({ dip = 0, dipAzimuth = 0, pitch = 0 } = {}) {
  const r = Math.PI / 180;
  const az = dipAzimuth * r, dp = dip * r, pt = pitch * r;
  const cd = Math.cos(dp), sd = Math.sin(dp);
  const strike = unitH(az - Math.PI / 2);                       // RHR strike
  const downdip = [Math.sin(az) * cd, Math.cos(az) * cd, -sd];  // toward dipAz, plunging down
  const cp = Math.cos(pt), sp = Math.sin(pt);
  const major = add(scale(strike, cp), scale(downdip, sp));     // pitch from strike
  const semimajor = add(scale(strike, -sp), scale(downdip, cp));// in-plane ⟂ to major
  const minor = cross(major, semimajor);                        // plane normal — right-handed (det +1)
  return [...major, ...semimajor, ...minor];
}
// quiet alias

// ── convention dispatcher ──
//
// toRotmat(convention, params, pi?) → orthonormal R (rows = major/semi-major/minor).
//   'structural' { dip, dipAzimuth, pitch } — the geologist default (dip/dip-az/pitch)
//   'gslib'      { azimuth, dip, rake }      — the GSLIB baseline (pi-flag aware)
// ('leapfrog' is accepted as an alias of 'structural'.) Anisotropy is applied
// separately (applyAnis) so this stays pure orientation.
function toRotmat(convention, params = {}, pi = Math.PI) {
  switch (convention) {
    case 'gslib':
      return setrot(params.azimuth || 0, params.dip || 0, params.rake || 0, 1, 1, pi);
    case 'structural':
    case 'leapfrog':
      return structuralToRotmat(params);
    default:
      throw new Error(`gsjs.orient: unknown convention '${convention}'`);
  }
}

// ── ../scitra/src/spatial/kdtree.js ──

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
    // Note: `>>` has LOWER precedence than `+` in JS — the parens around
    // the shift operand are REQUIRED. Without them this becomes
    // `(lo + (hi - lo - 1)) >> 1`, which can land OUTSIDE [lo, hi) and
    // corrupts perm at positions outside the active range when the
    // pivot-swap happens. Caused a subtle but serious kNN bug where
    // points ended up in the wrong subtree.
    const mid = lo + ((hi - lo - 1) >>> 1);
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

class KDTree {
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

  // Batch kNN — run a query for each of m points, return flat result arrays.
  // points: m×d, accepted as Array<Array<number>>, ndarray { data, shape },
  // or flat Float64Array + opts.m + opts.d.
  // Returns { dist, idx } where each is m*k flat (row-major, m rows of k each).
  queryBatch(points, kArg = 1, opts = {}) {
    let pts, m, d;
    if (points instanceof Float64Array) {
      if (opts.m === undefined || opts.d === undefined) {
        throw new TypeError('queryBatch: flat Float64Array requires opts.m and opts.d');
      }
      pts = points; m = opts.m; d = opts.d;
    } else if (points && points.data instanceof Float64Array && Array.isArray(points.shape)) {
      if (points.shape.length !== 2) {
        throw new RangeError('queryBatch: expected 2D ndarray');
      }
      pts = points.data; m = points.shape[0]; d = points.shape[1];
    } else if (Array.isArray(points)) {
      m = points.length;
      d = m > 0 ? points[0].length : this._d;
      pts = new Float64Array(m * d);
      for (let i = 0; i < m; i++) {
        const row = points[i];
        for (let j = 0; j < d; j++) pts[i * d + j] = row[j];
      }
    } else {
      throw new TypeError('queryBatch: expected ndarray, flat Float64Array, or array of arrays');
    }
    if (d !== this._d) {
      throw new RangeError(`queryBatch: dim ${d} != tree dim ${this._d}`);
    }
    const k = Math.min(kArg, this._n);
    const outDist = new Float64Array(m * k);
    const outIdx = new Int32Array(m * k);
    if (k === 0) return { dist: outDist, idx: outIdx };
    // Reusable buffers — one query at a time so we don't blow scratch
    const q = new Float64Array(d);
    const heap = new _MaxHeap(k);
    const p = opts.p ?? 2;
    for (let i = 0; i < m; i++) {
      // Copy row i into q
      const base = i * d;
      for (let j = 0; j < d; j++) q[j] = pts[base + j];
      // Reset heap state — reuse arrays in place
      heap.size = 0;
      this._knn(this._root, q, heap, opts.distance_upper_bound);
      const drained = heap.drain();
      const outBase = i * k;
      if (p === 2) {
        for (let j = 0; j < drained.dist.length; j++) {
          outDist[outBase + j] = Math.sqrt(drained.dist[j]);
          outIdx[outBase + j] = drained.idx[j];
        }
      } else {
        for (let j = 0; j < drained.dist.length; j++) {
          outDist[outBase + j] = drained.dist[j];
          outIdx[outBase + j] = drained.idx[j];
        }
      }
    }
    return { dist: outDist, idx: outIdx };
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

// ── src/neigh.js ──

// @gcu/gsjs — the search neighbourhood (M3a foundation: the moving ellipsoid).
//
// SPEC-neigh: the neighbourhood is a first-class, decoupled object — it SELECTS
// (and later tapers) the conditioning samples for a target; weighting stays the
// estimator's job. This is the Isatis-style split that lets one neighbourhood be
// reused across SK/OK/IK and compared apples-to-apples.
//
// Backend: a kd-tree (scitra's, inlined) built in TRANSFORMED coordinates — the
// `setrot` rotation+anisotropy is applied to every sample up front, so the
// anisotropic ellipsoid search collapses to a plain Euclidean sphere query. The
// tree is a prefilter only: select() recomputes the anisotropic distance via the
// ported `sqdist` and filters/sorts on THAT, so the result is bit-identical to a
// brute-force ellipsoid scan (the M3a validation gate) regardless of the tree's
// internal float order. Deterministic tie-break (original sample index) is a
// day-one invariant — the floor every later backend must reproduce.
//
// `ext/gslib` is frozen: setrot/sqdist are PORTED to JS here (faithfully, from
// gslib.atra) so gsjs owns the gather end-to-end in original sample order — no
// super-block permutation to thread. Spec: spec_inbox/SPEC-neigh.md §4.

// setrot/sqdist/orientation conventions live in orient.js (one-way dep); main.js
// exports orient.js's surface, so the package surface is unchanged.

// Apply R to a coordinate → its transformed-space position (Euclidean distance
// there == anisotropic sqdist here). Used to build the kd-tree.
function rotApply(R, x, y, z) {
  return [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
}

// Angular sector of an offset (dx,dy,dz) from the target, in the search's
// PURE-rotation frame (anisotropy removed, so sectors are true angular wedges
// aligned to the ellipsoid orientation, not stretched by anis). Horizontal
// azimuth → one of `n` wedges; with hemispheres, the dz sign doubles it to 2n.
function sectorOf(S, rotPure, dx, dy, dz) {
  const x = rotPure[0] * dx + rotPure[1] * dy + rotPure[2] * dz;
  const y = rotPure[3] * dx + rotPure[4] * dy + rotPure[5] * dz;
  let az = Math.atan2(y, x);
  if (az < 0) az += 2 * Math.PI;
  let w = Math.floor(az / (2 * Math.PI / S.n));
  if (w >= S.n) w = S.n - 1;
  if (S.hemispheres) {
    const z = rotPure[6] * dx + rotPure[7] * dy + rotPure[8] * dz;
    if (z < 0) w += S.n;
  }
  return w;
}

// createNeighborhood(opts) — the moving-ellipsoid neighbourhood. Orientation is
// convention-driven (see orient.js):
//   { radius, radiusMinor?, radiusVert?,           ranges: major / intermediate / minor
//     convention?, ndmin?, ndmax?, faithful?, sectors?, ...orientationParams }
//   convention 'gslib' (default): { azimuth | angle, dip | angle2, rake | angle3 }
//   convention 'leapfrog':        { dip, dipAzimuth, pitch }   (pitch from strike)
// radiusMinor/radiusVert default to radius (isotropic). `faithful:true` uses
// gslib's truncated π (oracle parity / wasm-kriging-fork consistency; gslib
// convention only). `sectors: { n, maxPer?, minPer?, minFilled?, hemispheres? }`
// turns on angular-sector declustering. The rotation matrix is built once here.
function createNeighborhood(opts = {}) {
  if (!(opts.radius > 0)) throw new Error('gsjs.neigh: radius must be > 0');
  const radius = opts.radius;
  const radiusMinor = opts.radiusMinor != null ? opts.radiusMinor : radius;
  const radiusVert = opts.radiusVert != null ? opts.radiusVert : radius;
  const ndmin = opts.ndmin != null ? opts.ndmin : 1;
  const ndmax = opts.ndmax != null ? opts.ndmax : Infinity;
  if (!(ndmax >= ndmin) || !(ndmin >= 1)) throw new Error('gsjs.neigh: need ndmax ≥ ndmin ≥ 1');
  const faithful = !!opts.faithful;
  const pi = faithful ? GSLIB_PI : Math.PI;
  const type = opts.type || 'moving';

  // orientation → the distance matrix (rotmat) + the pure rotation (sector binning).
  let rotmat, rotPure, convention, benchHalf = 0;
  if (type === 'bench') {
    // bench (2.5D): a HORIZONTAL 2D ellipse + a vertical-band prefilter. The rotmat
    // is the horizontal ellipse with its vertical row ZEROED, so sqdist ignores z
    // (true 2D search); the band |Δz| ≤ benchThickness/2 is applied in select's
    // gather. Oriented by `azimuth` (dip/pitch/radiusVert are meaningless here).
    if (!(opts.benchThickness > 0)) throw new Error('gsjs.neigh: bench needs benchThickness > 0');
    benchHalf = opts.benchThickness / 2;
    convention = 'bench';
    const az = opts.azimuth != null ? opts.azimuth : (opts.angle || 0);
    const h = setrot(az, 0, 0, radiusMinor / radius, 1, pi);  // dip=0 → rows 0,1 horizontal
    rotmat = [h[0], h[1], 0, h[3], h[4], 0, 0, 0, 0];          // drop the z row → 2D ellipse
    const hp = setrot(az, 0, 0, 1, 1, pi);
    rotPure = [hp[0], hp[1], 0, hp[3], hp[4], 0, 0, 0, 0];     // horizontal pure rotation
  } else {
    // moving (default): full 3D ellipsoid. gslib accepts legacy angle/angle2/angle3.
    convention = opts.convention || 'gslib';
    const orientParams = convention === 'gslib'
      ? { azimuth: opts.azimuth != null ? opts.azimuth : (opts.angle || 0), dip: opts.dip != null ? opts.dip : (opts.angle2 || 0), rake: opts.rake != null ? opts.rake : (opts.angle3 || 0) }
      : opts;
    rotPure = toRotmat(convention, orientParams, pi);
    rotmat = applyAnis(rotPure, radiusMinor / radius, radiusVert / radius);
  }

  let sectors = null;
  if (opts.sectors) {
    const s = opts.sectors;
    const n = s.n != null ? s.n : 8;
    const maxPer = s.maxPer != null ? s.maxPer : Infinity;
    const minPer = s.minPer != null ? s.minPer : 1;
    const minFilled = s.minFilled != null ? s.minFilled : 1;
    const hemispheres = !!s.hemispheres;
    if (!(n >= 1)) throw new Error('gsjs.neigh: sectors.n must be ≥ 1');
    if (!(maxPer >= 1)) throw new Error('gsjs.neigh: sectors.maxPer must be ≥ 1');
    if (!(minPer >= 1) || minPer > maxPer) throw new Error('gsjs.neigh: need 1 ≤ sectors.minPer ≤ maxPer');
    if (!(minFilled >= 0)) throw new Error('gsjs.neigh: sectors.minFilled must be ≥ 0');
    sectors = { n, maxPer, minPer, minFilled, hemispheres, count: hemispheres ? 2 * n : n };
  }

  // per-drillhole cap (needs a holeId side array bound at indexSamples) + minimum
  // separation between retained samples (real Euclidean — declusters near-duplicates).
  const perHoleMax = opts.perHoleMax != null ? opts.perHoleMax : null;
  if (perHoleMax != null && !(perHoleMax >= 1)) throw new Error('gsjs.neigh: perHoleMax must be ≥ 1');
  const minSampleDistance = opts.minSampleDistance != null ? opts.minSampleDistance : 0;
  if (!(minSampleDistance >= 0)) throw new Error('gsjs.neigh: minSampleDistance must be ≥ 0');

  return {
    type, convention, faithful,
    radius, radiusMinor, radiusVert,
    rotmat, ndmin, ndmax, sectors, perHoleMax, minSampleDistance,
    ...(type === 'bench' ? { benchThickness: opts.benchThickness } : {}),
    _rotPure: rotPure,   // pure orientation (anis removed) — used by sector binning
    _benchHalf: benchHalf,
    _tree: null, _n: 0, _ox: null, _oy: null, _oz: null, _holeId: null,
  };
}

// Bind the conditioning samples and build the kd-tree (once — samples are
// resident per §7). `samples` is an array of [x,y,z] (extra columns ignored), or
// the same row objects + a getter. `opts.holeId` is an optional side array
// (parallel to samples, ORIGINAL order — SPEC-neigh §4.1) consumed by the per-hole
// cap. Returns the neighbourhood (mutated) for chaining.
function indexSamples(nbhd, samples, get, opts = {}) {
  const n = samples.length;
  const xform = new Float64Array(n * 3);
  const ox = new Float64Array(n), oy = new Float64Array(n), oz = new Float64Array(n);
  const R = nbhd.rotmat;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const x = get ? get(s, 0) : s[0], y = get ? get(s, 1) : s[1], z = get ? get(s, 2) : s[2];
    const t = rotApply(R, x, y, z);
    xform[i * 3] = t[0]; xform[i * 3 + 1] = t[1]; xform[i * 3 + 2] = t[2];
    ox[i] = x; oy[i] = y; oz[i] = z;
  }
  if (opts.holeId != null) {
    if (opts.holeId.length !== n) throw new Error('gsjs.neigh.indexSamples: holeId length must match samples');
    nbhd._holeId = opts.holeId;
  }
  nbhd._tree = new KDTree({ data: xform, shape: [n, 3] });
  nbhd._n = n; nbhd._ox = ox; nbhd._oy = oy; nbhd._oz = oz;
  return nbhd;
}

// select(nbhd, target, opts?) — the neighbourhood for one target location.
//   target: [x, y, z]
//   returns { ranks: Int32Array, dists: Float64Array, status, n, filled? }
// `ranks` are ORIGINAL sample indices (into the array passed to indexSamples),
// distance-sorted then tie-broken by original index. One greedy pass in distance
// order applies every active policy: ndmax cap, sector cap (≤ maxPer per sector),
// per-hole cap (≤ perHoleMax per drillhole), and minimum separation (drop a
// candidate within minSampleDistance of one already kept). status is
// INSUFFICIENT_DATA when fewer than ndmin retained, or (sectors) fewer than
// minFilled sectors hold ≥ minPer. `filled` (sector count) is returned when
// sectors are active.
function select(nbhd, target, opts = {}) {
  if (!nbhd._tree) throw new Error('gsjs.neigh.select: call indexSamples(nbhd, samples) first');
  const R = nbhd.rotmat;
  const tx = target[0], ty = target[1], tz = target[2];
  const [qx, qy, qz] = rotApply(R, tx, ty, tz);
  const r2 = nbhd.radius * nbhd.radius;
  const benchHalf = nbhd._benchHalf;
  const S = nbhd.sectors;
  const perHoleMax = nbhd.perHoleMax;
  const minSep2 = nbhd.minSampleDistance > 0 ? nbhd.minSampleDistance * nbhd.minSampleDistance : 0;
  const needGreedy = S || perHoleMax != null || minSep2 > 0;
  // exclude: drop sample indices from the gather BEFORE any cap (cross-validation
  // leave-one-out — exclude the target's own sample, optionally its whole hole).
  // A Set or a predicate (i)=>bool. Forces the full gather (the kNN fast path can't
  // pre-size when an unknown count is removed); CV is n solves, not the hot path.
  const exclude = opts.exclude || null;
  const isExcl = exclude ? (exclude.has ? (i) => exclude.has(i) : exclude) : null;

  // Gather the in-ellipsoid candidates as { i, d2 }, distance-sorted (d2, index).
  // FAST PATH — a plain moving ellipsoid with a finite ndmax (no sector/per-hole/
  // min-dist/bench policies): a bounded kNN prunes the tree to ~ndmax candidates
  // instead of every sample in radius (≈4× fewer at typical drillhole density). It's
  // trusted only when there's no EXACT tie at the ndmax boundary; on a tie we fall
  // back to the full radius gather, so the result stays bit-identical to brute force.
  // (Authoritative sqdist is recomputed either way — the tree is only a prefilter.)
  let inside = null;
  if (!needGreedy && !isExcl && benchHalf === 0 && Number.isFinite(nbhd.ndmax)) {
    const knn = nbhd._tree.query([qx, qy, qz], nbhd.ndmax + 1, { distance_upper_bound: nbhd.radius * (1 + 1e-9) });
    const m = knn.idx.length, cand = [];
    for (let a = 0; a < m; a++) {
      const i = knn.idx[a];
      const d2 = sqdist(tx, ty, tz, nbhd._ox[i], nbhd._oy[i], nbhd._oz[i], R);
      if (d2 <= r2) cand.push({ i, d2 });
    }
    cand.sort((a, b) => (a.d2 - b.d2) || (a.i - b.i));
    // ambiguous only if the ndmax-th and (ndmax+1)-th are an exact tie — then the
    // cap can't pick between them deterministically, so fall through to the gather.
    const boundaryTie = cand.length > nbhd.ndmax && cand[nbhd.ndmax].d2 === cand[nbhd.ndmax - 1].d2;
    if (!boundaryTie) inside = cand;
  }
  if (inside === null) {
    // full radius gather (+ bench band) — the policy/greedy path and the tie fallback.
    const cand = nbhd._tree.query_ball_point([qx, qy, qz], nbhd.radius * (1 + 1e-9));
    inside = [];
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      if (isExcl && isExcl(i)) continue;
      if (benchHalf > 0 && Math.abs(nbhd._oz[i] - tz) > benchHalf) continue;
      const d2 = sqdist(tx, ty, tz, nbhd._ox[i], nbhd._oy[i], nbhd._oz[i], R);
      if (d2 <= r2) inside.push({ i, d2 });
    }
    inside.sort((a, b) => (a.d2 - b.d2) || (a.i - b.i));   // distance, then original index
  }

  let keep, filled;

  if (needGreedy) {
    if (perHoleMax != null && !nbhd._holeId) throw new Error('gsjs.neigh.select: perHoleMax set but no holeId bound — pass { holeId } to indexSamples');
    // single greedy pass in distance order, applying every active policy: a
    // candidate is kept only if it clears the sector cap, the per-hole cap, the
    // minimum separation, AND the overall ndmax. Distance still rules the order.
    const perSector = S ? new Int32Array(S.count) : null;
    const perHole = perHoleMax != null ? new Map() : null;
    keep = [];
    for (let k = 0; k < inside.length && keep.length < nbhd.ndmax; k++) {
      const c = inside[k], i = c.i;
      let sec = -1;
      if (S) {
        sec = sectorOf(S, nbhd._rotPure, nbhd._ox[i] - tx, nbhd._oy[i] - ty, nbhd._oz[i] - tz);
        if (perSector[sec] >= S.maxPer) continue;
      }
      let hid;
      if (perHole) { hid = nbhd._holeId[i]; if ((perHole.get(hid) || 0) >= perHoleMax) continue; }
      if (minSep2 > 0) {
        let tooClose = false;
        for (let m = 0; m < keep.length; m++) {
          const j = keep[m].i;
          const dx = nbhd._ox[i] - nbhd._ox[j], dy = nbhd._oy[i] - nbhd._oy[j], dz = nbhd._oz[i] - nbhd._oz[j];
          if (dx * dx + dy * dy + dz * dz < minSep2) { tooClose = true; break; }
        }
        if (tooClose) continue;
      }
      if (S) perSector[sec]++;
      if (perHole) perHole.set(hid, (perHole.get(hid) || 0) + 1);
      keep.push(c);
    }
    if (S) { filled = 0; for (let s = 0; s < S.count; s++) if (perSector[s] >= S.minPer) filled++; }
  } else {
    keep = inside.length > nbhd.ndmax ? inside.slice(0, nbhd.ndmax) : inside;
  }

  const ranks = new Int32Array(keep.length);
  const dists = new Float64Array(keep.length);
  for (let k = 0; k < keep.length; k++) { ranks[k] = keep[k].i; dists[k] = Math.sqrt(keep[k].d2); }
  const enough = keep.length >= nbhd.ndmin && (!S || filled >= S.minFilled);
  const out = { ranks, dists, n: keep.length, status: enough ? STATUS.OK : STATUS.INSUFFICIENT_DATA };
  if (S) out.filled = filled;
  return out;
}

// ── src/krige.js ──

// @gcu/gsjs — M3c: the pure-JS kriging driver fed by the neighbourhood.
//
// SPEC-neigh §8 / §5.0(b): rather than spelunk the atra fork to decouple its inline
// search, gsjs grows its OWN kriging driver in JS — for each target the neighbourhood
// (select()) picks the samples, then this builds + solves the small dense kriging
// system here (cova3 ported to JS, a Gaussian-elimination solve), producing the same
// BlockEstimateTensor realize() consumes. Consequences:
//   - the rich neighbourhood (sectors / per-hole / bench / conventions) now drives
//     a real estimate — any sample set the policies return just works;
//   - everything stays in ORIGINAL sample order (the super-block permutation issue
//     §4.1 flagged simply doesn't arise — tensor.indices index the original data);
//   - it decouples from gslib's wasm kriging while staying validated against it: with
//     faithful:true + a moving ellipsoid, select() reproduces srchsupr's set and the
//     estimates match gslib.kt3d to tolerance (§8: bit-identical SELECTION, tolerance-
//     equal estimates). Swap a measured hot loop to atra/WASM later if needed.
//
// OK + SK; point or block kriging (block = discretized RHS + block-block cbb).
// Spec: spec_inbox/SPEC-neigh.md §5/§8.


const _VTYPE = {
  spherical: 1, exponential: 2, gaussian: 3, power: 4, hole: 5,
  sph: 1, exp: 2, gau: 3, pow: 4, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
};

// Port of gslib.cova3 (gslib.atra:546): variogram model → covariance evaluator.
// Each structure carries its own rotation (anisotropy); cmax is the sill (zero-lag
// covariance). Returns { cmax, cova(x1,y1,z1,x2,y2,z2) }.
function buildModel(variogram, pi) {
  const c0 = variogram.nugget || 0;
  const structs = (variogram.structures || []).map((s) => {
    const it = _VTYPE[s.type];
    if (it == null) throw new Error(`gsjs.krige: unknown variogram type '${s.type}'`);
    const aa = s.range;
    const rMinor = s.rangeMinor != null ? s.rangeMinor : aa;
    const rVert = s.rangeVert != null ? s.rangeVert : aa;
    // orientation: a convention + params (default gslib azimuth/dip/rake from
    // angle/angle2/angle3), → pure rotation, then anisotropy folded in.
    const conv = s.convention || 'gslib';
    const orientParams = conv === 'gslib'
      ? { azimuth: s.angle || 0, dip: s.angle2 || 0, rake: s.angle3 || 0 }
      : s.orientation || s;
    const pureR = toRotmat(conv, orientParams, pi);
    return { it, cc: s.contribution, aa, rot: applyAnis(pureR, rMinor / aa, rVert / aa) };
  });
  let cmax = c0;
  for (const s of structs) cmax += s.it === 4 ? 999 : s.cc;
  const cova = (x1, y1, z1, x2, y2, z2) => {  // eslint-disable-line no-shadow
    const hsq0 = sqdist(x1, y1, z1, x2, y2, z2, structs[0].rot);
    if (hsq0 < 1e-5) return cmax;                       // coincident → full sill
    let c = 0;
    for (let is = 0; is < structs.length; is++) {
      const s = structs[is];
      const h = Math.sqrt(is === 0 ? hsq0 : sqdist(x1, y1, z1, x2, y2, z2, s.rot));
      if (s.it === 1) { const hr = h / s.aa; if (hr < 1) c += s.cc * (1 - hr * (1.5 - 0.5 * hr * hr)); }
      else if (s.it === 2) c += s.cc * Math.exp(-3 * h / s.aa);
      else if (s.it === 3) c += s.cc * Math.exp(-3 * (h / s.aa) * (h / s.aa));
      else if (s.it === 4) c += cmax - s.cc * Math.pow(h, s.aa);
      else if (s.it === 5) c += s.cc * Math.cos(h / s.aa * 3.14159265);
    }
    return c;
  };
  return { cmax, cova, c0 };
}

// Discretization-point offsets relative to the block CENTRE, for a block of
// (bxsiz,bysiz,bzsiz) split nxdis×nydis×nzdis. (gsjs.discr/kt3d emit the same
// points in a block-CORNER frame, i.e. +bxsiz/2, and translate the samples to
// match; this driver works in absolute coords so it wants centre-relative offsets
// — the `tl*` value, without gslib's +0.5·bsiz corner shift.)
function discr(bxsiz, bysiz, bzsiz, nxdis, nydis, nzdis) {
  const xdis = bxsiz / Math.max(nxdis, 1), ydis = bysiz / Math.max(nydis, 1), zdis = bzsiz / Math.max(nzdis, 1);
  const pts = [];
  let tlx = -0.5 * (bxsiz + xdis);
  for (let ix = 0; ix < nxdis; ix++) {
    tlx += xdis;
    let tly = -0.5 * (bysiz + ydis);
    for (let iy = 0; iy < nydis; iy++) {
      tly += ydis;
      let tlz = -0.5 * (bzsiz + zdis);
      for (let iz = 0; iz < nzdis; iz++) {
        tlz += zdis;
        pts.push([tlx, tly, tlz]);   // centre-relative offset
      }
    }
  }
  return pts;
}

// Solve A·x = b for the n×n system (A flat row-major) by Gaussian elimination with
// partial pivoting — the ktsol stand-in. Returns { x, singular }. The OK system is
// symmetric indefinite (a saddle point), so a plain Cholesky won't do; GE handles it.
// (Tried an in-place variant to cut the per-block copy — measured neutral: the
// large-ndmax solve is arithmetic-bound, not allocation-bound. Kept the clean,
// non-mutating form.)
function solveGE(A, b, n) {
  const M = Float64Array.from(A), x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r++) { const v = Math.abs(M[r * n + col]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) return { x: null, singular: true };
    if (piv !== col) {
      for (let c = 0; c < n; c++) { const t = M[col * n + c]; M[col * n + c] = M[piv * n + c]; M[piv * n + c] = t; }
      const t = x[col]; x[col] = x[piv]; x[piv] = t;
    }
    const diag = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / diag;
      if (f !== 0) { for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c]; x[r] -= f * x[col]; }
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < n; c++) s -= M[r * n + c] * x[c];
    x[r] = s / M[r * n + r];
  }
  return { x, singular: false };
}

// Resolve the target list + block-dimension CATEGORIES (the front doors mirror
// kriging(): grid | grid+mask | points). Returns:
//   pts        — target centres [[x,y,z],…]
//   tcat       — per-target category index
//   catDims    — per-category block dimensions [[dx,dy,dz],…] ([0,0,0] = point)
//   gridIndex  — original grid linear index per target (mask mode) or null
//   geom       — { grid } | { coords } for swath
function _targets(opts) {
  if (opts.points) {
    const p0 = opts.points, n = p0.length;
    const pts = p0.map((p) => [p[0], p[1], p[2]]);
    let catDims, tcat;
    if (opts.dimCategories && opts.cats) {              // explicit categories
      catDims = opts.dimCategories.map((d) => [d[0], d[1], d[2]]);
      tcat = opts.cats;
    } else if (p0[0].length >= 6) {                     // per-point dims → auto-categorize
      catDims = []; tcat = new Array(n);
      const key2cat = new Map();
      for (let i = 0; i < n; i++) {
        const key = p0[i][3] + ',' + p0[i][4] + ',' + p0[i][5];
        let c = key2cat.get(key);
        if (c == null) { c = catDims.length; key2cat.set(key, c); catDims.push([p0[i][3], p0[i][4], p0[i][5]]); }
        tcat[i] = c;
      }
    } else {                                            // shared block size (default point)
      const bs = opts.blockSize || [0, 0, 0];
      catDims = [[bs[0], bs[1], bs[2]]];
      tcat = new Array(n).fill(0);
    }
    return { pts, tcat, catDims, gridIndex: null, geom: { coords: pts } };
  }
  if (opts.grid) {
    const g = opts.grid;
    const nz = g.nz || 1, xsiz = g.xsiz || 1, ysiz = g.ysiz || 1, zsiz = g.zsiz || 1;
    const xmn = g.xmn != null ? g.xmn : xsiz / 2, ymn = g.ymn != null ? g.ymn : ysiz / 2, zmn = g.zmn != null ? g.zmn : zsiz / 2;
    const gg = { ...g, nz, xsiz, ysiz, zsiz, xmn, ymn, zmn };
    const catDims = [[xsiz, ysiz, zsiz]];
    if (opts.mask) {
      const m = opts.mask;
      const active = typeof m === 'function' ? m : (ix, iy, iz, x, y, z, idx) => !!m[idx];
      const pts = [], gridIndex = [];
      let idx = 0;
      for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++, idx++) {
        const x = xmn + ix * xsiz, y = ymn + iy * ysiz, z = zmn + iz * zsiz;
        if (active(ix, iy, iz, x, y, z, idx)) { pts.push([x, y, z]); gridIndex.push(idx); }
      }
      return { pts, tcat: new Array(pts.length).fill(0), catDims, gridIndex: Int32Array.from(gridIndex), geom: { coords: pts } };
    }
    const pts = [];
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) pts.push([xmn + ix * xsiz, ymn + iy * ysiz, zmn + iz * zsiz]);
    return { pts, tcat: new Array(pts.length).fill(0), catDims, gridIndex: null, geom: { grid: gg } };
  }
  throw new Error('gsjs.krige: provide points or grid');
}

// krige(opts) — kriging over a neighbourhood, in pure JS.
//   { data: [[x,y,z,value],...], variogram, search, ktype:'OK'|'SK', skmean?,
//     points | grid, discretization?:{nx,ny,nz}, blockSize?:[dx,dy,dz], faithful?, holeId? }
// discretization (+ block size from `grid` or `blockSize`) switches to block
// kriging; omitted → point kriging.
// `search` is the neighbourhood spec (radius/anis/angles/ndmin/ndmax + any policy:
// sectors / perHoleMax / minSampleDistance / convention / type:'bench'…). Returns a
// BlockEstimateTensor (indices in ORIGINAL data order; values = original data values)
// — feed straight to realize().
// Assemble + solve ONE kriging system for a chosen sample set (the shared core of
// krige() and crossValidate()). `ranks` are the selected sample indices into `data`;
// `discOff` is the block discretization (centre-relative offsets, [[0,0,0]] for point
// support) and `cbb` its block-block covariance. Returns the per-target record
// (status / na / ranks / weights / kv / dists? / diag?). cova/c0/cmax/mdt come from
// the caller's model so this stays allocation-only per target.
function _solveTarget(data, ranks, na, tx, ty, tz, discOff, cbb, cova, c0, cmax, mdt, wantDist, wantDiag) {
  const ndb = discOff.length;
  const neq = mdt + na;
  const A = new Float64Array(neq * neq);
  const r = new Float64Array(neq);
  const dists = wantDist ? new Float64Array(na) : null;
  for (let i = 0; i < na; i++) {
    const si = ranks[i], xi = data[si][0], yi = data[si][1], zi = data[si][2];
    if (wantDist) { const dx = xi - tx, dy = yi - ty, dz = zi - tz; dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz); }
    for (let j = i; j < na; j++) {
      const sj = ranks[j];
      const cov = cova(xi, yi, zi, data[sj][0], data[sj][1], data[sj][2]);
      A[i * neq + j] = cov; A[j * neq + i] = cov;
    }
    // RHS: sample-to-block average covariance (point support → single centre point)
    if (ndb <= 1) {
      r[i] = cova(xi, yi, zi, tx, ty, tz);
    } else {
      let cb = 0;
      for (let d = 0; d < ndb; d++) {
        const dxp = tx + discOff[d][0], dyp = ty + discOff[d][1], dzp = tz + discOff[d][2];
        cb += cova(xi, yi, zi, dxp, dyp, dzp);
        const ex = xi - dxp, ey = yi - dyp, ez = zi - dzp;
        if (ex * ex + ey * ey + ez * ez < 1e-6) cb -= c0;   // self-correction (nugget)
      }
      r[i] = cb / ndb;
    }
  }
  if (mdt) { for (let i = 0; i < na; i++) { A[na * neq + i] = cmax; A[i * neq + na] = cmax; } r[na] = cmax; }

  const { x: sol, singular } = solveGE(A, r, neq);
  if (singular) return { status: STATUS.SINGULAR_SYSTEM, na: 0 };
  let estv = cbb;                                     // block-block covariance
  for (let j = 0; j < neq; j++) estv -= sol[j] * r[j];

  // QKNA diagnostics (cheap — from the weights + the system already built):
  //   SR = Σλr / ΣΣλλC  (slope of regression; =1 for SK, ≤1 for OK = conditional bias)
  //   KE = 1 − kv/cbb    (kriging efficiency; cbb = block variance)
  //   WM = 1 − Σλ (weight to the mean) · NW = 100/na · Σ|λ⁻| (% negative-weight magnitude)
  let diag;
  if (wantDiag) {
    let sumLR = 0, sumW = 0, negW = 0;
    for (let i = 0; i < na; i++) { sumLR += sol[i] * r[i]; sumW += sol[i]; if (sol[i] < 0) negW -= sol[i]; }
    let quad = 0;
    for (let i = 0; i < na; i++) { const li = sol[i]; for (let j = 0; j < na; j++) quad += li * sol[j] * A[i * neq + j]; }
    diag = { slope: quad !== 0 ? sumLR / quad : 1, ke: cbb !== 0 ? 1 - estv / cbb : 0, weightMean: 1 - sumW, negWeights: 100 * negW / na };
  }
  return { status: STATUS.OK, na, ranks, weights: sol, kv: estv, dists, diag };
}

function krige(opts) {
  const data = opts.data;
  const nd = data.length;
  const ktype = opts.ktype === 'SK' ? 0 : 1;            // 0 = SK, 1 = OK
  const mdt = ktype === 1 ? 1 : 0;
  const skmean = opts.skmean || 0;
  const wantDist = !!opts.distances;
  const wantDiag = !!opts.diagnostics;
  const pi = opts.faithful ? GSLIB_PI : Math.PI;
  const { cmax, cova, c0 } = buildModel(opts.variogram, pi);

  const disc = opts.discretization || {};
  const nxdis = disc.nx || 1, nydis = disc.ny || 1, nzdis = disc.nz || 1;

  const s = opts.search;
  const nbhd = createNeighborhood({
    radius: s.radius, radiusMinor: s.radiusMinor, radiusVert: s.radiusVert,
    angle: s.angle, angle2: s.angle2, angle3: s.angle3,
    convention: s.convention, dip: s.dip, dipAzimuth: s.dipAzimuth, pitch: s.pitch, rake: s.rake, azimuth: s.azimuth,
    ndmin: s.ndmin, ndmax: s.ndmax, sectors: s.sectors,
    perHoleMax: s.perHoleMax, minSampleDistance: s.minSampleDistance,
    type: s.type, benchThickness: s.benchThickness, faithful: opts.faithful,
  });
  indexSamples(nbhd, data, (row, k) => row[k], { holeId: opts.holeId });

  const { pts, tcat, catDims, geom, gridIndex } = _targets(opts);
  const ntarg = pts.length;
  const ncat = catDims.length;

  // disc-point offsets + block-block cbb are GEOMETRY-only → memoized per category
  // (shared = 1, sub-blocked = K, unique = N), so cost scales with distinct shapes.
  const catDiscOff = new Array(ncat), catCbb = new Array(ncat);
  for (let c = 0; c < ncat; c++) {
    const [dx, dy, dz] = catDims[c];
    const off = (dx > 0 || dy > 0 || dz > 0) ? discr(dx, dy, dz, nxdis, nydis, nzdis) : [[0, 0, 0]];
    catDiscOff[c] = off;
    let cbb = cmax;
    if (off.length > 1) {
      let acc = 0;
      for (let i = 0; i < off.length; i++) for (let j = 0; j < off.length; j++) {
        let cov = cova(off[i][0], off[i][1], off[i][2], off[j][0], off[j][1], off[j][2]);
        if (i === j) cov -= c0;
        acc += cov;
      }
      cbb = acc / (off.length * off.length);
    }
    catCbb[c] = cbb;
  }

  // per-target solve, collected then packed to a fixed stride K = max retained.
  const perTarget = new Array(ntarg);
  let K = 1;
  for (let t = 0; t < ntarg; t++) {
    const tx = pts[t][0], ty = pts[t][1], tz = pts[t][2];
    const sel = select(nbhd, [tx, ty, tz]);
    if (sel.status !== STATUS.OK) { perTarget[t] = { status: sel.status, na: 0 }; continue; }
    const discOff = catDiscOff[tcat[t]], cbb = catCbb[tcat[t]];
    const p = _solveTarget(data, sel.ranks, sel.n, tx, ty, tz, discOff, cbb, cova, c0, cmax, mdt, wantDist, wantDiag);
    perTarget[t] = p;
    if (p.na > K) K = p.na;
  }

  // pack to the BlockEstimateTensor (padded to K).
  const indices = new Int32Array(ntarg * K);
  const weights = new Float64Array(ntarg * K);
  const n_actual = new Int32Array(ntarg);
  const kv = new Float64Array(ntarg);
  const status = new Uint8Array(ntarg).fill(STATUS.NOT_ATTEMPTED);
  const distances = wantDist ? new Float64Array(ntarg * K) : null;
  // QKNA diagnostics — one scalar per target (NaN where not OK), opt-in via opts.diagnostics
  const diagnostics = wantDiag
    ? { slope: new Float64Array(ntarg).fill(NaN), ke: new Float64Array(ntarg).fill(NaN), weightMean: new Float64Array(ntarg).fill(NaN), negWeights: new Float64Array(ntarg).fill(NaN) }
    : null;
  for (let t = 0; t < ntarg; t++) {
    const p = perTarget[t];
    status[t] = p.status;
    if (p.status !== STATUS.OK) continue;
    n_actual[t] = p.na; kv[t] = p.kv;
    for (let k = 0; k < p.na; k++) { indices[t * K + k] = p.ranks[k]; weights[t * K + k] = p.weights[k]; }
    if (wantDist) for (let k = 0; k < p.na; k++) distances[t * K + k] = p.dists[k];
    if (wantDiag && p.diag) { diagnostics.slope[t] = p.diag.slope; diagnostics.ke[t] = p.diag.ke; diagnostics.weightMean[t] = p.diag.weightMean; diagnostics.negWeights[t] = p.diag.negWeights; }
  }

  return {
    indices, weights, n_actual, kv, status,
    distances, diagnostics,
    sk_mean: ktype === 0 ? skmean : null,
    values: Float64Array.from(data, (d) => d[3]),       // ORIGINAL order — indices reference this
    coords: pts, gridIndex, geom, K,
    n_targets: ntarg, n_blocks: ntarg, n_categories: ncat,
  };
}

// Summarize QKNA diagnostics over the OK targets of a kriged result. Accepts a
// krige() tensor (carrying `.diagnostics`, from `diagnostics: true`) or a recipe
// estimate() result (`.domains[].tensor`). Returns domain-pooled means plus the
// share of conditionally-biased blocks (slope < 0.95 = the conventional cutoff).
function qknaSummary(result) {
  const tensors = result && result.domains ? result.domains.map((d) => d.tensor).filter(Boolean) : [result];
  let n = 0, sSlope = 0, sKE = 0, sNeg = 0, below = 0, minSlope = Infinity, maxNeg = 0;
  for (const t of tensors) {
    if (!t || !t.diagnostics) continue;
    const { slope, ke, negWeights } = t.diagnostics;
    for (let i = 0; i < t.n_blocks; i++) {
      if (t.status[i] !== STATUS.OK) continue;
      n++; sSlope += slope[i]; sKE += ke[i]; sNeg += negWeights[i];
      if (slope[i] < 0.95) below++;
      if (slope[i] < minSlope) minSlope = slope[i];
      if (negWeights[i] > maxNeg) maxNeg = negWeights[i];
    }
  }
  if (!n) return { n: 0, meanSlope: NaN, meanKE: NaN, meanNegWeights: NaN, pctSlopeBelow95: NaN, minSlope: NaN, maxNegWeights: NaN };
  return {
    n,
    meanSlope: sSlope / n,
    meanKE: sKE / n,
    meanNegWeights: sNeg / n,
    pctSlopeBelow95: 100 * below / n,
    minSlope,
    maxNegWeights: maxNeg,
  };
}

// crossValidate(opts) — leave-one-out cross-validation. Re-estimates each datum's
// location from the OTHER data (the sample itself always excluded; its whole hole
// too with `sameHole: true` + `holeId`), on POINT support, then scores estimate vs
// measured value. Same model inputs as krige() (data / variogram / search / ktype /
// skmean? / orientation / sectors / perHoleMax / …). Returns per-sample arrays plus
// a `summary` of the standard CV diagnostics:
//   meanError ≈ 0 (unbiased) · rmse (accuracy) · meanStdError ≈ 0 & varStdError ≈ 1
//   (the variogram/KV is well-calibrated) · slope/corr of the true-vs-estimate scatter.
function crossValidate(opts) {
  const data = opts.data;
  const n = data.length;
  const ktype = opts.ktype === 'SK' ? 0 : 1;
  const mdt = ktype === 1 ? 1 : 0;
  const skmean = opts.skmean || 0;
  const pi = opts.faithful ? GSLIB_PI : Math.PI;
  const { cmax, cova, c0 } = buildModel(opts.variogram, pi);
  const discOff = [[0, 0, 0]], cbb = cmax;             // LOO is point-support

  const s = opts.search;
  const nbhd = createNeighborhood({
    radius: s.radius, radiusMinor: s.radiusMinor, radiusVert: s.radiusVert,
    angle: s.angle, angle2: s.angle2, angle3: s.angle3,
    convention: s.convention, dip: s.dip, dipAzimuth: s.dipAzimuth, pitch: s.pitch, rake: s.rake, azimuth: s.azimuth,
    ndmin: s.ndmin, ndmax: s.ndmax, sectors: s.sectors,
    perHoleMax: s.perHoleMax, minSampleDistance: s.minSampleDistance,
    type: s.type, benchThickness: s.benchThickness, faithful: opts.faithful,
  });
  const holeId = opts.holeId || null;
  indexSamples(nbhd, data, (row, k) => row[k], { holeId });
  const sameHole = !!opts.sameHole;
  if (sameHole && !holeId) throw new Error('gsjs.crossValidate: sameHole needs holeId');

  const estimate = new Float64Array(n).fill(NaN);
  const actual = Float64Array.from(data, (d) => d[3]);
  const error = new Float64Array(n).fill(NaN);
  const stderr = new Float64Array(n).fill(NaN);
  const kvOut = new Float64Array(n).fill(NaN);
  const status = new Uint8Array(n).fill(STATUS.NOT_ATTEMPTED);

  for (let i = 0; i < n; i++) {
    const tx = data[i][0], ty = data[i][1], tz = data[i][2];
    const exclude = sameHole ? (j) => j === i || holeId[j] === holeId[i] : (j) => j === i;
    const sel = select(nbhd, [tx, ty, tz], { exclude });
    if (sel.status !== STATUS.OK) { status[i] = sel.status; continue; }
    const p = _solveTarget(data, sel.ranks, sel.n, tx, ty, tz, discOff, cbb, cova, c0, cmax, mdt, false, false);
    status[i] = p.status;
    if (p.status !== STATUS.OK) continue;
    let est = 0, sw = 0;
    for (let k = 0; k < p.na; k++) { est += p.weights[k] * data[p.ranks[k]][3]; sw += p.weights[k]; }
    if (ktype === 0) est += (1 - sw) * skmean;          // SK: weight on the mean
    estimate[i] = est; kvOut[i] = p.kv;
    error[i] = est - actual[i];
    stderr[i] = p.kv > 0 ? error[i] / Math.sqrt(p.kv) : NaN;
  }

  return { n, estimate, actual, error, stderr, kv: kvOut, status, summary: _cvSummary(estimate, actual, error, stderr, status) };
}

// Standard LOO-CV scorecard over the OK samples. `slope`/`corr` are the EMPIRICAL
// regression of true-on-estimate (the CV scatterplot), distinct from QKNA's
// theoretical slope. meanStdError≈0 & varStdError≈1 validate the variogram/KV.
function _cvSummary(estimate, actual, error, stderr, status) {
  let nOk = 0, se = 0, sae = 0, sse = 0, sStd = 0, sStd2 = 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < status.length; i++) {
    if (status[i] !== STATUS.OK) continue;
    nOk++;
    const e = error[i];
    se += e; sae += Math.abs(e); sse += e * e;
    if (Number.isFinite(stderr[i])) { sStd += stderr[i]; sStd2 += stderr[i] * stderr[i]; }
    const x = estimate[i], y = actual[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  if (!nOk) return { nOk: 0, meanError: NaN, meanAbsError: NaN, mse: NaN, rmse: NaN, meanStdError: NaN, varStdError: NaN, slope: NaN, corr: NaN };
  const meanError = se / nOk, mse = sse / nOk;
  const meanStd = sStd / nOk, varStd = sStd2 / nOk - meanStd * meanStd;
  const mx = sx / nOk, my = sy / nOk;
  const covxy = sxy / nOk - mx * my, varx = sxx / nOk - mx * mx, vary = syy / nOk - my * my;
  return {
    nOk, meanError, meanAbsError: sae / nOk, mse, rmse: Math.sqrt(mse),
    meanStdError: meanStd, varStdError: varStd,
    slope: varx > 0 ? covxy / varx : NaN,
    corr: (varx > 0 && vary > 0) ? covxy / Math.sqrt(varx * vary) : NaN,
  };
}

// ── src/decluster.js ──

// @gcu/gsjs — cell declustering (GSLIB `declus`). Spatial sampling is rarely
// representative: high-grade zones get drilled out densely, so a NAIVE mean over the
// samples over-weights them. Cell declustering lays a regular grid of cells over the
// data and down-weights samples sharing a cell — a sample in a crowded cell counts
// less. The weights then de-bias any global statistic (mean, histogram, variance).
//
// Algorithm (Deutsch & Journel, GSLIB declus): for a cell size, assign each sample to
// a cell; a sample's weight ∝ 1/(samples in its cell), normalized so Σw = n. The
// declustered mean is then the average of the per-cell mean grades. The grid ORIGIN
// matters at coarse cell sizes (a sample near a boundary lands in different cells
// under different origins), so we AVERAGE the weights over `nOffsets`³ origin shifts.
// A SWEEP over cell sizes traces the declustered mean vs cell size; the representative
// size is the curve's extremum (min for high-grade-clustered data — the usual case).
//
// Zero imports — cell assignment is O(n) integer bucketing, no kd-tree. Inputs are
// the same [x,y,z,value] rows krige() takes (extra columns ignored).

// Bounding box of the data coords.
function _bbox(data) {
  let xmn = Infinity, ymn = Infinity, zmn = Infinity, xmx = -Infinity, ymx = -Infinity, zmx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const x = data[i][0], y = data[i][1], z = data[i][2];
    if (x < xmn) xmn = x; if (x > xmx) xmx = x;
    if (y < ymn) ymn = y; if (y > ymx) ymx = y;
    if (z < zmn) zmn = z; if (z > zmx) zmx = z;
  }
  return { xmn, ymn, zmn, xmx, ymx, zmx };
}

// Resolve a cell-size argument to [dx, dy, dz]. A number is isotropic × anisotropy
// ratios [ay, az]; an array is taken verbatim. A zero dim means "no cells on this
// axis" → collapsed to one slab (handles 2D / single-bench data).
function _cellDims(cellSize, anisotropy) {
  if (Array.isArray(cellSize)) return [cellSize[0], cellSize[1], cellSize[2] != null ? cellSize[2] : cellSize[0]];
  const ay = anisotropy && anisotropy[0] != null ? anisotropy[0] : 1;
  const az = anisotropy && anisotropy[1] != null ? anisotropy[1] : 1;
  return [cellSize, cellSize * ay, cellSize * az];
}

// Per-sample weights for ONE cell size, averaged over the origin offsets. Weights sum
// to n. Returns { weights, nOccupied } where nOccupied is the offset-averaged count of
// occupied cells (a clustering diagnostic). Degenerate dims (range 0, or dim ≤ 0) put
// every sample in one cell on that axis.
function declusterWeights(data, cellSize, opts = {}) {
  const n = data.length;
  const anisotropy = opts.anisotropy;
  const nOff = opts.nOffsets != null ? opts.nOffsets : 4;
  if (!(nOff >= 1)) throw new Error('gsjs.decluster: nOffsets must be ≥ 1');
  const [dx, dy, dz] = _cellDims(cellSize, anisotropy);
  if (!(dx >= 0 && dy >= 0 && dz >= 0)) throw new Error('gsjs.decluster: cell dims must be ≥ 0');
  const bb = _bbox(data);

  // axes with a positive cell dim AND nonzero data range are gridded; others collapse
  const useX = dx > 0 && bb.xmx > bb.xmn, useY = dy > 0 && bb.ymx > bb.ymn, useZ = dz > 0 && bb.zmx > bb.zmn;
  const weights = new Float64Array(n);
  let nOccAcc = 0, nOffActual = 0;

  // sweep the grid origin across [-dim, 0) in nOff steps per active axis, so a sample
  // near a cell wall is binned both ways and the artifact averages out.
  const offXs = useX ? nOff : 1, offYs = useY ? nOff : 1, offZs = useZ ? nOff : 1;
  const counts = new Map();
  const keyOf = new Int32Array(n * 3);
  for (let ox = 0; ox < offXs; ox++) for (let oy = 0; oy < offYs; oy++) for (let oz = 0; oz < offZs; oz++) {
    const sx = useX ? bb.xmn - dx * (ox / nOff) : 0;
    const sy = useY ? bb.ymn - dy * (oy / nOff) : 0;
    const sz = useZ ? bb.zmn - dz * (oz / nOff) : 0;
    counts.clear();
    for (let i = 0; i < n; i++) {
      const cx = useX ? Math.floor((data[i][0] - sx) / dx) : 0;
      const cy = useY ? Math.floor((data[i][1] - sy) / dy) : 0;
      const cz = useZ ? Math.floor((data[i][2] - sz) / dz) : 0;
      keyOf[i * 3] = cx; keyOf[i * 3 + 1] = cy; keyOf[i * 3 + 2] = cz;
      const k = cx + ',' + cy + ',' + cz;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const nOcc = counts.size;
    nOccAcc += nOcc; nOffActual++;
    // weight ∝ 1/count, scaled so Σ = n: w_i = (n/nOcc)·(1/count_i)  [Σ 1/count = nOcc]
    const scale = n / nOcc;
    for (let i = 0; i < n; i++) {
      const k = keyOf[i * 3] + ',' + keyOf[i * 3 + 1] + ',' + keyOf[i * 3 + 2];
      weights[i] += scale / counts.get(k);
    }
  }
  for (let i = 0; i < n; i++) weights[i] /= nOffActual;   // average over offsets (already Σ=n each)
  return { weights, nOccupied: nOccAcc / nOffActual };
}

// Weighted mean / variance of the sample VALUES under given weights (the 4th column).
// Variance is the weight-frequency form Σw(z−μ)²/Σw.
function _weightedStats(data, weights) {
  let sw = 0, swz = 0;
  for (let i = 0; i < data.length; i++) { sw += weights[i]; swz += weights[i] * data[i][3]; }
  const mean = sw > 0 ? swz / sw : NaN;
  let swd = 0;
  for (let i = 0; i < data.length; i++) { const d = data[i][3] - mean; swd += weights[i] * d * d; }
  const variance = sw > 0 ? swd / sw : NaN;
  return { mean, variance, std: Math.sqrt(variance) };
}

// declusterCell({ data, cellSize, anisotropy?, nOffsets? }) — declustering at ONE cell
// size. Returns the weights (Σ = n) + the declustered vs naive statistics.
function declusterCell(opts) {
  const data = opts.data;
  const { weights, nOccupied } = declusterWeights(data, opts.cellSize, opts);
  const dec = _weightedStats(data, weights);
  const naive = _weightedStats(data, new Float64Array(data.length).fill(1));
  return {
    weights, nOccupied,
    cellSize: opts.cellSize,
    mean: dec.mean, variance: dec.variance, std: dec.std,
    naiveMean: naive.mean, naiveVariance: naive.variance, naiveStd: naive.std,
  };
}

// declusterSweep({ data, sizes, anisotropy?, nOffsets?, pick? }) — sweep the cell size
// and trace the declustered mean. `pick`: 'min' (default — high-grade-clustered data,
// the usual mining case) | 'max' (low-grade-clustered). Returns the curve + the chosen
// `best` (its cell size, mean, and weights — ready to feed a weighted histogram).
function declusterSweep(opts) {
  const data = opts.data;
  const sizes = opts.sizes;
  if (!Array.isArray(sizes) || !sizes.length) throw new Error('gsjs.declusterSweep: sizes[] required');
  const pick = opts.pick || 'min';
  if (pick !== 'min' && pick !== 'max') throw new Error("gsjs.declusterSweep: pick must be 'min' or 'max'");
  const naive = _weightedStats(data, new Float64Array(data.length).fill(1));

  const means = new Float64Array(sizes.length);
  const nOcc = new Float64Array(sizes.length);
  let bestI = -1;
  for (let s = 0; s < sizes.length; s++) {
    const { weights, nOccupied } = declusterWeights(data, sizes[s], opts);
    const m = _weightedStats(data, weights).mean;
    means[s] = m; nOcc[s] = nOccupied;
    if (bestI < 0 || (pick === 'min' ? m < means[bestI] : m > means[bestI])) bestI = s;
  }
  const best = declusterCell({ ...opts, cellSize: sizes[bestI] });
  return { sizes, means, nOccupied: nOcc, naiveMean: naive.mean, best: { size: sizes[bestI], mean: means[bestI], weights: best.weights } };
}

// ── src/variogram.js ──

// @gcu/gsjs — experimental variography (the input to krige()'s variogram model).
//
// experimental(data, opts) computes the directional / downhole experimental
// semivariogram (and its relatives) over lag bins. It's a faithful port of GSLIB
// `gamv` (ext/gslib, the frozen oracle) — same pair loop, lag-tolerance binning,
// direction cosines, and per-`ivtype` finalizers — so it validates bit-for-bit
// against `gslib.gamv`. The ESTIMATOR is a pluggable reduction over the pair
// iteration (the hard part is gathering the pairs; the estimator just swaps the
// accumulator), so the whole menu costs almost nothing once the loop exists.
//
// `faithful: true` reproduces GSLIB's truncated π (3.14159265) for bit-identical
// parity; the default is accurate Math.PI (the krige() pattern — this is the modern
// library, the truncation is a 1990s Fortran artifact). The π only shifts direction-
// boundary membership by ~1e-9 rad, so for real-valued coordinates the two agree.

// inlined by build.js (the neigh.js pattern)

const GAMV_PI = 3.14159265;   // GSLIB gamv's literal (distinct from setrot's 3.141592654)

// ── estimators: a reduction over pairs. `contrib(vrh, vrt)` returns the per-pair
// gam increment (or null to SKIP the pair — pairwise/log guard near zero), and
// `finalize(g, hm, tm, hv, tv, np)` turns the accumulated MEANS into γ. `hv`/`tv`
// (head/tail second moments) are only accumulated when `moments` is set. Names +
// formulas track GSLIB `gamv` ivtypes where one exists (oracle in parens). ──
const SQRT = Math.sqrt, ABS = Math.abs, LN = Math.log;
const ESTIMATORS = {
  matheron:         { contrib: (h, t) => (h - t) * (h - t),                                   finalize: (g) => 0.5 * g },                                                   // ivtype 1
  madogram:         { contrib: (h, t) => ABS(h - t),                                          finalize: (g) => 0.5 * g },                                                   // ivtype 8
  covariance:       { contrib: (h, t) => h * t,                                               finalize: (g, hm, tm) => g - hm * tm },                                       // ivtype 3
  correlogram:      { contrib: (h, t) => h * t, moments: true,                                finalize: (g, hm, tm, hv, tv) => { const sh = SQRT(Math.max(hv - hm * hm, 0)), st = SQRT(Math.max(tv - tm * tm, 0)); return sh * st < 1e-10 ? 0 : (g - hm * tm) / (sh * st); } }, // ivtype 4
  generalRelative:  { contrib: (h, t) => (h - t) * (h - t),                                   finalize: (g, hm, tm) => { const a = 0.5 * (hm + tm); const a2 = a * a; return a2 < 1e-10 ? 0 : g / a2; } }, // ivtype 5
  pairwiseRelative: { contrib: (h, t) => (ABS(t + h) > 1e-10 ? (2 * (t - h) / (t + h)) ** 2 : null), finalize: (g) => 0.5 * g },                                            // ivtype 6
  logVariogram:     { contrib: (h, t) => (t > 1e-10 && h > 1e-10 ? (LN(t) - LN(h)) ** 2 : null),     finalize: (g) => 0.5 * g },                                            // ivtype 7
  // robust extras — no gamv oracle (hand-fixture validated):
  cressie:          { contrib: (h, t) => SQRT(ABS(h - t)),                                    finalize: (g, hm, tm, hv, tv, np) => 0.5 * (g ** 4) / (0.457 + 0.494 / np + 0.045 / (np * np)) }, // Cressie-Hawkins
  rodogram:         { contrib: (h, t) => SQRT(ABS(h - t)),                                    finalize: (g) => 0.5 * g },
};

// Resolve a direction spec to the precomputed unit vectors + tolerances gamv uses.
// `mode: 'downhole'` → omnidirectional + same-hole filter (closest-spaced, the nugget
// direction). Otherwise { azimuth, dip, atol, dtol, bandwidthH, bandwidthV }.
function _resolveDir(d, DEG) {
  const downhole = d.mode === 'downhole';
  const azm = downhole ? 0 : (d.azimuth || 0);
  const dip = downhole ? 0 : (d.dip || 0);
  const atol = downhole ? 90 : (d.atol != null ? d.atol : 90);
  const dtol = downhole ? 90 : (d.dtol != null ? d.dtol : 90);
  const azmuth = (90 - azm) * DEG, declin = (90 - dip) * DEG;
  return {
    name: d.name || (downhole ? 'downhole' : `az${azm}_dip${dip}`),
    sameHole: downhole,
    uvxazm: Math.cos(azmuth), uvyazm: Math.sin(azmuth),
    uvzdec: Math.cos(declin), uvhdec: Math.sin(declin),
    csatol: Math.cos((atol <= 0 ? 45 : atol) * DEG),
    csdtol: Math.cos((dtol <= 0 ? 45 : dtol) * DEG),
    bandwh: d.bandwidthH != null ? d.bandwidthH : 1e21,
    bandwd: d.bandwidthV != null ? d.bandwidthV : 1e21,
    omni: atol >= 90,
    azm, dip,
  };
}

// experimental(data, opts) — data: [[x, y, z, value], ...] (or [[x, y, value], ...]).
//   opts = {
//     holeId,                              // parallel array (drillhole BHID) — for downhole dirs
//     lags: { size, n, tolerance? },       // global lag binning (tolerance defaults size/2)
//     directions: [ {name, azimuth, dip, atol?, dtol?, bandwidthH?, bandwidthV?}
//                 | {name?, mode:'downhole'} ],
//     estimator: 'matheron',               // any key of ESTIMATORS
//     trim: { min?, max? }, faithful?
//   }
// Returns { estimator, directions: [{ name, azm, dip, lags: [{ h, gamma, npair, hm, tm }] }] }
//   where lags is indexed by GSLIB lag bin (0 = coincident; il≥1 centred at (il−1)·size).
function experimental(data, opts) {
  const nd = data.length;
  const is3d = data[0] && data[0].length > 3;
  const X = new Float64Array(nd), Y = new Float64Array(nd), Z = new Float64Array(nd), V = new Float64Array(nd);
  for (let i = 0; i < nd; i++) {
    const d = data[i];
    X[i] = d[0]; Y[i] = d[1];
    if (is3d) { Z[i] = d[2]; V[i] = d[3]; } else { Z[i] = 0; V[i] = d[2]; }
  }
  const holeId = opts.holeId || null;

  const L = opts.lags || {};
  const xlag = L.size, nlag = L.n;
  const xltol = L.tolerance != null && L.tolerance > 0 ? L.tolerance : 0.5 * xlag;
  const nlp2 = nlag + 2;
  const dismxs = ((nlag + 0.5 - 1e-10) * xlag) ** 2;

  const est = ESTIMATORS[opts.estimator || 'matheron'];
  if (!est) throw new Error(`gsjs.experimental: unknown estimator '${opts.estimator}'`);
  const wantMoments = !!est.moments;

  const trim = opts.trim || {};
  const tmin = trim.min != null ? trim.min : -1e21;
  const tmax = trim.max != null ? trim.max : 1e21;
  const DEG = (opts.faithful ? GAMV_PI : Math.PI) / 180;

  const dirSpecs = opts.directions || [{ azimuth: 0, atol: 90 }];
  const dirs = dirSpecs.map((d) => _resolveDir(d, DEG));
  const ndir = dirs.length;
  if (dirs.some((d) => d.sameHole) && !holeId) throw new Error('gsjs.experimental: downhole direction needs opts.holeId');

  // accumulators per [dir][lag]: np, dis, gam, hm, tm, hv, tv
  const sz = ndir * nlp2;
  const np = new Float64Array(sz), dis = new Float64Array(sz), gam = new Float64Array(sz);
  const hm = new Float64Array(sz), tm = new Float64Array(sz), hv = new Float64Array(sz), tv = new Float64Array(sz);
  const contrib = est.contrib;

  for (let i = 0; i < nd; i++) {
    for (let j = i; j < nd; j++) {
      const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i];
      const dxs = dx * dx, dys = dy * dy, dzs = dz * dz;
      let hsq = dxs + dys + dzs;
      if (hsq > dismxs) continue;
      if (hsq < 0) hsq = 0;
      const h = SQRT(hsq);

      // lag bins (overlapping when xltol > xlag/2): coincident → 0, else centred at (il−1)·xlag
      let lagbeg = -1, lagend = -1;
      if (h <= 1e-10) { lagbeg = 0; lagend = 0; }
      else {
        for (let il = 1; il < nlp2; il++) {
          const c = xlag * (il - 1);
          if (h >= c - xltol && h <= c + xltol) { if (lagbeg < 0) lagbeg = il; lagend = il; }
        }
      }
      if (lagend < 0) continue;

      for (let id = 0; id < ndir; id++) {
        const D = dirs[id];
        if (D.sameHole && holeId[i] !== holeId[j]) continue;

        let dxy = SQRT(Math.max(dxs + dys, 0));
        const dcazm = dxy < 1e-10 ? 1 : (dx * D.uvxazm + dy * D.uvyazm) / dxy;
        if (ABS(dcazm) < D.csatol) continue;
        if (ABS(D.uvxazm * dy - D.uvyazm * dx) > D.bandwh) continue;       // horizontal bandwidth
        if (dcazm < 0) dxy = -dxy;
        const dcdec = lagbeg === 0 ? 0 : (dxy * D.uvhdec + dz * D.uvzdec) / h;
        if (!(lagbeg === 0 || ABS(dcdec) >= D.csdtol)) continue;
        if (ABS(D.uvhdec * dz - D.uvzdec * dxy) > D.bandwd) continue;       // vertical bandwidth

        // tail/head by direction sign (symmetric estimators: only affects which mean is head/tail)
        let vrh, vrt, vrhpr, vrtpr;
        if (dcazm >= 0 && dcdec >= 0) { vrh = V[i]; vrt = V[j]; vrtpr = V[i]; vrhpr = V[j]; }
        else { vrh = V[j]; vrt = V[i]; vrtpr = V[j]; vrhpr = V[i]; }
        if (vrt < tmin || vrh < tmin || vrt > tmax || vrh > tmax) continue;

        const g0 = contrib(vrh, vrt);
        const g1 = D.omni ? contrib(vrhpr, vrtpr) : undefined;
        for (let il = lagbeg; il <= lagend; il++) {
          const ii = id * nlp2 + il;
          if (g0 != null) {
            np[ii] += 1; dis[ii] += h; hm[ii] += vrh; tm[ii] += vrt; gam[ii] += g0;
            if (wantMoments) { hv[ii] += vrh * vrh; tv[ii] += vrt * vrt; }
          }
          if (D.omni && g1 != null) {
            np[ii] += 1; dis[ii] += h; hm[ii] += vrhpr; tm[ii] += vrtpr; gam[ii] += g1;
            if (wantMoments) { hv[ii] += vrhpr * vrhpr; tv[ii] += vrtpr * vrtpr; }
          }
        }
      }
    }
  }

  // finalize: means then the estimator's γ
  const out = [];
  const fin = est.finalize;
  for (let id = 0; id < ndir; id++) {
    const lags = [];
    for (let il = 0; il < nlp2; il++) {
      const ii = id * nlp2 + il, n = np[ii];
      if (n > 0) {
        const mh = hm[ii] / n, mt = tm[ii] / n, mhv = hv[ii] / n, mtv = tv[ii] / n;
        lags.push({ h: dis[ii] / n, gamma: fin(gam[ii] / n, mh, mt, mhv, mtv, n), npair: n, hm: mh, tm: mt });
      } else {
        lags.push({ h: 0, gamma: 0, npair: 0, hm: 0, tm: 0 });
      }
    }
    out.push({ name: dirs[id].name, azm: dirs[id].azm, dip: dirs[id].dip, lags });
  }
  return { estimator: opts.estimator || 'matheron', directions: out };
}

// ── the lag-vector volume — the precompute-once / sweep-cheap substrate (SPEC §2.2) ──
//
// A `lag-bin × direction-cell` grid of per-cell running SUMS (memory bounded by
// RESOLUTION, not N — pairs are consumed, never stored). Lag bins use the exact GSLIB
// binning (lag axis exact); direction cells are an azimuth×dip tessellation. Filled
// kd-tree-bounded (O(N·k), not O(N²)) and built for ONE estimator. It's a mergeable
// bounded accumulator (per-cell sums add → parallel/streaming free; the sluice pattern).
//
// buildLagVolume(data, opts) — opts as experimental()'s, plus { azBins=36, dipBins=18,
//   sameHoleOnly?, faithful? }. Returns an opaque volume (Float64Array cells + metadata).
const _ACC = 7;   // per cell: np, Σdist, Σγ-contrib, Σhead, Σtail, Σhead², Σtail²

function buildLagVolume(data, opts) {
  const nd = data.length, is3d = data[0] && data[0].length > 3;
  const X = new Float64Array(nd), Y = new Float64Array(nd), Z = new Float64Array(nd), V = new Float64Array(nd);
  for (let i = 0; i < nd; i++) { const d = data[i]; X[i] = d[0]; Y[i] = d[1]; if (is3d) { Z[i] = d[2]; V[i] = d[3]; } else { Z[i] = 0; V[i] = d[2]; } }
  const holeId = opts.holeId || null;
  const sameHole = !!opts.sameHoleOnly;
  if (sameHole && !holeId) throw new Error('gsjs.buildLagVolume: sameHoleOnly needs opts.holeId');

  const L = opts.lags || {};
  const xlag = L.size, nlag = L.n;
  const xltol = L.tolerance != null && L.tolerance > 0 ? L.tolerance : 0.5 * xlag;
  const nlb = nlag + 1;                                   // lag bins 0..nlag (centre lb·xlag), coincident dropped
  const maxlag = (nlag + 0.5) * xlag;                     // gather radius
  const nazi = opts.azBins || 36;
  const ndip = is3d ? (opts.dipBins || 18) : 1;
  const dcell = nazi * ndip;
  const est = ESTIMATORS[opts.estimator || 'matheron'];
  if (!est) throw new Error(`gsjs.buildLagVolume: unknown estimator '${opts.estimator}'`);
  const contrib = est.contrib, wantMoments = !!est.moments;

  const cells = new Float64Array(nlb * dcell * _ACC);
  const TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2;

  // kd-tree over raw coords (isotropic gather to maxlag, then exact distance/direction)
  const flat = new Float64Array(nd * 3);
  for (let i = 0; i < nd; i++) { flat[i * 3] = X[i]; flat[i * 3 + 1] = Y[i]; flat[i * 3 + 2] = Z[i]; }
  const tree = new KDTree({ data: flat, shape: [nd, 3] });
  const r = maxlag * (1 + 1e-9);

  for (let i = 0; i < nd; i++) {
    const nb = tree.query_ball_point([X[i], Y[i], Z[i]], r);
    for (let q = 0; q < nb.length; q++) {
      const j = nb[q];
      if (j <= i) continue;                                // each unordered pair once
      if (sameHole && holeId[i] !== holeId[j]) continue;
      const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i];
      const h = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (h <= 1e-10 || h > maxlag) continue;
      const g = contrib(V[i], V[j]);                       // all estimator contribs are symmetric in (h,t)
      if (g == null) continue;
      // accumulate SYMMETRICALLY (both orientations, as gamv omni does) so head/tail means are
      // symmetric → omni extraction is exact for the moment-using estimators (covariance/correlogram)
      // too, not just the difference-based ones.
      const vh = V[i], vt = V[j], sumV = vh + vt, sumV2 = vh * vh + vt * vt;
      const g2 = 2 * g, h2 = 2 * h;
      // direction cell (azimuth clockwise from N, dip above horizontal)
      const dxy = Math.sqrt(dx * dx + dy * dy);
      let azi = Math.atan2(dx, dy); if (azi < 0) azi += TWO_PI;
      const dip = Math.atan2(dz, dxy);
      let azb = (azi / (TWO_PI / nazi)) | 0; if (azb >= nazi) azb = nazi - 1;
      let dpb = ndip === 1 ? 0 : ((dip + HALF_PI) / (Math.PI / ndip)) | 0; if (dpb >= ndip) dpb = ndip - 1; if (dpb < 0) dpb = 0;
      const dc = dpb * nazi + azb;
      // exact GSLIB lag bins (overlapping when xltol > xlag/2)
      for (let lb = 0; lb < nlb; lb++) {
        if (Math.abs(h - lb * xlag) <= xltol) {
          const b = (lb * dcell + dc) * _ACC;
          cells[b] += 2; cells[b + 1] += h2; cells[b + 2] += g2; cells[b + 3] += sumV; cells[b + 4] += sumV;
          if (wantMoments) { cells[b + 5] += sumV2; cells[b + 6] += sumV2; }
        }
      }
    }
  }

  // per direction-cell centre unit vector (for the extraction cone)
  const dirVec = new Float64Array(dcell * 3);
  for (let dpb = 0; dpb < ndip; dpb++) for (let azb = 0; azb < nazi; azb++) {
    const ac = (azb + 0.5) * (TWO_PI / nazi);
    const dpc = ndip === 1 ? 0 : (-HALF_PI + (dpb + 0.5) * (Math.PI / ndip));
    const cd = Math.cos(dpc), k = (dpb * nazi + azb) * 3;
    dirVec[k] = Math.sin(ac) * cd; dirVec[k + 1] = Math.cos(ac) * cd; dirVec[k + 2] = Math.sin(dpc);
  }
  return { cells, nlb, dcell, nazi, ndip, xlag, nlag, estimator: opts.estimator || 'matheron', dirVec, is3d };
}

// directionalVariogram(volume, { azimuth, dip, atol, dtol }) — integrate the volume into a
// per-lag variogram using GSLIB gamv's selection (separate azimuth + dip wedges, NOT a single
// cone — so the sweep and the pinned exact value agree). OMNI (atol ≥ 90 & dtol ≥ 90) is exact
// (= experimental() omni γ; all cells, lag axis exact). Directional is the approximate live-
// sweep result (whole cells in/out) — converges with cell resolution; pin via experimental().
function directionalVariogram(vol, dir) {
  const { cells, nlb, dcell, xlag, estimator, dirVec } = vol;
  const est = ESTIMATORS[estimator], fin = est.finalize;
  const DEG = Math.PI / 180;
  const azm = dir.azimuth || 0, dip = dir.dip || 0;
  const atol = dir.atol != null ? dir.atol : 90, dtol = dir.dtol != null ? dir.dtol : 90;
  const azmuth = (90 - azm) * DEG, declin = (90 - dip) * DEG;
  const uvxazm = Math.cos(azmuth), uvyazm = Math.sin(azmuth), uvzdec = Math.cos(declin), uvhdec = Math.sin(declin);
  const csatol = Math.cos((atol <= 0 ? 45 : atol) * DEG), csdtol = Math.cos((dtol <= 0 ? 45 : dtol) * DEG);
  // qualify each direction cell by gamv's dcazm/dcdec wedge tests on its centre vector
  const qual = new Uint8Array(dcell);
  for (let c = 0; c < dcell; c++) {
    const cx = dirVec[c * 3], cy = dirVec[c * 3 + 1], cz = dirVec[c * 3 + 2];
    let dxy = Math.sqrt(cx * cx + cy * cy);
    const dcazm = dxy < 1e-10 ? 1 : (cx * uvxazm + cy * uvyazm) / dxy;
    if (Math.abs(dcazm) < csatol) continue;
    if (dcazm < 0) dxy = -dxy;
    const dcdec = dxy * uvhdec + cz * uvzdec;            // |centre| = 1
    if (Math.abs(dcdec) < csdtol) continue;
    qual[c] = 1;
  }

  const lags = [];
  for (let lb = 0; lb < nlb; lb++) {
    let np = 0, sd = 0, sg = 0, sh = 0, st = 0, shv = 0, stv = 0;
    for (let c = 0; c < dcell; c++) {
      if (!qual[c]) continue;
      const b = (lb * dcell + c) * _ACC, n = cells[b];
      if (n === 0) continue;
      np += n; sd += cells[b + 1]; sg += cells[b + 2]; sh += cells[b + 3]; st += cells[b + 4]; shv += cells[b + 5]; stv += cells[b + 6];
    }
    if (np > 0) { const mh = sh / np, mt = st / np; lags.push({ h: sd / np, gamma: fin(sg / np, mh, mt, shv / np, stv / np, np), npair: np }); }
    else lags.push({ h: lb * xlag, gamma: 0, npair: 0 });
  }
  return { lags };
}

// mergeLagVolumes(a, b) — sum two compatible volumes (the mergeable-accumulator contract:
// parallel/streaming fill produces partials that combine by adding per-cell sums).
function mergeLagVolumes(a, b) {
  if (a.cells.length !== b.cells.length || a.nlb !== b.nlb || a.dcell !== b.dcell) throw new Error('gsjs.mergeLagVolumes: incompatible volumes');
  const cells = new Float64Array(a.cells.length);
  for (let i = 0; i < cells.length; i++) cells[i] = a.cells[i] + b.cells[i];
  return { ...a, cells };
}

// ── ../sift/src/predicate.js ──

// @gcu/sift — predicate: a structured, safe boolean-expression spec for filters
// and cross-surface selections (the selection/linking contract §2).
//
// A predicate is plain JSON (structuredClone-transferable), evaluated by WALKING
// the tree — never eval / new Function — so any surface (even an untrusted one)
// can apply it over its own data. Users TYPE a JS-flavoured string; the emitter
// parses it to the spec; only the spec travels. Full-JS power lives in derived
// columns (owner-evaluated), not here — a user who needs `Math.log(x)` makes a
// derived boolean column and filters on it (a trivial, safe, travelling predicate).
//
// Extracted from strata (its filter engine) once plate became the second
// consumer — the predicate lib the selection/linking contract rests on. strata
// build-inlines this file (staying a self-contained leaf); plate consumes it
// (via strata's re-export); a notebook can load('@gcu/sift') directly. Zero-dep.
//
// Spec shapes:
//   Predicate = { form: 'spec', root: Expr }
//   Expr (boolean): {op:'and'|'or', args:Expr[]} · {op:'not', arg:Expr}
//     · {op:'=='|'!='|'<'|'<='|'>'|'>=', left:Term, right:Term}
//     · {op:'in'|'notin', left:Term, set:Lit[]} · {op:'between', arg:Term, lo:Term, hi:Term}
//     · {op:'isnull'|'notnull', arg:Term} · {op:'truthy', arg:Term}
//   Term (value): {col:string} · {lit:value} · {op:'+'|'-'|'*'|'/', left,right} · {op:'neg', arg}

const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ARITH = new Set(['+', '-', '*', '/']);
const BOOL_OPS = new Set([...COMPARE, 'and', 'or', 'not', 'in', 'notin', 'between', 'isnull', 'notnull', 'truthy']);

function isValueNode(n) {
  return n && (('col' in n) || ('lit' in n) || ARITH.has(n.op) || n.op === 'neg');
}
function isNullLit(n) { return n && ('lit' in n) && n.lit === null; }

// ── evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate a predicate against one row.
 * @param {object} pred  a Predicate ({form,root}) or a bare Expr
 * @param {(col:string)=>*} get  resolves a column name → the row's value
 * @returns {boolean}
 */
function evaluatePredicate(pred, get) {
  return _bool(pred && pred.root ? pred.root : pred, get);
}

function _val(n, get) {
  if (n == null) return null;
  if ('col' in n) { const v = get(n.col); return v === undefined ? null : v; }
  if ('lit' in n) return n.lit;
  if (n.op === 'neg') { const a = _val(n.arg, get); return a == null ? null : -a; }
  if (ARITH.has(n.op)) {
    const a = _val(n.left, get), b = _val(n.right, get);
    if (a == null || b == null) return null;
    switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; }
  }
  return null;
}

function _cmp(a, b) { // non-null comparison: numbers numeric, else lexical
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function _truthy(v) { return v != null && v !== false && v !== 0 && v !== ''; }

function _bool(n, get) {
  if (!n || typeof n.op !== 'string') throw new Error('predicate: not a boolean node');
  switch (n.op) {
    case 'and': return n.args.every((x) => _bool(x, get));
    case 'or': return n.args.some((x) => _bool(x, get));
    case 'not': return !_bool(n.arg, get);
    case 'truthy': return _truthy(_val(n.arg, get));
    case 'isnull': return _val(n.arg, get) == null;
    case 'notnull': return _val(n.arg, get) != null;
    case 'in': case 'notin': {
      const v = _val(n.left, get);
      const has = v != null && n.set.includes(v);
      return n.op === 'in' ? has : (v != null && !has);
    }
    case 'between': {
      const v = _val(n.arg, get); if (v == null) return false;
      const lo = _val(n.lo, get), hi = _val(n.hi, get);
      if (lo == null || hi == null) return false;
      return _cmp(v, lo) >= 0 && _cmp(v, hi) <= 0;
    }
    default: {
      if (!COMPARE.has(n.op)) throw new Error('predicate: unknown op "' + n.op + '"');
      const a = _val(n.left, get), b = _val(n.right, get);
      // == / != with a null operand → false (null-checks go through isnull/notnull).
      if (n.op === '==') return a != null && b != null && a === b;
      if (n.op === '!=') return a != null && b != null && a !== b;
      if (a == null || b == null) return false;
      const c = _cmp(a, b);
      switch (n.op) { case '<': return c < 0; case '<=': return c <= 0; case '>': return c > 0; case '>=': return c >= 0; }
    }
  }
}

// ── deps + validate ────────────────────────────────────────────────────

/** The column names a predicate references (for "can this receiver satisfy it?"). */
function predicateColumns(pred) {
  const out = new Set();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if ('col' in n) out.add(n.col);
    for (const k of ['arg', 'left', 'right', 'lo', 'hi']) if (n[k]) walk(n[k]);
    if (n.args) n.args.forEach(walk);
  })(pred && pred.root ? pred.root : pred);
  return [...out];
}

/** Shape-check a predicate; throws on a malformed spec. Returns true. */
function validatePredicate(pred) {
  (function v(n, ctx) {
    if (!n || typeof n !== 'object') throw new Error('predicate: expected a node');
    if ('col' in n || 'lit' in n) return;
    if (typeof n.op !== 'string') throw new Error('predicate: node needs an op');
    if (ctx === 'bool' && !BOOL_OPS.has(n.op)) throw new Error('predicate: "' + n.op + '" is not a boolean op');
    if (n.op === 'and' || n.op === 'or') { if (!Array.isArray(n.args)) throw new Error('predicate: and/or needs args[]'); n.args.forEach((a) => v(a, 'bool')); return; }
    if (n.op === 'not' || n.op === 'truthy' || n.op === 'isnull' || n.op === 'notnull' || n.op === 'neg') { v(n.arg, n.op === 'not' ? 'bool' : 'val'); return; }
    if (n.op === 'between') { v(n.arg, 'val'); v(n.lo, 'val'); v(n.hi, 'val'); return; }
    if (n.op === 'in' || n.op === 'notin') { v(n.left, 'val'); if (!Array.isArray(n.set)) throw new Error('predicate: in/notin needs set[]'); return; }
    if (COMPARE.has(n.op) || ARITH.has(n.op)) { v(n.left, 'val'); v(n.right, 'val'); return; }
    throw new Error('predicate: unknown op "' + n.op + '"');
  })(pred && pred.root ? pred.root : pred, 'bool');
  return true;
}

// ── string → spec parser (authoring side only) ─────────────────────────
// A JS-flavoured expression subset: && || ! , == === != !== < <= > >= ,
// + - * / , parens, column idents, number/string/bool/null literals. Anything
// outside (function calls, member access, …) is rejected — that's the safety.
// `x == null` / `x != null` lower to isnull / notnull. A bare term in boolean
// position becomes `truthy` (so a derived boolean column filters as `flag`).

function tokenize(s) {
  const toks = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, out = '';
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') { out += s[j + 1]; j += 2; } else { out += s[j++]; } }
      if (j >= s.length) throw new Error('sift: unterminated string');
      toks.push({ t: 'lit', v: out }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      toks.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      toks.push({ t: 'ident', v: s.slice(i, j) }); i = j; continue;
    }
    const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
    if (three === '===' || three === '!==') { toks.push({ t: 'op', v: three === '===' ? '==' : '!=' }); i += 3; continue; }
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('!<>+-*/'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { toks.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rparen' }); i++; continue; }
    throw new Error('sift: unexpected character "' + c + '"');
  }
  return toks;
}

function asBool(node) { return isValueNode(node) ? { op: 'truthy', arg: node } : node; }

/** Parse a filter string → { form:'spec', root }. Throws on disallowed syntax. */
function parsePredicate(str) {
  const toks = tokenize(str);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function flatten(op, a, b) { const r = []; for (const x of [a, b]) { if (x.op === op) r.push(...x.args); else r.push(x); } return r; }

  function parseOr() { let l = parseAnd(); while (isOp('||')) { p++; l = { op: 'or', args: flatten('or', l, parseAnd()) }; } return l; }
  function parseAnd() { let l = asBool(parseCmp()); while (isOp('&&')) { p++; l = { op: 'and', args: flatten('and', l, asBool(parseCmp())) }; } return l; }
  function parseCmp() {
    const left = parseAdd();
    if (peek() && peek().t === 'op' && COMPARE.has(peek().v)) {
      const op = peek().v; p++;
      const right = parseAdd();
      if ((op === '==' || op === '!=') && isNullLit(right)) return { op: op === '==' ? 'isnull' : 'notnull', arg: left };
      if ((op === '==' || op === '!=') && isNullLit(left)) return { op: op === '==' ? 'isnull' : 'notnull', arg: right };
      return { op, left, right };
    }
    return left;
  }
  function parseAdd() { let l = parseMul(); while (isOp('+') || isOp('-')) { const op = peek().v; p++; l = { op, left: l, right: parseMul() }; } return l; }
  function parseMul() { let l = parseUnary(); while (isOp('*') || isOp('/')) { const op = peek().v; p++; l = { op, left: l, right: parseUnary() }; } return l; }
  function parseUnary() {
    if (isOp('!')) { p++; return { op: 'not', arg: asBool(parseUnary()) }; }
    if (isOp('-')) { p++; return { op: 'neg', arg: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('sift: unexpected end of expression');
    if (t.t === 'num') { p++; return { lit: t.v }; }
    if (t.t === 'lit') { p++; return { lit: t.v }; }
    if (t.t === 'lparen') { p++; const e = parseOr(); if (!peek() || peek().t !== 'rparen') throw new Error('sift: expected ")"'); p++; return e; }
    if (t.t === 'ident') {
      p++;
      if (t.v === 'true') return { lit: true };
      if (t.v === 'false') return { lit: false };
      if (t.v === 'null') return { lit: null };
      if (peek() && peek().t === 'lparen') throw new Error('sift: function calls are not allowed — use a derived column for full-JS logic');
      return { col: t.v };
    }
    throw new Error('sift: unexpected token "' + (t.v != null ? t.v : t.t) + '"');
  }

  const root = asBool(parseOr());
  if (p < toks.length) throw new Error('sift: unexpected token after expression');
  return { form: 'spec', root };
}

// ── spec → string (for display / audit / round-trip) ───────────────────

const PARENS = new Set(['and', 'or']);

function predicateToString(pred) {
  return _str(pred && pred.root ? pred.root : pred);
}
function _str(n) {
  if (!n) return '';
  if ('col' in n) return n.col;
  if ('lit' in n) { const v = n.lit; return typeof v === 'string' ? JSON.stringify(v) : String(v); }
  switch (n.op) {
    case 'and': return n.args.map(_wrap).join(' && ');
    case 'or': return n.args.map(_wrap).join(' || ');
    case 'not': return '!' + _wrap(n.arg);
    case 'neg': return '-' + _wrap(n.arg);
    case 'truthy': return _str(n.arg);
    case 'isnull': return _str(n.arg) + ' == null';
    case 'notnull': return _str(n.arg) + ' != null';
    case 'in': return _str(n.left) + ' in [' + n.set.map((x) => JSON.stringify(x)).join(', ') + ']';
    case 'notin': return _str(n.left) + ' notin [' + n.set.map((x) => JSON.stringify(x)).join(', ') + ']';
    case 'between': return _str(n.arg) + ' between ' + _str(n.lo) + ' and ' + _str(n.hi);
    default: return _str(n.left) + ' ' + n.op + ' ' + _str(n.right);
  }
}
function _wrap(n) { return n && PARENS.has(n.op) ? '(' + _str(n) + ')' : _str(n); }

// ── src/recipe.js ──

// @gcu/gsjs — the recipe API: a JSON-serializable estimation spec + a composable
// JS builder eDSL that produces it, on top of the target-based kriging() core.
//
// Layers (SPEC §"Layered architecture"): the recipe is the SHIPPABLE ARTIFACT —
// language-independent JSON a regulator can diff and a non-JS consumer can read.
// The eDSL (recipe/variogram/search/ok/sk/…) is just a convenient JS way to
// BUILD that JSON; toJSON() emits the canonical form, fromJSON() rebuilds it.
//
// @gcu/build bundles src/ into a self-contained ESM, so this module imports
// what it uses (kriging, realize, the aggregations) from siblings normally. The
// `where` selector is @gcu/sift, imported from its source so @gcu/build's `inline`
// pass folds it into the bundle collision-safe (the over↔dimensions pattern).
//
// Canonical JSON (compact GSLIB vocab, per SPEC §"Core data structures"):
//   { data: { columns:{x,y,z,value,domain?,sk_mean?,dh_id?}, source? },
//     block_grid: { nx,ny,nz, xmn,ymn,zmn, xsiz,ysiz,zsiz, discretization:[a,b,c] },
//     domains?: [ { id, where, model } ],      where = sift predicate (string→spec)
//     default_model?: <DomainEstimation>,
//     output: { distances?, aggregations?: [<AggregationSpec>] } }
//   DomainEstimation = { ktype:'OK'|'SK'|'SK_LVM', sk_mean?, variogram, search, realization }
//   VariogramModel   = { c0, structures:[{ type, cc, aa, anis:[ay/ax,az/ax], ang:[s,d,p] }] }
//   SearchEllipsoid  = { radius, anis:[rmin/rmaj,rvert/rmaj], ang:[s,d,p], ndmin, ndmax, octant? }
//   Realization      = { transform:'none'|'topcut'|'hgr_hard'|'hgr_soft', transform_params:{…} }
//   AggregationSpec  = { kind:'stats'|'histogram'|'swath'|'gradeTonnage', name?, …kind params }
//
// run(recipe, ctx) executes; it is staged so live cap/HGR sliders re-run only the
// cheap tail: estimate() (expensive — search+solve, per domain) → evaluate()
// (cheap — realize + aggregate). Spec: spec_inbox/gsjs-SPEC.md §"Recipe API".


const _TRANSFORMS = new Set(['none', 'topcut', 'hgr_hard', 'hgr_soft']);
const _KTYPES = new Set(['OK', 'SK', 'SK_LVM']);
const _AGG_KINDS = new Set(['stats', 'histogram', 'swath', 'gradeTonnage']);

// ── builders (return plain serializable nodes) ──────────────────────────────

// variogram(structures, { c0 }) → VariogramModel. Each structure:
//   { type:'spherical'|…|1..5, cc, aa, anis?:[ay/ax,az/ax], ang?:[strike,dip,plunge] }
// anis defaults to isotropic [1,1]; ang to [0,0,0].
function variogram(structures, opts = {}) {
  if (!Array.isArray(structures) || structures.length === 0) {
    throw new Error('gsjs.variogram: need at least one structure');
  }
  return {
    c0: opts.c0 ?? opts.nugget ?? 0,
    structures: structures.map((s) => ({
      type: s.type,
      cc: s.cc ?? s.contribution,
      aa: s.aa ?? s.range,
      anis: s.anis ? [s.anis[0], s.anis[1]] : [1, 1],
      ang: s.ang ? [s.ang[0], s.ang[1], s.ang[2]] : [0, 0, 0],
    })),
  };
}

// search({ radius, anis?, ang?, ndmin, ndmax, octant? }) → SearchEllipsoid.
function search(opts = {}) {
  return {
    radius: opts.radius,
    anis: opts.anis ? [opts.anis[0], opts.anis[1]] : [1, 1],
    ang: opts.ang ? [opts.ang[0], opts.ang[1], opts.ang[2]] : [0, 0, 0],
    ndmin: opts.ndmin ?? 1,
    ndmax: opts.ndmax,
    ...(opts.octant ? { octant: { ...opts.octant } } : {}),
    // neighbourhood policies (the JS engine drives them); all serializable
    ...(opts.perHoleMax != null ? { perHoleMax: opts.perHoleMax } : {}),   // needs data.columns.dh_id
    ...(opts.sectors ? { sectors: { ...opts.sectors } } : {}),
    ...(opts.minSampleDistance != null ? { minSampleDistance: opts.minSampleDistance } : {}),
    ...(opts.benchThickness != null ? { benchThickness: opts.benchThickness } : {}),
  };
}

// realization predicate builders → Realization nodes (transform + params).
function none() { return { transform: 'none', transform_params: {} }; }
function topcut(p = {}) { return { transform: 'topcut', transform_params: { cap: p.cap } }; }

// hgr({ mode:'hard'|'soft', cap, d_thresh?, d_max?, grade_thresh }) — high-grade
// restriction. mode defaults to 'hard'; 'soft' ramps over distance (needs d_max).
function hgr(p = {}) {
  const mode = p.mode || (p.d_max != null && p.d_thresh == null ? 'soft' : 'hard');
  const tp = { cap: p.cap, grade_thresh: p.grade_thresh };
  if (mode === 'hard') tp.d_thresh = p.d_thresh;
  else tp.d_max = p.d_max;
  return { transform: 'hgr_' + mode, transform_params: tp };
}

// model builders → DomainEstimation. realization defaults to none(). A model-level
// `orientation` (+ `convention`, default 'structural' = dip/dipAzimuth/pitch) orients
// the WHOLE domain — variogram and search share it (the common case); it overrides any
// per-structure/search `ang`. Omit it to orient per-part with gslib `ang` (legacy).
function _model(ktype, m) {
  return {
    ktype,
    ...(m.sk_mean != null ? { sk_mean: m.sk_mean } : {}),
    ...(m.orientation ? { convention: m.convention || 'structural', orientation: { ...m.orientation } } : (m.convention ? { convention: m.convention } : {})),
    variogram: m.variogram,
    search: m.search,
    realization: m.realization || none(),
  };
}
function ok(m) { return _model('OK', m); }
function sk(m) { return _model('SK', { sk_mean: m.sk_mean ?? 0, ...m }); }
function sk_lvm(m) { return _model('SK_LVM', m); }

// ── where selector (sift predicate, serializable) ───────────────────────────
// Accepts a string ("DOMAIN == 'HG'" → parsed to a sift spec), a sift spec
// object ({form:'spec',root} or a bare Expr), or a JS function (in-memory escape
// hatch that does NOT round-trip — toJSON refuses it).
function _normalizeWhere(where) {
  if (where == null) return null;
  if (typeof where === 'string') return parsePredicate(where);
  if (typeof where === 'function') return { _fn: where };
  if (typeof where === 'object') { validatePredicate(where); return where; }
  throw new Error('gsjs: domain `where` must be a string, sift predicate, or function');
}
function _whereFn(nw) {
  if (nw == null) return () => true;
  if (nw._fn) return (row) => !!nw._fn(row);
  return (row) => evaluatePredicate(nw, (col) => row[col]);
}

// ── validation (structural; throws — the artifact must be valid) ─────────────

function _validateVario(v, ctx) {
  if (!v || !Array.isArray(v.structures) || v.structures.length === 0) throw new Error(`gsjs${ctx}: variogram needs structures[]`);
  if (v.c0 < 0) throw new Error(`gsjs${ctx}: nugget c0 must be ≥ 0`);
  for (const s of v.structures) {
    if (s.cc == null || s.cc < 0) throw new Error(`gsjs${ctx}: structure cc must be ≥ 0`);
    if (!(s.aa > 0)) throw new Error(`gsjs${ctx}: structure range aa must be > 0`);
    if (!(s.anis[0] > 0) || !(s.anis[1] > 0)) throw new Error(`gsjs${ctx}: anisotropy ratios must be > 0`);
  }
}
function _validateSearch(s, ctx) {
  if (!(s.radius > 0)) throw new Error(`gsjs${ctx}: search radius must be > 0`);
  if (!(s.ndmax >= s.ndmin) || !(s.ndmin >= 1)) throw new Error(`gsjs${ctx}: need ndmax ≥ ndmin ≥ 1`);
  if (!(s.anis[0] > 0) || !(s.anis[1] > 0)) throw new Error(`gsjs${ctx}: search anis ratios must be > 0`);
}
function _validateRealization(r, ctx) {
  if (!_TRANSFORMS.has(r.transform)) throw new Error(`gsjs${ctx}: unknown transform '${r.transform}'`);
  const p = r.transform_params || {};
  if (r.transform === 'topcut' && p.cap == null) throw new Error(`gsjs${ctx}: topcut needs cap`);
  if (r.transform === 'hgr_hard' && (p.cap == null || p.d_thresh == null || p.grade_thresh == null)) throw new Error(`gsjs${ctx}: hgr_hard needs cap, d_thresh, grade_thresh`);
  if (r.transform === 'hgr_soft' && (p.cap == null || p.d_max == null || p.grade_thresh == null)) throw new Error(`gsjs${ctx}: hgr_soft needs cap, d_max, grade_thresh`);
}
function _validateModel(m, ctx) {
  if (!_KTYPES.has(m.ktype)) throw new Error(`gsjs${ctx}: unknown ktype '${m.ktype}'`);
  if (m.ktype === 'SK' && typeof m.sk_mean !== 'number') throw new Error(`gsjs${ctx}: SK needs a numeric sk_mean`);
  if (m.ktype === 'SK_LVM' && m.sk_mean == null) throw new Error(`gsjs${ctx}: SK_LVM needs an sk_mean source (column name or array)`);
  _validateVario(m.variogram, ctx);
  _validateSearch(m.search, ctx);
  _validateRealization(m.realization, ctx);
}
function _validateGrid(g) {
  for (const k of ['nx', 'ny', 'nz']) if (!(g[k] >= 1)) throw new Error(`gsjs: block_grid.${k} must be ≥ 1`);
  for (const k of ['xsiz', 'ysiz', 'zsiz']) if (!(g[k] > 0)) throw new Error(`gsjs: block_grid.${k} must be > 0`);
  if (g.discretization && (!Array.isArray(g.discretization) || g.discretization.length !== 3)) throw new Error('gsjs: block_grid.discretization must be [nx,ny,nz]');
}
function _validateAgg(a) {
  if (!_AGG_KINDS.has(a.kind)) throw new Error(`gsjs: unknown aggregation kind '${a.kind}'`);
  if (a.kind === 'gradeTonnage' && !Array.isArray(a.cutoffs)) throw new Error('gsjs: gradeTonnage needs cutoffs[]');
  if (a.kind === 'swath' && !['x', 'y', 'z'].includes(a.axis)) throw new Error("gsjs: swath needs axis 'x'|'y'|'z'");
}

// ── recipe() — normalize + validate, return a live recipe with toJSON() ─────

// recipe(spec) accepts the eDSL/JSON shape and returns a live object carrying the
// normalized spec (where-selectors parsed to sift specs) + a toJSON() that emits
// the canonical, serializable artifact. Validation runs at construction time.
function recipe(spec) {
  if (!spec || !spec.data || !spec.data.columns) throw new Error('gsjs.recipe: need data.columns');
  if (!spec.block_grid) throw new Error('gsjs.recipe: need block_grid');
  if (!spec.domains && !spec.default_model) throw new Error('gsjs.recipe: need domains[] or default_model');

  _validateGrid(spec.block_grid);
  if (spec.default_model) _validateModel(spec.default_model, '.default_model');

  const domains = (spec.domains || []).map((d) => {
    if (d.id == null) throw new Error('gsjs.recipe: each domain needs an id');
    _validateModel(d.model, `.domain[${d.id}]`);
    return { id: d.id, where: _normalizeWhere(d.where), model: d.model };
  });

  const aggregations = (spec.output && spec.output.aggregations) || [];
  for (const a of aggregations) _validateAgg(a);

  const norm = {
    data: { columns: { ...spec.data.columns }, ...(spec.data.source != null ? { source: spec.data.source } : {}) },
    block_grid: { ...spec.block_grid },
    ...(domains.length ? { domains } : {}),
    ...(spec.default_model ? { default_model: spec.default_model } : {}),
    output: { distances: !!(spec.output && spec.output.distances), diagnostics: !!(spec.output && spec.output.diagnostics), aggregations },
  };

  return {
    ...norm,
    toJSON() {
      const out = JSON.parse(JSON.stringify({ ...norm, domains: undefined }));
      if (norm.domains) {
        out.domains = norm.domains.map((d) => {
          if (d.where && d.where._fn) throw new Error(`gsjs.recipe.toJSON: domain '${d.id}' uses a JS function selector that can't be serialized — use a sift predicate string instead`);
          return { id: d.id, ...(d.where ? { where: d.where } : {}), model: d.model };
        });
      }
      return out;
    },
  };
}

// fromJSON(spec) — rebuild an executable recipe from canonical JSON. Idempotent
// with toJSON(): where-selectors are already sift specs, recipe() re-validates.
function fromJSON(spec) { return recipe(spec); }

// ── translation: compact recipe vocab → kriging() verbose opts ──────────────

// the model-level orientation (if any) → the convention + params krige()/
// createNeighborhood consume; else null → use the per-part gslib `ang`.
function _orient(model) {
  if (!model.orientation) return null;
  return { convention: model.convention || 'structural', orientation: model.orientation };
}

function _krigingVario(model) {
  const v = model.variogram, o = _orient(model);
  return {
    nugget: v.c0,
    structures: v.structures.map((s) => ({
      type: s.type,
      contribution: s.cc,
      range: s.aa,
      rangeMinor: s.aa * s.anis[0],
      rangeVert: s.aa * s.anis[1],
      ...(o ? { convention: o.convention, orientation: o.orientation }
        : { angle: s.ang[0], angle2: s.ang[1], angle3: s.ang[2] }),
    })),
  };
}
function _krigingSearch(model) {
  const s = model.search, o = _orient(model);
  return {
    radius: s.radius,
    radiusMinor: s.radius * s.anis[0],
    radiusVert: s.radius * s.anis[1],
    ...(o ? { convention: o.convention, ...o.orientation }
      : { angle: s.ang[0], angle2: s.ang[1], angle3: s.ang[2] }),
    ndmin: s.ndmin, ndmax: s.ndmax,
    ...(s.perHoleMax != null ? { perHoleMax: s.perHoleMax } : {}),
    ...(s.sectors ? { sectors: s.sectors } : {}),
    ...(s.minSampleDistance != null ? { minSampleDistance: s.minSampleDistance } : {}),
    ...(s.benchThickness != null ? { type: 'bench', benchThickness: s.benchThickness } : {}),
  };
}

// Extract [x,y,z,value] sample rows from host rows via the column mapping, plus a
// parallel holeId side array when a dh_id column is mapped (for the per-hole cap).
function _samples(rows, cols, predFn) {
  const data = [], holeId = cols.dh_id != null ? [] : null;
  for (const row of rows) {
    if (predFn && !predFn(row)) continue;
    const v = row[cols.value];
    if (v == null || Number.isNaN(+v)) continue;        // skip missing assays
    data.push([+row[cols.x], +row[cols.y], +row[cols.z], +v]);
    if (holeId) holeId.push(row[cols.dh_id]);
  }
  return { data, holeId };
}

// ── estimate() — the EXPENSIVE stage (search + solve), per domain ───────────
//
// ctx: { rows, blockDomains? }
//   rows         — host data rows (array of objects keyed by column name)
//   blockDomains — per-block domain id (Array | TypedArray length nxyz, OR a
//                  function (ix,iy,iz,x,y,z,idx)=>id). Required iff the recipe
//                  has domains[]. Each block runs the model of the domain whose
//                  id it carries; unmatched blocks fall to default_model (if any)
//                  else status NOT_ATTEMPTED.
//
// Returns { grid, geom, nxyz, status, domains:[{id, tensor, gridIndex, model}], _recipe }.
function estimate(R, ctx = {}) {
  const r = R.toJSON ? R : recipe(R);              // accept live recipe or raw spec
  const cols = r.data.columns;
  const rows = ctx.rows;
  if (!Array.isArray(rows)) throw new Error('gsjs.estimate: ctx.rows (host data rows) is required');
  const g = r.block_grid;
  const nxyz = g.nx * g.ny * g.nz;
  const disc = g.discretization ? { nx: g.discretization[0], ny: g.discretization[1], nz: g.discretization[2] } : undefined;
  const wantDist = !!r.output.distances;
  const wantDiag = !!r.output.diagnostics;
  const status = new Uint8Array(nxyz).fill(STATUS.NOT_ATTEMPTED);

  // Resolve the work list: a domain is { id, predFn, model, blockMask | null }.
  // Single default_model (no domains) → one full-grid run (allocation-free).
  const work = [];
  if (!r.domains) {
    work.push({ id: '_default', predFn: () => true, model: r.default_model, mask: null });
  } else {
    if (ctx.blockDomains == null) throw new Error('gsjs.estimate: recipe has domains[] — ctx.blockDomains (per-block id) is required');
    const bd = ctx.blockDomains;
    const idOf = typeof bd === 'function'
      ? (ix, iy, iz, x, y, z, idx) => bd(ix, iy, iz, x, y, z, idx)
      : (ix, iy, iz, x, y, z, idx) => bd[idx];
    // bucket blocks by domain id
    const masks = new Map();
    let idx = 0;
    for (let iz = 0; iz < g.nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++, idx++) {
      const x = g.xmn + ix * g.xsiz, y = g.ymn + iy * g.ysiz, z = g.zmn + iz * g.zsiz;
      const id = idOf(ix, iy, iz, x, y, z, idx);
      if (id == null) continue;
      let m = masks.get(id);
      if (!m) { m = new Uint8Array(nxyz); masks.set(id, m); }
      m[idx] = 1;
    }
    const byId = new Map(r.domains.map((d) => [d.id, d]));
    for (const [id, mask] of masks) {
      const d = byId.get(id);
      if (d) work.push({ id, predFn: _whereFn(d.where), model: d.model, mask });
      else if (r.default_model) work.push({ id, predFn: () => true, model: r.default_model, mask });
      // else: blocks of an unknown id stay NOT_ATTEMPTED
    }
  }

  const outDomains = [];
  for (const w of work) {
    if (w.model.ktype === 'SK_LVM') throw new Error("gsjs.estimate: SK_LVM (locally varying mean) isn't supported by krige() yet — use OK or SK");
    const { data, holeId } = _samples(rows, cols, w.predFn);
    const kopts = {
      data,
      variogram: _krigingVario(w.model),
      search: _krigingSearch(w.model),
      ktype: w.model.ktype,
      ...(w.model.ktype === 'SK' ? { skmean: w.model.sk_mean } : {}),
      grid: g,
      ...(w.mask ? { mask: w.mask } : {}),
      ...(disc ? { discretization: disc } : {}),
      ...(holeId ? { holeId } : {}),
      distances: wantDist,
      diagnostics: wantDiag,
    };
    // faithful:true → the recipe stays bit-identical to gslib.kt3d (no user-visible
    // numerical change from the atra fork), now via the neighbourhood-driven JS engine.
    const tensor = krige({ ...kopts, faithful: true });
    // scatter this domain's per-target status into the full-grid status array
    for (let t = 0; t < tensor.n_targets; t++) {
      const gi = tensor.gridIndex ? tensor.gridIndex[t] : t;
      status[gi] = tensor.status[t];
    }
    outDomains.push({ id: w.id, tensor, gridIndex: tensor.gridIndex, model: w.model });
  }

  return { grid: g, geom: { grid: g }, nxyz, status, domains: outDomains, _recipe: r };
}

// ── evaluate() — the CHEAP stage (realize + aggregate), re-runnable ─────────
//
// kriged: the estimate() result. overrides: per-domain realization overrides,
//   { [domainId]: { transform?, transform_params? } } — what a live slider sets
//   (e.g. { HG: { transform_params: { cap: 28 } } }) to re-realize WITHOUT
//   re-kriging. Returns { estimates, status, geom, aggregations, domains }.
function evaluate(kriged, overrides = {}) {
  const r = kriged._recipe;
  const { nxyz, status, geom } = kriged;
  const estimates = new Float64Array(nxyz);
  const perDomain = [];

  for (const d of kriged.domains) {
    const base = d.model.realization || none();
    const ov = overrides[d.id] || {};
    const transform = ov.transform || base.transform;
    const params = { ...(base.transform_params || {}), ...(ov.transform_params || {}) };
    const est = realize(d.tensor, d.tensor.values, { transform, params });
    for (let t = 0; t < d.tensor.n_targets; t++) {
      const gi = d.gridIndex ? d.gridIndex[t] : t;
      estimates[gi] = est[t];
    }
    perDomain.push({ id: d.id, estimates: est, gridIndex: d.gridIndex });
  }

  const aggregations = {};
  for (const a of r.output.aggregations) {
    const name = a.name || (a.kind === 'swath' ? `swath_${a.axis}` : a.kind);
    if (a.kind === 'stats') aggregations[name] = stats(estimates, status);
    else if (a.kind === 'histogram') aggregations[name] = histogram(estimates, status, { min: a.min, max: a.max, nbins: a.nbins });
    else if (a.kind === 'swath') aggregations[name] = swath(estimates, status, geom, { axis: a.axis, nbins: a.nbins });
    else if (a.kind === 'gradeTonnage') aggregations[name] = gradeTonnage(estimates, status, { cutoffs: a.cutoffs, blockTonnage: a.blockTonnage });
  }

  return { estimates, status, geom, aggregations, domains: perDomain };
}

// run(recipe, ctx, overrides?) — convenience: the full pipeline. For live
// sliders, hold the estimate() result and call evaluate() repeatedly instead.
function run(R, ctx = {}, overrides = {}) {
  return evaluate(estimate(R, ctx), overrides);
}

// ── src/main.js ──

// @gcu/gsjs — module manifest. Its re-exports ARE the @gcu/build manifest (the
// bundler walks them); every public src module is listed so the bundle's surface
// is the full union of the package's exports. Build order derives from the actual
// import graph, so the order here is just for reading.
//
// _wasm.js (the generated atra→wasm module) is intentionally NOT listed — its
// runtime helpers stay internal; api.js imports them, so @gcu/build still folds
// _wasm.js into the bundle, it just isn't re-exported publicly.

// STATUS, makeTransform, realize
// stats, histogram, swath, gradeTonnage
// cpuBackend, getBackend, setBackend
// setrot, sqdist, applyAnis, toRotmat, leapfrogToRotmat, GSLIB_PI
// createNeighborhood, indexSamples, select
// krige (pure-JS kriging driver, neighbourhood-fed) + qknaSummary, crossValidate
// declusterCell, declusterSweep, declusterWeights
// experimental, ESTIMATORS, GAMV_PI
// recipe, variogram, search, ok/sk/sk_lvm, none/topcut/hgr, fromJSON, run/estimate/evaluate

export {
  STATUS,
  makeTransform,
  realize,
  stats,
  histogram,
  swath,
  gradeTonnage,
  cpuBackend,
  setBackend,
  getBackend,
  GSLIB_PI,
  setrot,
  sqdist,
  applyAnis,
  structuralToRotmat,
  structuralToRotmat as leapfrogToRotmat,
  toRotmat,
  createNeighborhood,
  indexSamples,
  select,
  krige,
  qknaSummary,
  crossValidate,
  declusterWeights,
  declusterCell,
  declusterSweep,
  GAMV_PI,
  ESTIMATORS,
  experimental,
  buildLagVolume,
  directionalVariogram,
  mergeLagVolumes,
  variogram,
  search,
  none,
  topcut,
  hgr,
  ok,
  sk,
  sk_lvm,
  recipe,
  fromJSON,
  estimate,
  evaluate,
  run,
};
