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

/**
 * Capture sklearn's `feature_names_in_` attribute on a fitted estimator
 * when the asMatrix result carries column names (input was a sadpan
 * Table, DataFrame, or named-column object). No-op otherwise.
 *
 * Estimators call this at end-of-fit, after validation, to thread the
 * column names from the boundary to the fitted state. Cheap and
 * idempotent; dump/load preserves it through mimic-io's default codec.
 */
export function captureFeatureNames(est, X_info) {
  if (X_info && X_info.feature_names) {
    est.feature_names_in_ = X_info.feature_names.slice();
  }
}

// ────────────────────────────────────────────────────────────────────
// Table-shaped input helpers (used by asMatrix and from_table)
// ────────────────────────────────────────────────────────────────────

/**
 * Detect what kind of table-shaped input `df` is. Returns one of:
 *   'table'  — sadpan Table (numRows + array + columnNames)
 *   'df'     — sadpan DataFrame (columns array + __getitem__ + .shape)
 *   'plain'  — plain JS object with named array-like columns
 *   null     — none of the above
 */
export function detectTable(df) {
  if (df == null || typeof df !== 'object') return null;
  if (Array.isArray(df) || ArrayBuffer.isView(df)) return null;
  if (typeof df.numRows === 'function'
      && typeof df.array === 'function'
      && typeof df.columnNames === 'function') return 'table';
  if (Array.isArray(df.columns)
      && typeof df.__getitem__ === 'function'
      && Array.isArray(df.shape) && df.shape.length === 2) return 'df';
  // Plain object: same heuristic as asMatrix's _looksLikeNamedColumns.
  const keys = Object.keys(df);
  if (keys.length === 0) return null;
  if (keys.includes('data') && keys.includes('shape')) return null;
  const first = df[keys[0]];
  if (first == null || typeof first.length !== 'number') return null;
  return 'plain';
}

/** Get the list of column names for a table-shaped input. */
export function tableColumns(df, kind) {
  if (kind === 'table') return df.columnNames();
  if (kind === 'df') return df.columns;
  return Object.keys(df);
}

/** Get the row count of a table-shaped input. */
export function tableNumRows(df, kind) {
  if (kind === 'table') return df.numRows();
  if (kind === 'df') return df.shape[0];
  // plain
  const keys = Object.keys(df);
  return df[keys[0]].length;
}

/**
 * Extract a single column by name. Returns the raw column data (any
 * array-like). Caller decides whether to coerce to numeric or treat
 * as labels.
 */
export function tableColumn(df, kind, name) {
  if (kind === 'table') return df.array(name);
  if (kind === 'df') {
    const series = df.__getitem__(name);
    return series.values;
  }
  return df[name];
}

