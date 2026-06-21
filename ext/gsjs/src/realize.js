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
export const STATUS = Object.freeze({
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
export function makeTransform(mode = 'none', params = {}) {
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
export function realize(tensor, values, opts = {}) {
  const { indices, weights, n_actual, distances, sk_mean, K, n_blocks } = tensor;
  const T = makeTransform(opts.transform || 'none', opts.params || {});
  const needsDist = opts.transform === 'hgr_hard' || opts.transform === 'hgr_soft';
  if (needsDist && !distances) {
    throw new Error(`gsjs: transform '${opts.transform}' needs distances; re-run kriging with distances:true`);
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
