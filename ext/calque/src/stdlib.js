// Standard library — runtime functions operating on calque values
//
// All functions have 1:1 xlsx formula equivalents.
// Operate on scalars, Float64Array columns, string[] columns, Uint8Array boolean columns.

export function isColumn(v) {
  return v instanceof Float64Array || v instanceof Uint8Array || Array.isArray(v);
}

export function columnLength(v) {
  if (v instanceof Float64Array || v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.length;
  return 0;
}

export function isTable(v) {
  return v && typeof v === 'object' && v.__table === true;
}

export function isFunc(v) {
  return v && typeof v === 'object' && v.__func === true;
}

// ── Type coercion (Excel rules) ──

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? NaN : n; // #VALUE! in Excel
  }
  return NaN;
}

function toString(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

// ── Broadcasting ──

export function broadcast(op, a, b) {
  const aIsCol = isColumn(a);
  const bIsCol = isColumn(b);

  if (!aIsCol && !bIsCol) return op(a, b);

  if (aIsCol && bIsCol) {
    const len = a.length;
    if (b.length !== len) throw new Error(`Column length mismatch: ${len} vs ${b.length}`);
    const result = new Array(len);
    for (let i = 0; i < len; i++) result[i] = op(a[i], b[i]);
    return inferColumnType(result);
  }

  if (aIsCol) {
    const len = a.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) result[i] = op(a[i], b);
    return inferColumnType(result);
  }

  // bIsCol
  const len = b.length;
  const result = new Array(len);
  for (let i = 0; i < len; i++) result[i] = op(a, b[i]);
  return inferColumnType(result);
}

export function broadcastUnary(op, a) {
  if (!isColumn(a)) return op(a);
  const len = a.length;
  const result = new Array(len);
  for (let i = 0; i < len; i++) result[i] = op(a[i]);
  return inferColumnType(result);
}

function inferColumnType(arr) {
  if (arr.length === 0) return new Float64Array(0);
  const first = arr[0];
  if (typeof first === 'number') {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  }
  if (typeof first === 'boolean' || first === 0 || first === 1) {
    // check if all are boolean-like
    let allBool = true;
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'boolean' && arr[i] !== 0 && arr[i] !== 1) { allBool = false; break; }
    }
    if (allBool) {
      const out = new Uint8Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = arr[i] ? 1 : 0;
      return out;
    }
  }
  if (typeof first === 'string') return arr;
  // mixed — return as-is
  return arr;
}

// ── Arithmetic operations ──

export const ops = {
  '+':  (a, b) => toNumber(a) + toNumber(b),
  '-':  (a, b) => toNumber(a) - toNumber(b),
  '*':  (a, b) => toNumber(a) * toNumber(b),
  '/':  (a, b) => { const d = toNumber(b); return d === 0 ? NaN : toNumber(a) / d; }, // #DIV/0!
  '^':  (a, b) => Math.pow(toNumber(a), toNumber(b)),
  '&':  (a, b) => toString(a) + toString(b),
  '==': (a, b) => a === b,
  '/=': (a, b) => a !== b,
  '!=': (a, b) => a !== b,
  '<':  (a, b) => toNumber(a) < toNumber(b),
  '>':  (a, b) => toNumber(a) > toNumber(b),
  '<=': (a, b) => toNumber(a) <= toNumber(b),
  '>=': (a, b) => toNumber(a) >= toNumber(b),
  'and': (a, b) => !!(a && b),
  'or':  (a, b) => !!(a || b),
  'neg': (a) => -toNumber(a),
  'not': (a) => !a,
};

// ── Range ──

export function makeRange(start, end) {
  const s = Math.round(toNumber(start));
  const e = Math.round(toNumber(end));
  const len = Math.max(0, e - s + 1);
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = s + i;
  return out;
}

// ── Standard library functions ──

export const stdlib = {};

// Reductions
stdlib.sum = function(col) {
  if (!isColumn(col)) return toNumber(col);
  let s = 0;
  for (let i = 0; i < col.length; i++) s += toNumber(col[i]);
  return s;
};

stdlib.mean = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return NaN;
  return stdlib.sum(col) / col.length;
};

stdlib.count = function(col) {
  if (!isColumn(col)) return col === null || col === undefined ? 0 : 1;
  let c = 0;
  for (let i = 0; i < col.length; i++) {
    if (col[i] !== null && col[i] !== undefined) c++;
  }
  return c;
};

stdlib.min = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return Infinity;
  let m = Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = toNumber(col[i]);
    if (v < m) m = v;
  }
  return m;
};

