// Input validation primitives shared across estimators.
//
// Two principles:
//   1) Validate at the API boundary (fit/predict/transform). Internal
//      helpers trust their inputs.
//   2) Errors are clear and name the offending field. NaN/Inf checks are
//      gated by tags (an estimator with `allow_nan: true` skips them).

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}

// Coerce X to a 2D Float64Array view. Accepts:
//   - Float64Array with `.shape` set (natra-shaped): pass through
//   - 2D Array of Arrays of numbers: flatten + record shape
//   - { data: TypedArray, shape: [n, m] }: pass through with shape
// Returns { data: Float64Array, shape: [n, m] }. Does not copy when the
// input is already a Float64Array of correct shape.
export function asMatrix(X, { name = 'X', allow_nan = false } = {}) {
  if (X == null) {
    throw new ValidationError(`${name}: input is ${X}`);
  }
  // Already in our normalized form.
  if (X instanceof Float64Array && Array.isArray(X.shape) && X.shape.length === 2) {
    if (!allow_nan) _checkFiniteFlat(X, name);
    return { data: X, shape: X.shape };
  }
  // { data, shape } shape (natra-style ndarray with extra fields).
  if (typeof X === 'object' && X.data instanceof Float64Array
      && Array.isArray(X.shape) && X.shape.length === 2) {
    const total = X.shape[0] * X.shape[1];
    if (X.data.length < total) {
      throw new ValidationError(
        `${name}: data length ${X.data.length} < shape product ${total}`);
    }
    if (!allow_nan) _checkFiniteFlat(X.data, name, total);
    return { data: X.data, shape: [X.shape[0], X.shape[1]] };
  }
  // 2D nested array (rows of columns).
  if (Array.isArray(X) && X.length > 0 && Array.isArray(X[0])) {
    const n = X.length;
    const m = X[0].length;
    const out = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      if (!Array.isArray(row) || row.length !== m) {
        throw new ValidationError(
          `${name}: row ${i} has length ${row?.length ?? '?'}, expected ${m}`);
      }
      for (let j = 0; j < m; j++) {
        const v = +row[j];
        if (!allow_nan && !Number.isFinite(v)) {
          throw new ValidationError(`${name}: non-finite value at row ${i} col ${j}`);
        }
        out[i * m + j] = v;
      }
    }
    return { data: out, shape: [n, m] };
  }
  // 1D array fallback — sklearn raises here, recommending reshape(-1, 1).
  if (Array.isArray(X) || (X.constructor && X.constructor.name.endsWith('Array'))) {
    throw new ValidationError(
      `${name}: expected 2D input (samples × features). Got 1D; reshape ` +
      `to a 2D array of shape (n, 1) for single-feature data.`);
  }
  throw new ValidationError(`${name}: unrecognized shape (${typeof X})`);
}

// Coerce y to a 1D Float64Array. Accepts plain Array, Float64Array,
// Int32Array, etc.
export function asVector(y, { name = 'y', allow_nan = false } = {}) {
  if (y == null) throw new ValidationError(`${name}: input is ${y}`);
  if (y instanceof Float64Array) {
    if (!allow_nan) _checkFiniteFlat(y, name);
    return y;
  }
  if (ArrayBuffer.isView(y) && !(y instanceof DataView)) {
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i];
    if (!allow_nan) _checkFiniteFlat(out, name);
    return out;
  }
  if (Array.isArray(y)) {
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const v = +y[i];
      if (!allow_nan && !Number.isFinite(v)) {
        throw new ValidationError(`${name}: non-finite value at index ${i}`);
      }
      out[i] = v;
    }
    return out;
  }
  throw new ValidationError(`${name}: unrecognized shape (${typeof y})`);
}

// Verify n_features matches what the estimator saw at fit time.
export function checkNFeatures(est, X_shape, { name = 'X' } = {}) {
  if (est.n_features_in_ == null) return;
  if (X_shape[1] !== est.n_features_in_) {
    throw new ValidationError(
      `${name} has ${X_shape[1]} features, but ${est.constructor.name} ` +
      `was fitted with ${est.n_features_in_} features`);
  }
}

function _checkFiniteFlat(arr, name, len) {
  const n = len ?? arr.length;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new ValidationError(`${name}: non-finite value at flat index ${i}`);
    }
  }
}
