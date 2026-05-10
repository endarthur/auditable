// Pairwise distance matrices.
//
// scipy.spatial.distance parity for the distance functions that actually
// matter in geoscience and stats work: euclidean, sqeuclidean, manhattan
// (cityblock), chebyshev, minkowski, mahalanobis, cosine, correlation,
// hamming. Anisotropy via a per-axis weight vector — the geological case
// of using rotated/scaled distances for variograms (handled at a higher
// level by callers, e.g. by transforming inputs before calling cdist).
//
// Inputs:
//   X, Y — arrays of vectors, shape (n, d). Accepted forms:
//     • Float64Array (flat row-major) + opts.n + opts.d
//     • Array of arrays (each inner array length d)
//     • ndarray-like { data: Float64Array, shape: [n, d] }
//
// Outputs:
//   cdist(X, Y) → Float64Array of length nX * nY (row-major)
//   pdist(X)    → Float64Array of length nX*(nX-1)/2 (upper triangle,
//                  scipy-compatible packed form)
//   squareform(d) → expand pdist to full nX×nX matrix and back
//
// Acceleration: when nX*nY ≥ GEMM_NM_THRESHOLD and natra is registered
// as a backend, euclidean/sqeuclidean dispatch through the gemm trick
// (D² = ‖X‖² + ‖Y‖² − 2XYᵀ) for a 5-10× speedup. Opt-out via
// opts.backend = 'inline'.

import { getNatra, GEMM_NM_THRESHOLD } from '../util/backend.js';

function _normalize(X, opts) {
  if (X instanceof Float64Array) {
    if (opts && opts.n !== undefined && opts.d !== undefined) {
      return { data: X, n: opts.n, d: opts.d };
    }
    throw new TypeError('Flat Float64Array requires opts.n and opts.d');
  }
  if (X && X.data instanceof Float64Array && Array.isArray(X.shape)) {
    if (X.shape.length !== 2) throw new RangeError('expected 2D ndarray');
    return { data: X.data, n: X.shape[0], d: X.shape[1] };
  }
  if (Array.isArray(X)) {
    if (X.length === 0) return { data: new Float64Array(0), n: 0, d: 0 };
    const d = Array.isArray(X[0]) ? X[0].length : X[0].length;
    const n = X.length;
    const out = new Float64Array(n * d);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      for (let j = 0; j < d; j++) out[i * d + j] = row[j];
    }
    return { data: out, n, d };
  }
  throw new TypeError('expected ndarray, flat Float64Array, or array of arrays');
}

// ── kernel functions ─────────────────────────────────────────────────
//
// Each metric kernel takes pointers (a, b, d, w?) and returns the distance.
// We dispatch once outside the inner loop and inline the metric body.

function _euclid(a, b, d, w) {
  let s = 0;
  if (w) {
    for (let k = 0; k < d; k++) {
      const t = a[k] - b[k];
      s += w[k] * t * t;
    }
  } else {
    for (let k = 0; k < d; k++) {
      const t = a[k] - b[k];
      s += t * t;
    }
  }
  return Math.sqrt(s);
}

function _sqeuclid(a, b, d, w) {
  let s = 0;
  if (w) {
    for (let k = 0; k < d; k++) {
      const t = a[k] - b[k];
      s += w[k] * t * t;
    }
  } else {
    for (let k = 0; k < d; k++) {
      const t = a[k] - b[k];
      s += t * t;
    }
  }
  return s;
}

function _manhattan(a, b, d, w) {
  let s = 0;
  if (w) {
    for (let k = 0; k < d; k++) s += w[k] * Math.abs(a[k] - b[k]);
  } else {
    for (let k = 0; k < d; k++) s += Math.abs(a[k] - b[k]);
  }
  return s;
}

function _chebyshev(a, b, d) {
  let m = 0;
  for (let k = 0; k < d; k++) {
    const t = Math.abs(a[k] - b[k]);
    if (t > m) m = t;
  }
  return m;
}