stdlib.max = function(col) {
  if (!isColumn(col)) return toNumber(col);
  if (col.length === 0) return -Infinity;
  let m = -Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = toNumber(col[i]);
    if (v > m) m = v;
  }
  return m;
};

// Lookup
stdlib.lookup = function(needle, keys, values, opts) {
  if (!isColumn(keys)) throw new Error('lookup: keys must be a column');
  if (!isColumn(values)) throw new Error('lookup: values must be a column');

  const nearestMode = opts && opts.nearest;

  if (isColumn(needle)) {
    // vectorized lookup
    const result = new Array(needle.length);
    for (let i = 0; i < needle.length; i++) {
      result[i] = lookupOne(needle[i], keys, values, nearestMode);
    }
    return inferColumnType(result);
  }

  return lookupOne(needle, keys, values, nearestMode);
};

function lookupOne(needle, keys, values, nearestMode) {
  if (nearestMode === 'below') {
    // find largest key <= needle
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = 0; i < keys.length; i++) {
      const k = toNumber(keys[i]);
      if (k <= toNumber(needle) && k > bestVal) { bestVal = k; bestIdx = i; }
    }
    return bestIdx >= 0 ? values[bestIdx] : null; // #N/A
  }
  // exact match
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === needle) return values[i];
  }
  return null; // #N/A
}

// Sort
stdlib.sort = function(table, col, opts) {
  if (isTable(table)) {
    const desc = opts && (opts.desc === true || opts === true);
    // sort table by column
    const indices = Array.from({ length: table.rows }, (_, i) => i);
    indices.sort((a, b) => {
      const va = col[a], vb = col[b];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : toNumber(va) - toNumber(vb);
      return desc ? -cmp : cmp;
    });
    const result = { __table: true, columns: {}, headers: [...table.headers], rows: table.rows };
    for (const h of table.headers) {
      const src = table.columns[h];
      if (src instanceof Float64Array) {
        const out = new Float64Array(table.rows);
        for (let i = 0; i < table.rows; i++) out[i] = src[indices[i]];
        result.columns[h] = out;
      } else {
        const out = new Array(table.rows);
        for (let i = 0; i < table.rows; i++) out[i] = src[indices[i]];
        result.columns[h] = out;
      }
    }
    return result;
  }
  // sort a column
  if (!isColumn(col)) col = table; // sort(col) short form
  const arr = Array.from(table);
  const desc = col === true || (opts && opts.desc === true);
  arr.sort((a, b) => {
    if (typeof a === 'string') return desc ? b.localeCompare(a) : a.localeCompare(b);
    return desc ? toNumber(b) - toNumber(a) : toNumber(a) - toNumber(b);
  });
  return inferColumnType(arr);
};

// Unique
stdlib.unique = function(col) {
  if (!isColumn(col)) return col;
  const seen = new Set();
  const result = [];
  for (let i = 0; i < col.length; i++) {
    if (!seen.has(col[i])) { seen.add(col[i]); result.push(col[i]); }
  }
  return inferColumnType(result);
};

// Scan
stdlib.scan = function(col, init, fn) {
  if (!isColumn(col)) throw new Error('scan: first argument must be a column');
  const result = new Array(col.length);
  let acc = init;
  for (let i = 0; i < col.length; i++) {
    if (isFunc(fn)) {
      acc = fn.__body(acc, col[i]);
    } else if (typeof fn === 'function') {
      acc = fn(acc, col[i]);
    } else {
      throw new Error('scan: third argument must be a function');
    }
    result[i] = acc;
  }
  return inferColumnType(result);
};

// Rolling
stdlib.rolling = function(col, window, fn) {
  if (!isColumn(col)) throw new Error('rolling: first argument must be a column');
  const w = Math.round(toNumber(window));
  const result = new Array(col.length);
  for (let i = 0; i < col.length; i++) {
    const start = Math.max(0, i - w + 1);
    const slice = col.slice(start, i + 1);
    if (isFunc(fn)) {
      result[i] = fn.__body(slice);
    } else if (typeof fn === 'function') {
      result[i] = fn(slice);
    } else if (typeof fn === 'string' && stdlib[fn]) {
      result[i] = stdlib[fn](slice);
    } else {
      throw new Error('rolling: third argument must be a function');
    }
  }
  return inferColumnType(result);
};

// String functions
stdlib.left = function(s, n) {
  n = Math.round(toNumber(n));
  return broadcast((s, _) => toString(s).slice(0, n), s, 0);
};

