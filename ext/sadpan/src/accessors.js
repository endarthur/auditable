// accessors.js — pandas-shape indexers (iloc, loc, at, iat) + RangeIndex.
//
// Pandas exposes four indexer accessors on DataFrames and Series. Each
// has slightly different semantics — they're kept as separate classes
// here rather than one indexer-with-modes so the resolution rules read
// straight off each class. All accessors return:
//
//   scalar row + scalar col  → scalar value
//   scalar row + plural col  → Series (row vector)
//   plural row + scalar col  → Series (column vector)
//   plural row + plural col  → DataFrame
//
// "Plural" = slice or list. The `_Selector` shape captures both the
// resolved index list and whether the original key was scalar — needed
// to decide return shape after resolution.
//
// iloc / iat treat keys as integer positions (negative = from end);
// loc / at treat keys as labels. With sadpan's default RangeIndex
// (rows labelled 0..n-1) the two collapse for row indexing; they diverge
// for columns where iloc takes integer position and loc takes column
// name. at / iat are scalar-only specialisations that raise on slices
// or lists — same as pandas.
//
// Importers: api.js wires `get iloc()` / `get loc()` etc. on DataFrame
// and Series; series.js needs only a subset (no column dimension).

// ── Internal selector shape ──
//
// _Selector = { indices: number[], scalar: boolean }
//   - indices: resolved positions in the underlying dimension
//   - scalar:  true iff the key was a single value (informs return type)

function _isSlice(k) { return k != null && k._slice === true; }
function _isPyKwargs(k) { return k != null && typeof k === 'object' && k._kw === true; }

function _resolveSliceToIndices(slice, n) {
  // Python-style slice with clamping: `arr[2:7]` on a 5-element array
  // yields indices [2, 3, 4] (not [2,3,4,5,6]). Both bounds clip to
  // [0, n] (or [-1, n-1] when step<0).
  const step = slice.step != null ? slice.step : 1;
  if (step === 0) throw new Error('slice step cannot be zero');
  let lo, hi;
  if (step > 0) {
    lo = slice.lower != null ? (slice.lower < 0 ? n + slice.lower : slice.lower) : 0;
    hi = slice.upper != null ? (slice.upper < 0 ? n + slice.upper : slice.upper) : n;
    if (lo < 0) lo = 0;
    if (hi > n) hi = n;
  } else {
    lo = slice.lower != null ? (slice.lower < 0 ? n + slice.lower : slice.lower) : n - 1;
    hi = slice.upper != null ? (slice.upper < 0 ? n + slice.upper : slice.upper) : -1;
    if (lo > n - 1) lo = n - 1;
    if (hi < -1) hi = -1;
  }
  const out = [];
  if (step > 0) for (let i = lo; i < hi; i += step) out.push(i);
  else for (let i = lo; i > hi; i += step) out.push(i);
  return out;
}

// ── iloc / iat — integer-position resolution ──

function _resolveByPosition(key, n) {
  if (typeof key === 'number') {
    const i = key < 0 ? n + key : key;
    if (i < 0 || i >= n) throw new Error(`positional index ${key} out of bounds for axis of length ${n}`);
    return { indices: [i], scalar: true };
  }
  if (_isSlice(key)) {
    return { indices: _resolveSliceToIndices(key, n), scalar: false };
  }
  if (Array.isArray(key)) {
    const idx = key.map(k => {
      if (typeof k !== 'number') throw new Error(`iloc list must contain integers, got ${typeof k}`);
      return k < 0 ? n + k : k;
    });
    return { indices: idx, scalar: false };
  }
  throw new Error(`unsupported iloc key type: ${typeof key}`);
}

// ── loc / at — label-based column resolution; row index lookup ──

function _resolveColByLabel(key, names) {
  if (typeof key === 'string') {
    const i = names.indexOf(key);
    if (i < 0) throw new Error(`column '${key}' not in DataFrame`);
    return { indices: [i], scalar: true };
  }
  if (_isSlice(key)) {
    // Pandas treats loc slices as INCLUSIVE on both ends, by label.
    // With default RangeIndex columns are anonymous → fall back to
    // integer positions when bounds are numeric, otherwise to label
    // lookup (find name → use that index).
    const lo = key.lower != null ? _labelToPos(key.lower, names) : 0;
    const hi = key.upper != null ? _labelToPos(key.upper, names) : names.length - 1;
    const step = key.step != null ? key.step : 1;
    const indices = [];
    if (step > 0) for (let i = lo; i <= hi; i += step) indices.push(i);
    else for (let i = lo; i >= hi; i += step) indices.push(i);
    return { indices, scalar: false };
  }
  if (Array.isArray(key)) {
    return {
      indices: key.map(k => _labelToPos(k, names)),
      scalar: false,
    };
  }
  throw new Error(`unsupported loc col key type: ${typeof key}`);
}

