// series.js — Series + BooleanMask

class BooleanMask {
  constructor(values) { this._values = values; }
  __and__(other) { return new BooleanMask(this._values.map((v, i) => v && other._values[i])); }
  __or__(other) { return new BooleanMask(this._values.map((v, i) => v || other._values[i])); }
  __invert__() { return new BooleanMask(this._values.map(v => !v)); }
  __len__() { return this._values.length; }
  __bool__() { return this._values.some(v => v); }
  get length() { return this._values.length; }
}

class Series {
  constructor(values, name) {
    // Coerce non-Array iterables (natra ndarrays, TypedArrays, Sets…)
    // into a plain JS Array so the .map / .filter / .reduce surface
    // on Series works regardless of input shape. Cheap; Series sizes
    // in notebook workloads are nowhere near hot-loop hot.
    if (values != null
        && !Array.isArray(values)
        && typeof values !== 'string'
        && typeof values === 'object'
        && typeof values[Symbol.iterator] === 'function') {
      values = Array.from(values);
    }
    this._values = values;
    this._name = name || null;
  }
  get values() { return this._values; }
  get name() { return this._name; }

  // aggregation
  sum() { let s = 0; for (const v of this._values) if (v != null) s += v; return s; }
  mean() { let s = 0, n = 0; for (const v of this._values) if (v != null) { s += v; n++; } return n ? s / n : NaN; }
  median() {
    const sorted = this._values.filter(v => v != null).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[n >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
  }
  std() {
    const m = this.mean();
    let s = 0, n = 0;
    for (const v of this._values) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  }
  variance() {
    const m = this.mean();
    let s = 0, n = 0;
    for (const v of this._values) if (v != null) { s += (v - m) ** 2; n++; }
    return n > 1 ? s / (n - 1) : 0;
  }
  min() { let m = Infinity; for (const v of this._values) if (v != null && v < m) m = v; return m === Infinity ? NaN : m; }
  max() { let m = -Infinity; for (const v of this._values) if (v != null && v > m) m = v; return m === -Infinity ? NaN : m; }
  count() { let n = 0; for (const v of this._values) if (v != null) n++; return n; }

  // inspection
  unique() { return [...new Set(this._values)]; }
  nunique() { return new Set(this._values).size; }
  valueCounts() {
    const counts = new Map();
    for (const v of this._values) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  }

  // transform
  map(fn) { return new Series(this._values.map(fn), this._name); }
  apply(fn) { return new Series(this._values.map(fn), this._name); }
  clip(lo, hi) { return new Series(this._values.map(v => v == null ? v : Math.max(lo, Math.min(hi, v))), this._name); }
  round(n = 0) { const f = 10 ** n; return new Series(this._values.map(v => v == null ? v : Math.round(v * f) / f), this._name); }
  abs() { return new Series(this._values.map(v => v == null ? v : Math.abs(v)), this._name); }
  log() { return new Series(this._values.map(v => v == null ? v : Math.log(v)), this._name); }
  exp() { return new Series(this._values.map(v => v == null ? v : Math.exp(v)), this._name); }
  sqrt() { return new Series(this._values.map(v => v == null ? v : Math.sqrt(v)), this._name); }
  cumsum() {
    let s = 0;
    return new Series(this._values.map(v => { if (v != null) s += v; return s; }), this._name);
  }
  diff() {
    return new Series(this._values.map((v, i) => i === 0 ? null : (v != null && this._values[i - 1] != null ? v - this._values[i - 1] : null)), this._name);
  }
  sort(ascending = true) {
    const sorted = this._values.slice().sort((a, b) => a - b);
    return new Series(ascending ? sorted : sorted.reverse(), this._name);
  }
  isna() { return new BooleanMask(this._values.map(v => v == null || v !== v)); }
  isnull() { return this.isna(); }   // pandas exposes both names
  notna() { return new BooleanMask(this._values.map(v => v != null && v === v)); }
  notnull() { return this.notna(); }
  isin(vals) { const s = new Set(vals); return new BooleanMask(this._values.map(v => s.has(v))); }
  astype(type) {
    if (type === 'number' || type === 'float') return new Series(this._values.map(Number), this._name);
    if (type === 'string' || type === 'str') return new Series(this._values.map(String), this._name);
    return this;
  }

  // dunders for adder operator dispatch
  __add__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v + (ov ? ov[i] : other)), this._name); }
  __sub__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v - (ov ? ov[i] : other)), this._name); }
  __mul__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v * (ov ? ov[i] : other)), this._name); }
  __truediv__(other) { const ov = other instanceof Series ? other._values : null; return new Series(this._values.map((v, i) => v / (ov ? ov[i] : other)), this._name); }
  __neg__() { return new Series(this._values.map(v => -v), this._name); }
  __gt__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v > (ov ? ov[i] : other))); }
  __ge__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v >= (ov ? ov[i] : other))); }
  __lt__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v < (ov ? ov[i] : other))); }
  __le__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v <= (ov ? ov[i] : other))); }
  __eq__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v === (ov ? ov[i] : other))); }
  __ne__(other) { const ov = other instanceof Series ? other._values : null; return new BooleanMask(this._values.map((v, i) => v !== (ov ? ov[i] : other))); }
  __len__() { return this._values.length; }

  [Symbol.iterator]() { return this._values[Symbol.iterator](); }

  _repr_html_() {
    const n = this._values.length;
    const maxRows = 20;
    const show = Math.min(n, maxRows);
    const name = this._name || 'value';
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '<table style="border-collapse:collapse;font-family:var(--mono,monospace);font-size:12px">';
    html += `<tr><th style="padding:3px 8px;border-bottom:2px solid var(--fg-dim,#666);text-align:left">${esc(name)}</th></tr>`;
    for (let i = 0; i < show; i++) {
      const v = this._values[i];
      const text = v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, '')) : esc(String(v));
      const align = typeof v === 'number' ? 'right' : 'left';
      html += `<tr><td style="padding:2px 8px;border-bottom:1px solid var(--bg-cell,#333);text-align:${align}">${text}</td></tr>`;
    }
    html += '</table>';
    if (n > maxRows) html += `<div style="font-size:11px;color:var(--fg-dim,#888);margin-top:4px">\u2026 ${n} values</div>`;
    return html;
  }
}

export { Series, BooleanMask };