stdlib.right = function(s, n) {
  n = Math.round(toNumber(n));
  return broadcast((s, _) => { const str = toString(s); return str.slice(Math.max(0, str.length - n)); }, s, 0);
};

stdlib.mid = function(s, start, n) {
  start = Math.round(toNumber(start));
  n = Math.round(toNumber(n));
  // Excel MID is 1-indexed
  return broadcastUnary(v => toString(v).slice(start - 1, start - 1 + n), s);
};

stdlib.len = function(s) {
  return broadcastUnary(v => toString(v).length, s);
};

stdlib.trim = function(s) {
  return broadcastUnary(v => toString(v).trim(), s);
};

stdlib.text = function(val, fmt) {
  // Simple formatting - full Excel format codes would be Phase 2
  return broadcastUnary(v => {
    if (typeof fmt === 'string' && fmt.includes('#')) {
      // numeric format: count decimal places from format
      const decMatch = fmt.match(/\.(0+|#+)/);
      const decimals = decMatch ? decMatch[1].length : 0;
      return toNumber(v).toFixed(decimals);
    }
    return toString(v);
  }, val);
};

stdlib.str = function(val) {
  return broadcastUnary(v => toString(v), val);
};

// Date functions (Excel serial number system)
// Excel epoch: 1899-12-30 (with 1900 leap year bug). Use UTC to avoid DST issues.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

function dateToSerial(y, m, d) {
  const ms = Date.UTC(y, m - 1, d) - EXCEL_EPOCH;
  let serial = Math.floor(ms / MS_PER_DAY);
  // 1900 leap year bug: Excel thinks Feb 29, 1900 exists (serial 60)
  if (serial >= 60) serial++;
  return serial;
}

function serialToDate(serial) {
  if (serial >= 61) serial--; // undo 1900 leap year bug
  return new Date(EXCEL_EPOCH + serial * MS_PER_DAY);
}

stdlib.date = function(y, m, d) {
  return dateToSerial(toNumber(y), toNumber(m), toNumber(d));
};

stdlib.year = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCFullYear(), serial);
};

stdlib.month = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCMonth() + 1, serial);
};

stdlib.day = function(serial) {
  return broadcastUnary(v => serialToDate(toNumber(v)).getUTCDate(), serial);
};

stdlib.today = function() {
  const now = new Date();
  return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
};

// Error functions
stdlib.iferror = function(expr, fallback) {
  if (isColumn(expr)) {
    const result = new Array(expr.length);
    for (let i = 0; i < expr.length; i++) {
      const v = expr[i];
      result[i] = (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ?
        (isColumn(fallback) ? fallback[i] : fallback) : v;
    }
    return inferColumnType(result);
  }
  return (expr === null || expr === undefined || (typeof expr === 'number' && isNaN(expr))) ? fallback : expr;
};

stdlib.ifna = function(expr, fallback) {
  // In our runtime, #N/A is represented as null
  if (isColumn(expr)) {
    const result = new Array(expr.length);
    for (let i = 0; i < expr.length; i++) {
      result[i] = (expr[i] === null) ?
        (isColumn(fallback) ? fallback[i] : fallback) : expr[i];
    }
    return inferColumnType(result);
  }
  return expr === null ? fallback : expr;
};

// Math functions
stdlib.round = function(val, digits) {
  const d = digits !== undefined ? Math.round(toNumber(digits)) : 0;
  const factor = Math.pow(10, d);
  return broadcastUnary(v => Math.round(toNumber(v) * factor) / factor, val);
};

stdlib.abs = function(val) {
  return broadcastUnary(v => Math.abs(toNumber(v)), val);
};

stdlib.floor = function(val) {
  return broadcastUnary(v => Math.floor(toNumber(v)), val);
};

stdlib.ceil = function(val) {
  return broadcastUnary(v => Math.ceil(toNumber(v)), val);
};

stdlib.sqrt = function(val) {
  return broadcastUnary(v => Math.sqrt(toNumber(v)), val);
};

stdlib.log = function(val, base) {
  const b = base !== undefined ? toNumber(base) : 10;
  return broadcastUnary(v => Math.log(toNumber(v)) / Math.log(b), val);
};

stdlib.exp = function(val) {
  return broadcastUnary(v => Math.exp(toNumber(v)), val);
};

stdlib.mod = function(val, divisor) {
  return broadcast((a, b) => {
    const d = toNumber(b);
    return d === 0 ? NaN : toNumber(a) % d;
  }, val, divisor);
};