// Coerce X to a 2D Float64Array view. Accepts:
//   - Float64Array with `.shape` set (natra-shaped): pass through
//   - 2D Array of Arrays of numbers: flatten + record shape
//   - { data: TypedArray, shape: [n, m] }: pass through with shape
//   - sadpan Table (numRows + array + columnNames): stack columns
//   - sadpan DataFrame (shape + columns + __getitem__):  stack columns
//   - plain JS object with named numeric-array columns ({a: [...], b: [...]}):
//     stack in declaration order
// Returns { data: Float64Array, shape: [n, m], feature_names? }.
// `feature_names` is set only when input carried column names — estimators
// pick it up to populate sklearn's `feature_names_in_` attribute.
export function asMatrix(X, { name = 'X', allow_nan = false } = {}) {
  if (X == null) {
    throw new ValidationError(`${name}: input is ${X}`);
  }
  // Already in our normalized form.
  if (X instanceof Float64Array && Array.isArray(X.shape) && X.shape.length === 2) {
    if (!allow_nan) _checkFiniteFlat(X, name);
    const out = { data: X, shape: X.shape };
    if (X.feature_names) out.feature_names = X.feature_names;
    return out;
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
    const out = { data: X.data, shape: [X.shape[0], X.shape[1]] };
    if (X.feature_names) out.feature_names = X.feature_names;
    return out;
  }
  // sadpan Table — duck-type: numRows() + array(name) + columnNames().
  if (typeof X === 'object'
      && typeof X.numRows === 'function'
      && typeof X.array === 'function'
      && typeof X.columnNames === 'function') {
    const cols = X.columnNames();
    return _stackNamedColumns(name, cols, c => X.array(c), X.numRows(), allow_nan);
  }
  // sadpan DataFrame — duck-type: .columns array + __getitem__(name) →
  // Series w/ .values, plus .shape array.
  if (typeof X === 'object'
      && Array.isArray(X.columns)
      && typeof X.__getitem__ === 'function'
      && Array.isArray(X.shape) && X.shape.length === 2) {
    const cols = X.columns;
    return _stackNamedColumns(name, cols,
      c => X.__getitem__(c).values, X.shape[0], allow_nan);
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
  // Plain JS object with named columns: { col1: [...], col2: [...] }.
  // Skip for {data, shape} which is handled above. Detect by: not an
  // array, not a typed array, has at least one own property whose value
  // is an array of numbers.
  if (typeof X === 'object'
      && !ArrayBuffer.isView(X)
      && !Array.isArray(X)
      && _looksLikeNamedColumns(X)) {
    const cols = Object.keys(X);
    const n = X[cols[0]].length;
    return _stackNamedColumns(name, cols, c => X[c], n, allow_nan);
  }
  // 1D array fallback — sklearn raises here, recommending reshape(-1, 1).
  if (Array.isArray(X) || (X.constructor && X.constructor.name.endsWith('Array'))) {
    throw new ValidationError(
      `${name}: expected 2D input (samples × features). Got 1D; reshape ` +
      `to a 2D array of shape (n, 1) for single-feature data.`);
  }
  throw new ValidationError(`${name}: unrecognized shape (${typeof X})`);
}

function _looksLikeNamedColumns(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  // First column must be array-like with a length.
  const first = obj[keys[0]];
  if (first == null) return false;
  if (typeof first.length !== 'number') return false;
  // Reject if it looks like {data, shape} (handled earlier) — keys would be
  // exactly 'data' and 'shape'. Also reject Series (already detected via
  // duck-type elsewhere).
  if (keys.includes('data') && keys.includes('shape')) return false;
  return true;
}

// Stack named columns into a row-major Float64Array. `getCol(name)` returns
// the column data (any array-like). Validates that all columns share the
// same length and that values are finite (when allow_nan=false).
function _stackNamedColumns(name, cols, getCol, n, allow_nan) {
  const m = cols.length;
  if (m === 0) {
    throw new ValidationError(`${name}: input has no columns`);
  }
  const out = new Float64Array(n * m);
  for (let j = 0; j < m; j++) {
    const col = getCol(cols[j]);
    if (col == null || typeof col.length !== 'number') {
      throw new ValidationError(`${name}: column '${cols[j]}' is not array-like`);
    }
    if (col.length !== n) {
      throw new ValidationError(
        `${name}: column '${cols[j]}' has length ${col.length}, expected ${n}`);
    }
    for (let i = 0; i < n; i++) {
      const v = +col[i];
      if (!allow_nan && !Number.isFinite(v)) {
        throw new ValidationError(
          `${name}: non-finite value in column '${cols[j]}' at row ${i}`);
      }
      out[i * m + j] = v;
    }
  }
  return { data: out, shape: [n, m], feature_names: cols.slice() };
}

// Coerce y to a 1D Float64Array. Accepts plain Array, Float64Array,
// Int32Array, sadpan Series (anything with .values), etc.
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
  // sadpan Series duck-type: anything carrying a .values array. Catches
  // both DataFrame.__getitem__ output and explicit Series instances.
  if (typeof y === 'object' && Array.isArray(y.values)) {
    return asVector(y.values, { name, allow_nan });
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