function _minkowski(a, b, d, w, p) {
  let s = 0;
  if (w) {
    for (let k = 0; k < d; k++) {
      s += w[k] * Math.pow(Math.abs(a[k] - b[k]), p);
    }
  } else {
    for (let k = 0; k < d; k++) {
      s += Math.pow(Math.abs(a[k] - b[k]), p);
    }
  }
  return Math.pow(s, 1 / p);
}

function _hamming(a, b, d, w) {
  let s = 0, total = 0;
  if (w) {
    for (let k = 0; k < d; k++) {
      total += w[k];
      if (a[k] !== b[k]) s += w[k];
    }
    return total > 0 ? s / total : 0;
  }
  for (let k = 0; k < d; k++) if (a[k] !== b[k]) s++;
  return s / d;
}

function _cosine(a, b, d) {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < d; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : 1 - dot / mag;
}

function _correlation(a, b, d) {
  let ma = 0, mb = 0;
  for (let k = 0; k < d; k++) { ma += a[k]; mb += b[k]; }
  ma /= d; mb /= d;
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < d; k++) {
    const x = a[k] - ma, y = b[k] - mb;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : 1 - dot / mag;
}

// Mahalanobis: distance with an inverse covariance matrix VI (d×d).
// (a-b)ᵀ VI (a-b) — passed flat, row-major, length d*d.
function _mahalanobis(a, b, d, VI) {
  // diff = a - b
  const diff = new Float64Array(d);
  for (let k = 0; k < d; k++) diff[k] = a[k] - b[k];
  // tmp = VI · diff
  let s = 0;
  for (let i = 0; i < d; i++) {
    let row = 0;
    const base = i * d;
    for (let j = 0; j < d; j++) row += VI[base + j] * diff[j];
    s += diff[i] * row;
  }
  return Math.sqrt(s);
}

// ── public API ───────────────────────────────────────────────────────

function _resolveMetric(metric) {
  if (typeof metric === 'function') return { fn: metric, kind: 'custom' };
  switch (metric) {
    case undefined:
    case 'euclidean':       return { fn: _euclid, kind: 'simple' };
    case 'sqeuclidean':     return { fn: _sqeuclid, kind: 'simple' };
    case 'cityblock':
    case 'manhattan':       return { fn: _manhattan, kind: 'simple' };
    case 'chebyshev':       return { fn: _chebyshev, kind: 'noweight' };
    case 'minkowski':       return { fn: _minkowski, kind: 'minkowski' };
    case 'hamming':         return { fn: _hamming, kind: 'simple' };
    case 'cosine':          return { fn: _cosine, kind: 'noweight' };
    case 'correlation':     return { fn: _correlation, kind: 'noweight' };
    case 'mahalanobis':     return { fn: _mahalanobis, kind: 'mahalanobis' };
    default:
      throw new Error(`unknown metric: ${metric}`);
  }
}