function _labelToPos(label, names) {
  if (typeof label === 'number') {
    const i = label < 0 ? names.length + label : label;
    if (i < 0 || i >= names.length) throw new Error(`column position ${label} out of bounds`);
    return i;
  }
  const i = names.indexOf(label);
  if (i < 0) throw new Error(`column '${label}' not in DataFrame`);
  return i;
}

// BooleanMask / boolean-array detection — accepts sadpan's BooleanMask
// shape ({_values: boolean[]}) or a plain JS array of booleans.
function _isBoolMask(key) {
  if (key && key._values && Array.isArray(key._values)
      && key._values.length > 0
      && typeof key._values[0] === 'boolean') return true;
  if (Array.isArray(key) && key.length > 0 && typeof key[0] === 'boolean') return true;
  return false;
}
function _maskToIndices(key) {
  const vals = key._values || key;
  const out = [];
  for (let i = 0; i < vals.length; i++) if (vals[i]) out.push(i);
  return out;
}

// Row resolution for loc: with default RangeIndex (rows 0..n-1) this is
// the same as positional resolution. When sadpan grows a real Index
// type with custom labels, this is the layer that needs to look up
// the label → position mapping.
function _resolveRowByLabel(key, n, index) {
  if (_isBoolMask(key)) {
    return { indices: _maskToIndices(key), scalar: false };
  }
  if (index && index._isRangeIndex !== true) {
    // Custom index — look up label
    if (typeof key === 'number' || typeof key === 'string') {
      const i = index._lookup(key);
      if (i < 0) throw new Error(`row label '${key}' not in index`);
      return { indices: [i], scalar: true };
    }
    if (Array.isArray(key)) {
      return {
        indices: key.map(k => {
          const i = index._lookup(k);
          if (i < 0) throw new Error(`row label '${k}' not in index`);
          return i;
        }),
        scalar: false,
      };
    }
    if (_isSlice(key)) {
      // Inclusive label slice — map to positions then iterate
      const lo = key.lower != null ? index._lookup(key.lower) : 0;
      const hi = key.upper != null ? index._lookup(key.upper) : n - 1;
      const step = key.step != null ? key.step : 1;
      const indices = [];
      if (step > 0) for (let i = lo; i <= hi; i += step) indices.push(i);
      else for (let i = lo; i >= hi; i += step) indices.push(i);
      return { indices, scalar: false };
    }
  }
  // Default RangeIndex — fall through to positional, but loc slices are
  // INCLUSIVE on both ends (pandas semantic).
  if (_isSlice(key)) {
    const lo = key.lower != null ? (key.lower < 0 ? n + key.lower : key.lower) : 0;
    const hi = key.upper != null ? (key.upper < 0 ? n + key.upper : key.upper) : n - 1;
    const step = key.step != null ? key.step : 1;
    const indices = [];
    if (step > 0) for (let i = lo; i <= hi; i += step) indices.push(i);
    else for (let i = lo; i >= hi; i += step) indices.push(i);
    return { indices, scalar: false };
  }
  return _resolveByPosition(key, n);
}

// ── DataFrame indexers ──
//
// All four follow the same shape: __getitem__(key) resolves into row
// and column selectors, then `_project(rows, cols)` materialises.

class _DfIndexer {
  constructor(df, resolveRow, resolveCol, scalarOnly) {
    this._df = df;
    this._resolveRow = resolveRow;
    this._resolveCol = resolveCol;
    this._scalarOnly = !!scalarOnly;
  }

  __getitem__(key) {
    const tbl = this._df._tbl;
    const names = tbl.columnNames();
    const nrows = tbl.numRows();
    const rowKey = Array.isArray(key) && key.length === 2 ? key[0] : key;
    const colKey = Array.isArray(key) && key.length === 2 ? key[1] : null;

    const rowSel = this._resolveRow(rowKey, nrows, this._df._index);
    // _resolveCol signatures differ: position-based takes a length,
    // label-based takes the names array (it needs the names to look up
    // labels). Branch on which resolver was wired in.
    const colSel = colKey != null
      ? this._resolveColInternal(colKey, names)
      : { indices: names.map((_, i) => i), scalar: false };

    if (this._scalarOnly && (!rowSel.scalar || !colSel.scalar)) {
      throw new Error('at/iat only accept scalar keys');
    }

    return this._project(rowSel, colSel);
  }

  _resolveColInternal(key, names) {
    // Integer-position resolvers want a length; label resolvers want
    // the names array. Detect by reference equality (the factories
    // wire either _resolveByPosition or _resolveColByLabel).
    if (this._resolveCol === _resolveByPosition) return this._resolveCol(key, names.length);
    return this._resolveCol(key, names);
  }

  __setitem__(key, value) {
    const tbl = this._df._tbl;
    const names = tbl.columnNames();
    const nrows = tbl.numRows();
    const rowKey = Array.isArray(key) && key.length === 2 ? key[0] : key;
    const colKey = Array.isArray(key) && key.length === 2 ? key[1] : null;

    const rowSel = this._resolveRow(rowKey, nrows, this._df._index);
    const colSel = colKey != null
      ? this._resolveColInternal(colKey, names)
      : { indices: names.map((_, i) => i), scalar: false };

    // Broadcast value to the selection. Scalar value → fill every
    // selected cell; iterable → must match selection cardinality.
    const isIterable = value != null
      && typeof value !== 'string'
      && typeof value[Symbol.iterator] === 'function';

    if (!isIterable) {
      for (const ri of rowSel.indices) {
        for (const ci of colSel.indices) {
          const colName = names[ci];
          tbl._columns[colName][ri] = value;
        }
      }
      return;
    }

    const flat = [...value];
    // Single-column case: flat values map to rows
    if (colSel.indices.length === 1) {
      const colName = names[colSel.indices[0]];
      if (flat.length !== rowSel.indices.length) {
        throw new Error(`length mismatch: assigning ${flat.length} values to ${rowSel.indices.length} rows`);
      }
      for (let i = 0; i < flat.length; i++) {
        tbl._columns[colName][rowSel.indices[i]] = flat[i];
      }
      return;
    }
    // Single-row case: flat values map to cols
    if (rowSel.indices.length === 1) {
      if (flat.length !== colSel.indices.length) {
        throw new Error(`length mismatch: assigning ${flat.length} values to ${colSel.indices.length} columns`);
      }
      for (let i = 0; i < flat.length; i++) {
        const colName = names[colSel.indices[i]];
        tbl._columns[colName][rowSel.indices[0]] = flat[i];
      }
      return;
    }
    throw new Error('multi-row multi-col assignment from iterable not supported — pass a scalar instead');
  }

  // Materialise the selection. Return type depends on scalarness:
  //   scalar+scalar → value
  //   scalar+plural → Series (row vector, one element per selected col)
  //   plural+scalar → Series (column vector)
  //   plural+plural → DataFrame
  _project(rowSel, colSel) {
    const tbl = this._df._tbl;
    const names = tbl.columnNames();

    if (rowSel.scalar && colSel.scalar) {
      const ri = rowSel.indices[0];
      const ci = colSel.indices[0];
      return tbl._columns[names[ci]][ri];
    }

    if (rowSel.scalar) {
      // Row vector across selected columns → Series indexed by col name
      const ri = rowSel.indices[0];
      const values = colSel.indices.map(ci => tbl._columns[names[ci]][ri]);
      return this._df._makeSeriesLike(values, colSel.indices.map(ci => names[ci]));
    }

    if (colSel.scalar) {
      // Column vector → Series with the column name
      const ci = colSel.indices[0];
      const colName = names[ci];
      const values = rowSel.indices.map(ri => tbl._columns[colName][ri]);
      return this._df._makeSeriesLike(values, null, colName);
    }

    // Both plural → DataFrame
    const outCols = {};
    const outNames = [];
    for (const ci of colSel.indices) {
      const colName = names[ci];
      outNames.push(colName);
      outCols[colName] = rowSel.indices.map(ri => tbl._columns[colName][ri]);
    }
    return this._df._makeFrameLike(outCols, outNames);
  }
}

// ── Series indexers (one-dim) ──
//
// Series.iloc[i], Series.iloc[i:j], Series.iloc[[i, j]]. loc differs
// only when the series has a custom index; with default RangeIndex
// it's positional.