// Gemm-accelerated euclidean / sqeuclidean. Uses ‖X−Y‖² = ‖X‖² + ‖Y‖² − 2XYᵀ.
// Returns Float64Array of length n*m, or null if dispatch failed.
//
// Centering: ‖X−Y‖² is invariant under translation, so we shift both X
// and Y by the centroid of their union before the gemm trick. This kills
// the catastrophic cancellation that hits when input magnitudes are large
// (e.g. UTM coordinates). Cost is O(nd + md), negligible vs the O(nmd)
// main work.
function _cdistEuclideanGemm(Xn, Yn, natra, squared) {
  try {
    // Compute joint centroid across X and Y per axis.
    const d = Xn.d;
    const c = new Float64Array(d);
    const total = Xn.n + Yn.n;
    for (let i = 0; i < Xn.n; i++) {
      const base = i * d;
      for (let k = 0; k < d; k++) c[k] += Xn.data[base + k];
    }
    for (let j = 0; j < Yn.n; j++) {
      const base = j * d;
      for (let k = 0; k < d; k++) c[k] += Yn.data[base + k];
    }
    for (let k = 0; k < d; k++) c[k] /= total;

    // Build centered copies (in JS — natra.array() will copy them into wasm).
    const Xc = new Float64Array(Xn.n * d);
    for (let i = 0; i < Xn.n; i++) {
      const base = i * d;
      for (let k = 0; k < d; k++) Xc[base + k] = Xn.data[base + k] - c[k];
    }
    const Yc = new Float64Array(Yn.n * d);
    for (let j = 0; j < Yn.n; j++) {
      const base = j * d;
      for (let k = 0; k < d; k++) Yc[base + k] = Yn.data[base + k] - c[k];
    }

    return natra.scope((s) => {
      const X = natra.array(Xc, { shape: [Xn.n, d] });
      const Y = natra.array(Yc, { shape: [Yn.n, d] });
      const XYt = s.matmul(X, Y.T);  // n × m
      const xy = natra.toTypedArray(XYt);
      // Row norms ‖Xᶜ[i]‖²
      const xnorm = new Float64Array(Xn.n);
      for (let i = 0; i < Xn.n; i++) {
        let sm = 0;
        const base = i * d;
        for (let k = 0; k < d; k++) {
          const v = Xc[base + k];
          sm += v * v;
        }
        xnorm[i] = sm;
      }
      // Col norms ‖Yᶜ[j]‖²
      const ynorm = new Float64Array(Yn.n);
      for (let j = 0; j < Yn.n; j++) {
        let sm = 0;
        const base = j * d;
        for (let k = 0; k < d; k++) {
          const v = Yc[base + k];
          sm += v * v;
        }
        ynorm[j] = sm;
      }
      const out = new Float64Array(Xn.n * Yn.n);
      if (squared) {
        for (let i = 0; i < Xn.n; i++) {
          const xi = xnorm[i];
          const baseRow = i * Yn.n;
          for (let j = 0; j < Yn.n; j++) {
            let v = xi + ynorm[j] - 2 * xy[baseRow + j];
            if (v < 0) v = 0;  // numerical noise — squared distances are non-negative
            out[baseRow + j] = v;
          }
        }
      } else {
        for (let i = 0; i < Xn.n; i++) {
          const xi = xnorm[i];
          const baseRow = i * Yn.n;
          for (let j = 0; j < Yn.n; j++) {
            let v = xi + ynorm[j] - 2 * xy[baseRow + j];
            if (v < 0) v = 0;
            out[baseRow + j] = Math.sqrt(v);
          }
        }
      }
      return out;
    });
  } catch (e) {
    return null;
  }
}

export function cdist(X, Y, opts = {}) {
  const metric = opts.metric || 'euclidean';
  const { fn, kind } = _resolveMetric(metric);
  const Xn = _normalize(X, opts);
  const Yn = _normalize(Y, opts);
  if (Xn.d !== Yn.d) {
    throw new RangeError(`dim mismatch: X.d=${Xn.d}, Y.d=${Yn.d}`);
  }
  // Try gemm acceleration on the cheap-to-decompose metrics. Skip if the
  // user explicitly forced inline, or if weights are present (gemm trick
  // doesn't compose cleanly with per-axis weights — would need a scaled
  // inner product instead).
  const canGemm = (metric === 'euclidean' || metric === 'sqeuclidean')
    && !opts.w
    && opts.backend !== 'inline'
    && Xn.n * Yn.n >= GEMM_NM_THRESHOLD;
  if (canGemm) {
    const natra = getNatra();
    if (natra) {
      const result = _cdistEuclideanGemm(Xn, Yn, natra, metric === 'sqeuclidean');
      if (result) return result;
    }
  }
  const d = Xn.d;
  const out = new Float64Array(Xn.n * Yn.n);
  const w = opts.w ? Float64Array.from(opts.w) : null;
  const p = opts.p ?? 2;
  const VI = opts.VI ? (opts.VI instanceof Float64Array ? opts.VI : Float64Array.from(opts.VI)) : null;
  const ai = new Float64Array(d);
  const bi = new Float64Array(d);

  for (let i = 0; i < Xn.n; i++) {
    for (let k = 0; k < d; k++) ai[k] = Xn.data[i * d + k];
    for (let j = 0; j < Yn.n; j++) {
      for (let k = 0; k < d; k++) bi[k] = Yn.data[j * d + k];
      let v;
      if (kind === 'simple') v = fn(ai, bi, d, w);
      else if (kind === 'noweight') v = fn(ai, bi, d);
      else if (kind === 'minkowski') v = fn(ai, bi, d, w, p);
      else if (kind === 'mahalanobis') {
        if (!VI) throw new Error('mahalanobis requires opts.VI');
        v = fn(ai, bi, d, VI);
      } else {
        // custom metric — pass slices as plain arrays (scipy parity)
        v = fn(ai, bi);
      }
      out[i * Yn.n + j] = v;
    }
  }
  return out;
}