class _SeriesIndexer {
  constructor(series, resolve, scalarOnly) {
    this._s = series;
    this._resolve = resolve;
    this._scalarOnly = !!scalarOnly;
  }

  __getitem__(key) {
    const values = this._s._values;
    const sel = this._resolve(key, values.length, this._s._index);
    if (this._scalarOnly && !sel.scalar) {
      throw new Error('at/iat only accept scalar keys');
    }
    if (sel.scalar) return values[sel.indices[0]];
    return this._s._makeLike(sel.indices.map(i => values[i]));
  }

  __setitem__(key, value) {
    const values = this._s._values;
    const sel = this._resolve(key, values.length, this._s._index);
    if (this._scalarOnly && !sel.scalar) {
      throw new Error('at/iat only accept scalar keys');
    }
    const isIterable = value != null
      && typeof value !== 'string'
      && typeof value[Symbol.iterator] === 'function';
    if (!isIterable) {
      for (const i of sel.indices) values[i] = value;
      return;
    }
    const flat = [...value];
    if (flat.length !== sel.indices.length) {
      throw new Error(`length mismatch: assigning ${flat.length} values to ${sel.indices.length} positions`);
    }
    for (let i = 0; i < flat.length; i++) values[sel.indices[i]] = flat[i];
  }
}

// ── RangeIndex / labelled Index ──

class _RangeIndex {
  constructor(n) { this._n = n; this._isRangeIndex = true; }
  get name() { return null; }
  get size() { return this._n; }
  get values() { return this.tolist(); }
  __len__() { return this._n; }
  __getitem__(key) {
    if (typeof key === 'number') {
      const i = key < 0 ? this._n + key : key;
      if (i < 0 || i >= this._n) throw new Error(`index ${key} out of bounds`);
      return i;
    }
    if (_isSlice(key)) {
      return _resolveSliceToIndices(key, this._n);
    }
    throw new Error(`unsupported index key: ${typeof key}`);
  }
  __iter__() { return this[Symbol.iterator](); }
  *[Symbol.iterator]() { for (let i = 0; i < this._n; i++) yield i; }
  tolist() { const a = new Array(this._n); for (let i = 0; i < this._n; i++) a[i] = i; return a; }
  toString() { return `RangeIndex(start=0, stop=${this._n}, step=1)`; }
}

// Labelled index — kept for when sadpan gets explicit row labels.
// _lookup(label) returns the position or -1.
class _Index {
  constructor(labels, name) {
    this._labels = Array.isArray(labels) ? labels.slice() : [...labels];
    this._name = name || null;
    this._lut = new Map();
    for (let i = 0; i < this._labels.length; i++) this._lut.set(this._labels[i], i);
  }
  get name() { return this._name; }
  get size() { return this._labels.length; }
  get values() { return this._labels.slice(); }
  __len__() { return this._labels.length; }
  __getitem__(key) {
    if (typeof key === 'number') {
      const i = key < 0 ? this._labels.length + key : key;
      return this._labels[i];
    }
    if (_isSlice(key)) {
      return _resolveSliceToIndices(key, this._labels.length).map(i => this._labels[i]);
    }
    throw new Error(`unsupported index key: ${typeof key}`);
  }
  _lookup(label) {
    return this._lut.has(label) ? this._lut.get(label) : -1;
  }
  *[Symbol.iterator]() { yield* this._labels; }
  tolist() { return this._labels.slice(); }
  toString() { return `Index(${this._labels.length} labels)`; }
}

// ── Factory functions — wire up the indexers for a given DataFrame ──

export function makeIloc(df) {
  return new _DfIndexer(df, _resolveByPosition, _resolveByPosition, false);
}
export function makeLoc(df) {
  return new _DfIndexer(df, _resolveRowByLabel, _resolveColByLabel, false);
}
export function makeAt(df) {
  return new _DfIndexer(df, _resolveRowByLabel, _resolveColByLabel, true);
}
export function makeIat(df) {
  return new _DfIndexer(df, _resolveByPosition, _resolveByPosition, true);
}

export function makeSeriesIloc(series) {
  return new _SeriesIndexer(series, _resolveByPosition, false);
}
export function makeSeriesLoc(series) {
  return new _SeriesIndexer(series, _resolveRowByLabel, false);
}
export function makeSeriesAt(series) {
  return new _SeriesIndexer(series, _resolveRowByLabel, true);
}
export function makeSeriesIat(series) {
  return new _SeriesIndexer(series, _resolveByPosition, true);
}

export { _RangeIndex, _Index };