export function pdist(X, opts = {}) {
  const metric = opts.metric || 'euclidean';
  const { fn, kind } = _resolveMetric(metric);
  const Xn = _normalize(X, opts);
  const d = Xn.d;
  const n = Xn.n;
  const w = opts.w ? Float64Array.from(opts.w) : null;
  const p = opts.p ?? 2;
  const VI = opts.VI ? (opts.VI instanceof Float64Array ? opts.VI : Float64Array.from(opts.VI)) : null;
  const out = new Float64Array((n * (n - 1)) / 2);
  const ai = new Float64Array(d);
  const bi = new Float64Array(d);

  let idx = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < d; k++) ai[k] = Xn.data[i * d + k];
    for (let j = i + 1; j < n; j++) {
      for (let k = 0; k < d; k++) bi[k] = Xn.data[j * d + k];
      let v;
      if (kind === 'simple') v = fn(ai, bi, d, w);
      else if (kind === 'noweight') v = fn(ai, bi, d);
      else if (kind === 'minkowski') v = fn(ai, bi, d, w, p);
      else if (kind === 'mahalanobis') {
        if (!VI) throw new Error('mahalanobis requires opts.VI');
        v = fn(ai, bi, d, VI);
      } else {
        v = fn(ai, bi);
      }
      out[idx++] = v;
    }
  }
  return out;
}

// Convert between condensed (pdist) and square forms.
//   squareform(packed) → full n×n Float64Array (n*n length, row-major)
//   squareform(square) → packed n*(n-1)/2 vector
//
// Shape inference: prefer packed→square (the common usage from pdist).
// Pass opts.checks = false to skip integrity checks. Pass opts.force =
// 'tovector' to force square→packed when input could be either.
export function squareform(arr, opts = {}) {
  if (!(arr instanceof Float64Array || ArrayBuffer.isView(arr) || Array.isArray(arr))) {
    throw new TypeError('squareform expects Float64Array or Array');
  }
  const len = arr.length;
  // Could it be a packed form k*(k-1)/2 for some k ≥ 2?
  const kFloat = (1 + Math.sqrt(1 + 8 * len)) / 2;
  const kRound = Math.round(kFloat);
  const looksPacked = len > 0
    && Math.abs(kFloat - kRound) < 1e-9
    && kRound * (kRound - 1) / 2 === len
    && kRound >= 2;
  // Could it be a square n*n?
  const sqRoot = Math.round(Math.sqrt(len));
  const looksSquare = sqRoot * sqRoot === len;

  if (opts.force === 'tovector' || (!looksPacked && looksSquare)) {
    // Square → packed (upper triangle).
    const n = sqRoot;
    const out = new Float64Array((n * (n - 1)) / 2);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) out[idx++] = arr[i * n + j];
    }
    return out;
  }
  if (looksPacked) {
    const n = kRound;
    const out = new Float64Array(n * n);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        out[i * n + j] = arr[idx];
        out[j * n + i] = arr[idx];
        idx++;
      }
    }
    return out;
  }
  throw new RangeError(`length ${len} is not a valid square or pdist size`);
}
