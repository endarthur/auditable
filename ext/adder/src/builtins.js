// adder v2 — builtins, modules, format specs
// Python built-in functions, method dispatch, and standard modules.
// All functions are sync unless they need to call user-provided callables
// (which are async since the evaluator is async).

// ── PyRange — lazy range ──

export class AdderRange {
  constructor(start, stop, step) {
    if (stop === undefined) { this.start = 0; this.stop = start; this.step = 1; }
    else { this.start = start; this.stop = stop; this.step = step || 1; }
    if (this.step === 0) throw new AdderError('ValueError', 'range() arg 3 must not be zero');
    this.length = Math.max(0, Math.ceil((this.stop - this.start) / this.step));
  }
  [Symbol.iterator]() {
    let i = this.start;
    const stop = this.stop, step = this.step;
    return { next() {
      if (step > 0 ? i < stop : i > stop) { const v = i; i += step; return { value: v, done: false }; }
      return { done: true };
    }};
  }
  includes(v) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return false;
    if (this.step > 0) { if (v < this.start || v >= this.stop) return false; }
    else { if (v > this.start || v <= this.stop) return false; }
    return (v - this.start) % this.step === 0;
  }
}

// ── AdderError ──

export class AdderError extends Error {
  constructor(pyType, message, adderLine) {
    super(`${pyType}: ${message}${adderLine ? ` (line ${adderLine})` : ''}`);
    this.pyType = pyType;
    this.pyMessage = message;
    this.adderLine = adderLine;
  }
}

// ── type helpers ──

export function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'dict';
  if (v instanceof Set) return 'set';
  if (v instanceof AdderRange) return 'range';
  if (v instanceof Uint8Array) return 'bytes';
  if (typeof v === 'function') return 'function';
  if (v?.__adderClass__) return v.__adderClass__;
  return 'object';
}

export function pyBool(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '' || v !== v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v instanceof AdderRange) return v.length > 0;
  // check __bool__ dunder
  if (typeof v === 'object' && typeof v.__bool__ === 'function') return !!v.__bool__();
  if (typeof v === 'object' && typeof v.__len__ === 'function') return v.__len__() !== 0;
  return true;
}

export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (v instanceof Map) {
    const items = [...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`);
    return `{${items.join(', ')}}`;
  }
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(', ')}}` || 'set()';
  if (v instanceof AdderRange) {
    if (v.step === 1) return `range(${v.start}, ${v.stop})`;
    return `range(${v.start}, ${v.stop}, ${v.step})`;
  }
  if (typeof v === 'function') return `<function ${v._pyName || v.name || '<lambda>'}>`;
  if (typeof v === 'object' && typeof v.__repr__ === 'function') return v.__repr__();
  if (typeof v === 'object' && typeof v.__str__ === 'function') return v.__str__();
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.__str__ === 'function') return v.__str__();
  return pyRepr(v);
}

// ── iteration helper ──

export function* pyIter(obj) {
  if (obj === null || obj === undefined) throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not iterable`);
  if (Array.isArray(obj) || typeof obj === 'string' || obj instanceof Uint8Array) { for (let i = 0; i < obj.length; i++) yield obj[i]; return; }
  if (obj instanceof Map) { for (const k of obj.keys()) yield k; return; }
  if (obj instanceof Set || obj instanceof AdderRange) { yield* obj; return; }
  if (typeof obj[Symbol.iterator] === 'function') { yield* obj; return; }
  if (typeof obj === 'object' && typeof obj.length === 'number') { for (let i = 0; i < obj.length; i++) yield obj[i]; return; }
  // plain object — iterate keys
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) yield k; return; }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not iterable`);
}

// Collect iterable (sync or async) to array
export async function pyCollect(obj) {
  if (obj && typeof obj[Symbol.asyncIterator] === 'function') {
    const arr = [];
    for await (const v of obj) arr.push(v);
    return arr;
  }
  return [...pyIter(obj)];
}

// ── format spec ──

export function pyFormatValue(value, spec) {
  if (!spec) return pyStr(value);
  // parse spec: [[fill]align][sign][z][#][0][width][grouping_option][.precision][type]
  let fill = ' ', align = '', sign = '', width = 0, precision = -1, ftype = '', grouping = '';
  let i = 0;
  // fill + align
  if (i + 1 < spec.length && '<>^='.includes(spec[i + 1])) { fill = spec[i]; align = spec[i + 1]; i += 2; }
  else if (i < spec.length && '<>^='.includes(spec[i])) { align = spec[i]; i++; }
  // sign
  if (i < spec.length && '+-'.includes(spec[i])) { sign = spec[i]; i++; }
  // zero pad
  if (i < spec.length && spec[i] === '0') { if (!align) { fill = '0'; align = '='; } i++; }
  // width
  while (i < spec.length && spec[i] >= '0' && spec[i] <= '9') { width = width * 10 + (+spec[i]); i++; }
  // grouping
  if (i < spec.length && (spec[i] === ',' || spec[i] === '_')) { grouping = spec[i]; i++; }
  // precision
  if (i < spec.length && spec[i] === '.') { i++; precision = 0; while (i < spec.length && spec[i] >= '0' && spec[i] <= '9') { precision = precision * 10 + (+spec[i]); i++; } }
  // type
  if (i < spec.length) ftype = spec[i];

  let result;
  if (ftype === 'd') {
    result = Math.trunc(Number(value)).toString();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'f' || ftype === 'F') {
    result = Number(value).toFixed(precision >= 0 ? precision : 6);
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'e' || ftype === 'E') {
    result = Number(value).toExponential(precision >= 0 ? precision : 6);
    if (ftype === 'E') result = result.toUpperCase();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'g' || ftype === 'G') {
    const p = precision >= 0 ? precision : 6;
    result = Number(value).toPrecision(p || 1);
    if (result.includes('e')) { /* keep */ } else { result = parseFloat(result).toString(); }
    if (ftype === 'G') result = result.toUpperCase();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === '%') {
    result = (Number(value) * 100).toFixed(precision >= 0 ? precision : 6) + '%';
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'b') {
    result = Math.trunc(Number(value)).toString(2);
  } else if (ftype === 'o') {
    result = Math.trunc(Number(value)).toString(8);
  } else if (ftype === 'x' || ftype === 'X') {
    result = Math.trunc(Math.abs(Number(value))).toString(16);
    if (ftype === 'X') result = result.toUpperCase();
    if (Number(value) < 0) result = '-' + result;
  } else if (ftype === 'c') {
    result = String.fromCodePoint(Number(value));
  } else if (ftype === 's' || ftype === '') {
    result = typeof value === 'string' ? value : pyStr(value);
    if (precision >= 0) result = result.slice(0, precision);
  } else if (ftype === 'n') {
    result = Number(value).toLocaleString();
  } else {
    // auto: number vs string
    if (typeof value === 'number') {
      result = precision >= 0 ? value.toFixed(precision) : String(value);
      if (sign === '+' && !result.startsWith('-')) result = '+' + result;
    } else {
      result = pyStr(value);
      if (precision >= 0) result = result.slice(0, precision);
    }
  }

  // grouping
  if (grouping && (ftype === 'd' || ftype === 'f' || ftype === 'F' || ftype === '' || !ftype)) {
    const neg = result.startsWith('-');
    let num = neg ? result.slice(1) : result;
    const dot = num.indexOf('.');
    const intPart = dot >= 0 ? num.slice(0, dot) : num;
    const rest = dot >= 0 ? num.slice(dot) : '';
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
    result = (neg ? '-' : '') + grouped + rest;
  }

  // alignment
  if (!align) align = typeof value === 'string' ? '<' : '>';
  if (width > result.length) {
    const pad = width - result.length;
    if (align === '<') result = result + fill.repeat(pad);
    else if (align === '>') result = fill.repeat(pad) + result;
    else if (align === '^') { const left = Math.floor(pad / 2); result = fill.repeat(left) + result + fill.repeat(pad - left); }
    else if (align === '=') {
      // pad after sign
      const signIdx = (result[0] === '-' || result[0] === '+') ? 1 : 0;
      result = result.slice(0, signIdx) + fill.repeat(pad) + result.slice(signIdx);
    }
  }
  return result;
}

// ── method dispatch ──

function _isNativeClass(fn) {
  try { return /^class[\s{]/.test(Function.prototype.toString.call(fn)); } catch { return false; }
}

export function adderGetAttr(obj, attr) {
  // string methods
  if (typeof obj === 'string') return _strMethod(obj, attr);
  // list methods
  if (Array.isArray(obj)) return _listMethod(obj, attr);
  // dict (Map) methods
  if (obj instanceof Map) return _mapMethod(obj, attr);
  // set methods
  if (obj instanceof Set) return _setMethod(obj, attr);
  // range
  if (obj instanceof AdderRange) {
    if (attr === 'start') return obj.start;
    if (attr === 'stop') return obj.stop;
    if (attr === 'step') return obj.step;
  }
  // plain object (dict with string keys)
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Array) && !(obj instanceof Map) && !(obj instanceof Set)) {
    // check for adder class method on prototype
    if (typeof obj[attr] === 'function') {
      if (_isNativeClass(obj[attr])) return obj[attr];
      // adder functions expect self as first arg — inject it (skip for modules)
      if (obj[attr]._pyFunc && !obj.__adderModule__) {
        const originalFn = obj[attr];
        const fn = (...args) => originalFn(obj, ...args);
        fn._pyFunc = true;
        fn._pyName = `${attr}`;
        return fn;
      }
      const fn = obj[attr].bind(obj);
      fn._pyName = attr;
      return fn;
    }
    // dict-like attribute access — keys, values, items, get, etc.
    if (_objDictMethods[attr]) return _objDictMethods[attr](obj);
    // regular property access
    if (attr in obj) return obj[attr];
    // __getattr__ dunder
    if (typeof obj.__getattr__ === 'function') return obj.__getattr__(attr);
    throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${attr}'`);
  }
  // generic
  if (obj !== null && obj !== undefined && attr in obj) {
    const val = obj[attr];
    if (typeof val === 'function') {
      if (_isNativeClass(val)) return val;
      if (val._pyFunc) { const fn = (...args) => val(obj, ...args); fn._pyFunc = true; fn._pyName = attr; return fn; }
      return val.bind(obj);
    }
    return val;
  }
  throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${attr}'`);
}

function _strMethod(s, attr) {
  const m = {
    upper: () => s.toUpperCase(),
    lower: () => s.toLowerCase(),
    strip: (chars) => chars ? _stripChars(s, chars) : s.trim(),
    lstrip: (chars) => chars ? _lstripChars(s, chars) : s.trimStart(),
    rstrip: (chars) => chars ? _rstripChars(s, chars) : s.trimEnd(),
    split: (sep, maxsplit) => {
      if (sep === undefined || sep === null) return s.trim().split(/\s+/);
      if (maxsplit !== undefined) { const parts = []; let rest = s; for (let i = 0; i < maxsplit; i++) { const idx = rest.indexOf(sep); if (idx < 0) break; parts.push(rest.slice(0, idx)); rest = rest.slice(idx + sep.length); } parts.push(rest); return parts; }
      return s.split(sep);
    },
    rsplit: (sep, maxsplit) => {
      if (sep === undefined || sep === null) return s.trim().split(/\s+/);
      if (maxsplit !== undefined) { const parts = []; let rest = s; for (let i = 0; i < maxsplit; i++) { const idx = rest.lastIndexOf(sep); if (idx < 0) break; parts.unshift(rest.slice(idx + sep.length)); rest = rest.slice(0, idx); } parts.unshift(rest); return parts; }
      return s.split(sep);
    },
    join: (iterable) => [...pyIter(iterable)].join(s),
    replace: (old, nw, count) => {
      if (count === undefined) return s.split(old).join(nw);
      let result = s, n = 0;
      while (n < count) { const idx = result.indexOf(old); if (idx < 0) break; result = result.slice(0, idx) + nw + result.slice(idx + old.length); n++; }
      return result;
    },
    find: (sub, start, end) => { const sl = s.slice(start || 0, end); const i = sl.indexOf(sub); return i < 0 ? -1 : i + (start || 0); },
    rfind: (sub, start, end) => { const sl = s.slice(start || 0, end); const i = sl.lastIndexOf(sub); return i < 0 ? -1 : i + (start || 0); },
    index: (sub, start, end) => { const i = m.find(sub, start, end); if (i < 0) throw new AdderError('ValueError', 'substring not found'); return i; },
    rindex: (sub, start, end) => { const i = m.rfind(sub, start, end); if (i < 0) throw new AdderError('ValueError', 'substring not found'); return i; },
    count: (sub) => { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length || 1; } return n; },
    startswith: (prefix, start, end) => s.slice(start || 0, end).startsWith(prefix),
    endswith: (suffix, start, end) => s.slice(start || 0, end).endsWith(suffix),
    format: (...args) => _strFormat(s, args),
    encode: (encoding) => new TextEncoder().encode(s),
    capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
    title: () => s.replace(/\b\w/g, c => c.toUpperCase()),
    swapcase: () => [...s].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(''),
    isdigit: () => s.length > 0 && /^\d+$/.test(s),
    isalpha: () => s.length > 0 && /^[a-zA-Z]+$/.test(s),
    isalnum: () => s.length > 0 && /^[a-zA-Z0-9]+$/.test(s),
    isspace: () => s.length > 0 && /^\s+$/.test(s),
    isupper: () => s.length > 0 && s === s.toUpperCase() && s !== s.toLowerCase(),
    islower: () => s.length > 0 && s === s.toLowerCase() && s !== s.toUpperCase(),
    zfill: (width) => { const neg = s.startsWith('-'); const base = neg ? s.slice(1) : s; const padded = base.padStart(width - (neg ? 1 : 0), '0'); return neg ? '-' + padded : padded; },
    ljust: (width, fill) => s.padEnd(width, fill || ' '),
    rjust: (width, fill) => s.padStart(width, fill || ' '),
    center: (width, fill) => { const f = fill || ' '; const total = width - s.length; if (total <= 0) return s; const left = Math.floor(total / 2); return f.repeat(left) + s + f.repeat(total - left); },
    expandtabs: (tabsize) => s.replace(/\t/g, ' '.repeat(tabsize || 8)),
    partition: (sep) => { const i = s.indexOf(sep); return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]; },
    rpartition: (sep) => { const i = s.lastIndexOf(sep); return i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)]; },
    removeprefix: (prefix) => s.startsWith(prefix) ? s.slice(prefix.length) : s,
    removesuffix: (suffix) => s.endsWith(suffix) ? s.slice(0, -suffix.length || s.length) : s,
    splitlines: (keepends) => s.split(/\r?\n|\r/).map((l, i, a) => keepends && i < a.length - 1 ? l + '\n' : l),
    maketrans: () => { throw new AdderError('NotImplementedError', 'str.maketrans is not supported'); },
    translate: () => { throw new AdderError('NotImplementedError', 'str.translate is not supported'); },
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `str.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'str' object has no attribute '${attr}'`);
}

function _stripChars(s, chars) { const cs = new Set(chars); let l = 0, r = s.length; while (l < r && cs.has(s[l])) l++; while (r > l && cs.has(s[r - 1])) r--; return s.slice(l, r); }
function _lstripChars(s, chars) { const cs = new Set(chars); let l = 0; while (l < s.length && cs.has(s[l])) l++; return s.slice(l); }
function _rstripChars(s, chars) { const cs = new Set(chars); let r = s.length; while (r > 0 && cs.has(s[r - 1])) r--; return s.slice(0, r); }

function _strFormat(s, args) {
  let ai = 0;
  return s.replace(/\{([^}]*)\}/g, (_, spec) => {
    let key, fmt;
    const ci = spec.indexOf(':');
    if (ci >= 0) { key = spec.slice(0, ci); fmt = spec.slice(ci + 1); }
    else { key = spec; fmt = ''; }
    let val;
    if (key === '' || key === undefined) val = args[ai++];
    else if (/^\d+$/.test(key)) val = args[parseInt(key)];
    else val = args[0]?.[key];
    return fmt ? pyFormatValue(val, fmt) : pyStr(val);
  });
}

function _listMethod(arr, attr) {
  const m = {
    append: (v) => { arr.push(v); return null; },
    extend: (iterable) => { for (const v of pyIter(iterable)) arr.push(v); return null; },
    insert: (i, v) => { arr.splice(i < 0 ? Math.max(0, arr.length + i) : i, 0, v); return null; },
    remove: (v) => { const i = arr.indexOf(v); if (i < 0) throw new AdderError('ValueError', 'list.remove(x): x not in list'); arr.splice(i, 1); return null; },
    pop: (i) => { if (arr.length === 0) throw new AdderError('IndexError', 'pop from empty list'); return i === undefined ? arr.pop() : arr.splice(i < 0 ? arr.length + i : i, 1)[0]; },
    clear: () => { arr.length = 0; return null; },
    index: (v, start, end) => { const i = arr.indexOf(v, start || 0); if (i < 0 || (end !== undefined && i >= end)) throw new AdderError('ValueError', `${pyRepr(v)} is not in list`); return i; },
    count: (v) => arr.filter(x => x === v).length,
    sort: (key, reverse) => { if (key) { const keyed = arr.map((v, i) => [key(v), i, v]); keyed.sort((a, b) => _pyCompare(a[0], b[0])); const sorted = keyed.map(x => x[2]); arr.length = 0; arr.push(...(reverse ? sorted.reverse() : sorted)); } else { arr.sort((a, b) => _pyCompare(a, b)); if (reverse) arr.reverse(); } return null; },
    reverse: () => { arr.reverse(); return null; },
    copy: () => [...arr],
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `list.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'list' object has no attribute '${attr}'`);
}

function _mapMethod(map, attr) {
  const m = {
    keys: () => [...map.keys()],
    values: () => [...map.values()],
    items: () => [...map.entries()],
    get: (k, def) => map.has(k) ? map.get(k) : (def !== undefined ? def : null),
    pop: (k, def) => { if (map.has(k)) { const v = map.get(k); map.delete(k); return v; } if (def !== undefined) return def; throw new AdderError('KeyError', pyRepr(k)); },
    setdefault: (k, def) => { if (map.has(k)) return map.get(k); const v = def !== undefined ? def : null; map.set(k, v); return v; },
    update: (other) => { if (other instanceof Map) { for (const [k, v] of other) map.set(k, v); } else if (typeof other === 'object') { for (const k of Object.keys(other)) map.set(k, other[k]); } return null; },
    clear: () => { map.clear(); return null; },
    copy: () => new Map(map),
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `dict.${attr}`; return fn; }
  if (attr === 'size') return map.size;
  throw new AdderError('AttributeError', `'dict' object has no attribute '${attr}'`);
}

const _objDictMethods = {
  keys: (obj) => { const fn = () => Object.keys(obj); fn._pyName = 'dict.keys'; return fn; },
  values: (obj) => { const fn = () => Object.values(obj); fn._pyName = 'dict.values'; return fn; },
  items: (obj) => { const fn = () => Object.entries(obj); fn._pyName = 'dict.items'; return fn; },
  get: (obj) => { const fn = (k, def) => k in obj ? obj[k] : (def !== undefined ? def : null); fn._pyName = 'dict.get'; return fn; },
  pop: (obj) => { const fn = (k, def) => { if (k in obj) { const v = obj[k]; delete obj[k]; return v; } if (def !== undefined) return def; throw new AdderError('KeyError', pyRepr(k)); }; fn._pyName = 'dict.pop'; return fn; },
  setdefault: (obj) => { const fn = (k, def) => { if (k in obj) return obj[k]; obj[k] = def !== undefined ? def : null; return obj[k]; }; fn._pyName = 'dict.setdefault'; return fn; },
  update: (obj) => { const fn = (other) => { if (other instanceof Map) { for (const [k, v] of other) obj[k] = v; } else if (typeof other === 'object') Object.assign(obj, other); return null; }; fn._pyName = 'dict.update'; return fn; },
  clear: (obj) => { const fn = () => { for (const k of Object.keys(obj)) delete obj[k]; return null; }; fn._pyName = 'dict.clear'; return fn; },
  copy: (obj) => { const fn = () => ({ ...obj }); fn._pyName = 'dict.copy'; return fn; },
};

function _setMethod(set, attr) {
  const m = {
    add: (v) => { set.add(v); return null; },
    remove: (v) => { if (!set.has(v)) throw new AdderError('KeyError', pyRepr(v)); set.delete(v); return null; },
    discard: (v) => { set.delete(v); return null; },
    pop: () => { if (set.size === 0) throw new AdderError('KeyError', 'pop from an empty set'); const v = set.values().next().value; set.delete(v); return v; },
    clear: () => { set.clear(); return null; },
    union: (...others) => { const r = new Set(set); for (const o of others) for (const v of pyIter(o)) r.add(v); return r; },
    intersection: (...others) => { const r = new Set(); for (const v of set) { if (others.every(o => { const s = o instanceof Set ? o : new Set(pyIter(o)); return s.has(v); })) r.add(v); } return r; },
    difference: (...others) => { const r = new Set(set); for (const o of others) for (const v of pyIter(o)) r.delete(v); return r; },
    symmetric_difference: (other) => { const r = new Set(set); for (const v of pyIter(other)) { if (r.has(v)) r.delete(v); else r.add(v); } return r; },
    update: (...others) => { for (const o of others) for (const v of pyIter(o)) set.add(v); return null; },
    issubset: (other) => { const o = other instanceof Set ? other : new Set(pyIter(other)); for (const v of set) if (!o.has(v)) return false; return true; },
    issuperset: (other) => { for (const v of pyIter(other)) if (!set.has(v)) return false; return true; },
    copy: () => new Set(set),
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `set.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'set' object has no attribute '${attr}'`);
}

function _pyCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ── modules ──

const _mathModule = {
  pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity, nan: NaN,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
  pow: Math.pow, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
  fabs: Math.abs, copysign: (x, y) => Math.sign(y) * Math.abs(x),
  isnan: Number.isNaN, isinf: (x) => !isFinite(x) && !isNaN(x), isfinite: Number.isFinite,
  radians: (d) => d * Math.PI / 180, degrees: (r) => r * 180 / Math.PI,
  factorial: (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  gcd: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; },
  comb: (n, k) => { if (k < 0 || k > n) return 0; if (k === 0 || k === n) return 1; let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); },
  perm: (n, k) => { if (k === undefined) k = n; let r = 1; for (let i = 0; i < k; i++) r *= (n - i); return r; },
  hypot: Math.hypot,
  fsum: (iterable) => { let s = 0; for (const v of pyIter(iterable)) s += v; return s; },
  prod: (iterable, start) => { let r = start !== undefined ? start : 1; for (const v of pyIter(iterable)) r *= v; return r; },
  fmod: (x, y) => x % y,
  remainder: (x, y) => x - Math.round(x / y) * y,
  ldexp: (x, i) => x * Math.pow(2, i),
  frexp: (x) => { if (x === 0) return [0, 0]; const e = Math.ceil(Math.log2(Math.abs(x))); return [x / Math.pow(2, e), e]; },
  modf: (x) => { const i = Math.trunc(x); return [x - i, i]; },
};

const _jsonModule = {
  dumps: (obj, indent) => {
    const replacer = (k, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    };
    return JSON.stringify(obj, replacer, indent);
  },
  loads: (s) => JSON.parse(s),
};

const _jsModule = new Proxy({}, {
  get(_, prop) { return typeof globalThis !== 'undefined' ? globalThis[prop] : undefined; },
  has(_, prop) { return typeof globalThis !== 'undefined' && prop in globalThis; },
});

const _randomState = { s: [1, 2, 3, 4] };
function _xoshiro128() {
  const s = _randomState.s;
  const result = (s[0] + s[3]) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
  s[2] ^= t; s[3] = (s[3] << 11) | (s[3] >>> 21);
  return result / 4294967296;
}

const _randomModule = {
  random: () => _xoshiro128(),
  seed: (n) => { n = n >>> 0; _randomState.s = [n, n ^ 0x12345678, n ^ 0x9ABCDEF0, n ^ 0xFEDCBA98]; },
  randint: (a, b) => a + Math.floor(_xoshiro128() * (b - a + 1)),
  uniform: (a, b) => a + _xoshiro128() * (b - a),
  choice: (seq) => { const arr = Array.isArray(seq) ? seq : [...pyIter(seq)]; return arr[Math.floor(_xoshiro128() * arr.length)]; },
  shuffle: (lst) => { for (let i = lst.length - 1; i > 0; i--) { const j = Math.floor(_xoshiro128() * (i + 1)); [lst[i], lst[j]] = [lst[j], lst[i]]; } return null; },
  gauss: (mu, sigma) => {
    let u, v, s;
    do { u = 2 * _xoshiro128() - 1; v = 2 * _xoshiro128() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    return mu + sigma * u * Math.sqrt(-2 * Math.log(s) / s);
  },
  sample: (population, k) => {
    const arr = Array.isArray(population) ? [...population] : [...pyIter(population)];
    const result = [];
    for (let i = 0; i < k; i++) { const j = Math.floor(_xoshiro128() * arr.length); result.push(arr.splice(j, 1)[0]); }
    return result;
  },
};

// ── itertools ──

const _itertoolsModule = {
  chain: (...iterables) => {
    const result = [];
    for (const it of iterables) for (const v of pyIter(it)) result.push(v);
    return result;
  },
  product: (...iterables) => {
    const arrs = iterables.map(it => [...pyIter(it)]);
    if (arrs.length === 0) return [[]];
    const result = [];
    const indices = arrs.map(() => 0);
    while (true) {
      result.push(indices.map((idx, i) => arrs[i][idx]));
      let i = arrs.length - 1;
      while (i >= 0) { indices[i]++; if (indices[i] < arrs[i].length) break; indices[i] = 0; i--; }
      if (i < 0) break;
    }
    return result;
  },
  combinations: (iterable, r) => {
    const pool = [...pyIter(iterable)];
    const n = pool.length;
    if (r > n) return [];
    const result = [];
    const indices = Array.from({ length: r }, (_, i) => i);
    result.push(indices.map(i => pool[i]));
    while (true) {
      let i = r - 1;
      while (i >= 0 && indices[i] === i + n - r) i--;
      if (i < 0) break;
      indices[i]++;
      for (let j = i + 1; j < r; j++) indices[j] = indices[j - 1] + 1;
      result.push(indices.map(i => pool[i]));
    }
    return result;
  },
  permutations: (iterable, r) => {
    const pool = [...pyIter(iterable)];
    const n = pool.length;
    r = r !== undefined ? r : n;
    if (r > n) return [];
    const result = [];
    const indices = Array.from({ length: n }, (_, i) => i);
    const cycles = Array.from({ length: r }, (_, i) => n - i);
    result.push(indices.slice(0, r).map(i => pool[i]));
    while (true) {
      let found = false;
      for (let i = r - 1; i >= 0; i--) {
        cycles[i]--;
        if (cycles[i] === 0) {
          indices.push(indices.splice(i, 1)[0]);
          cycles[i] = n - i;
        } else {
          const j = indices.length - cycles[i];
          [indices[i], indices[j]] = [indices[j], indices[i]];
          result.push(indices.slice(0, r).map(i => pool[i]));
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return result;
  },
  repeat: (value, times) => {
    if (times === undefined) { const a = []; for (let i = 0; i < 1000; i++) a.push(value); return a; } // capped
    const result = []; for (let i = 0; i < times; i++) result.push(value); return result;
  },
  accumulate: (iterable, func) => {
    const arr = [...pyIter(iterable)];
    if (arr.length === 0) return [];
    const result = [arr[0]];
    for (let i = 1; i < arr.length; i++) result.push(func ? func(result[i - 1], arr[i]) : result[i - 1] + arr[i]);
    return result;
  },
  starmap: (func, iterable) => [...pyIter(iterable)].map(args => func(...args)),
  islice: (iterable, ...args) => {
    let start = 0, stop, step = 1;
    if (args.length === 1) { stop = args[0]; }
    else if (args.length === 2) { start = args[0]; stop = args[1]; }
    else { start = args[0]; stop = args[1]; step = args[2] || 1; }
    const result = [];
    let i = 0;
    for (const v of pyIter(iterable)) {
      if (i >= stop) break;
      if (i >= start && (i - start) % step === 0) result.push(v);
      i++;
    }
    return result;
  },
  zip_longest: (...args) => {
    let fillvalue = null;
    if (args.length > 0 && args[args.length - 1]?._kw) { fillvalue = args.pop().fillvalue ?? null; }
    const arrs = args.map(it => [...pyIter(it)]);
    const maxLen = Math.max(...arrs.map(a => a.length));
    const result = [];
    for (let i = 0; i < maxLen; i++) result.push(arrs.map(a => i < a.length ? a[i] : fillvalue));
    return result;
  },
  groupby: (iterable, key) => {
    const arr = [...pyIter(iterable)];
    const result = [];
    let currentKey = undefined, currentGroup = [];
    for (const item of arr) {
      const k = key ? key(item) : item;
      if (result.length === 0 || k !== currentKey) {
        if (currentGroup.length > 0) result.push([currentKey, currentGroup]);
        currentKey = k; currentGroup = [item];
      } else { currentGroup.push(item); }
    }
    if (currentGroup.length > 0) result.push([currentKey, currentGroup]);
    return result;
  },
};

// ── functools ──

const _functoolsModule = {
  reduce: (func, iterable, initial) => {
    const arr = [...pyIter(iterable)];
    if (initial !== undefined) return arr.reduce((a, b) => func(a, b), initial);
    if (arr.length === 0) throw new AdderError('TypeError', 'reduce() of empty iterable with no initial value');
    return arr.reduce((a, b) => func(a, b));
  },
  partial: (func, ...partialArgs) => {
    const wrapped = (...args) => func(...partialArgs, ...args);
    wrapped._pyName = `partial(${func._pyName || func.name || '?'})`;
    return wrapped;
  },
  lru_cache: (fn) => {
    const cache = new Map();
    const wrapped = (...args) => {
      const key = JSON.stringify(args);
      if (cache.has(key)) return cache.get(key);
      const result = fn(...args);
      cache.set(key, result);
      return result;
    };
    wrapped.cache_clear = () => cache.clear();
    wrapped._pyName = fn._pyName || fn.name;
    return wrapped;
  },
};

// ── collections ──

const _collectionsModule = {
  OrderedDict: (items) => {
    // JS Map preserves insertion order
    if (!items) return new Map();
    return new Map(Array.isArray(items) ? items : Object.entries(items));
  },
  defaultdict: (factory, items) => {
    const map = new Map();
    if (items) { for (const [k, v] of (Array.isArray(items) ? items : Object.entries(items))) map.set(k, v); }
    return new Proxy(map, {
      get(target, prop) {
        if (prop === 'get' || prop === 'has' || prop === 'set' || prop === 'delete' || prop === 'size' || prop === 'keys' || prop === 'values' || prop === 'items' || prop === 'clear' || prop === 'entries' || typeof prop === 'symbol') return Reflect.get(target, prop);
        if (!target.has(prop)) target.set(prop, factory());
        return target.get(prop);
      },
    });
  },
  Counter: (iterable) => {
    const counts = {};
    if (iterable) { for (const v of pyIter(iterable)) counts[v] = (counts[v] || 0) + 1; }
    counts.most_common = (n) => {
      const entries = Object.entries(counts).filter(([k]) => k !== 'most_common' && k !== 'elements' && k !== 'update');
      entries.sort((a, b) => b[1] - a[1]);
      return n !== undefined ? entries.slice(0, n) : entries;
    };
    counts.update = (iterable) => { for (const v of pyIter(iterable)) counts[v] = (counts[v] || 0) + 1; };
    return counts;
  },
  namedtuple: (name, fields) => {
    const fieldNames = typeof fields === 'string' ? fields.split(/[\s,]+/).filter(Boolean) : [...fields];
    return (...args) => {
      const obj = {};
      for (let i = 0; i < fieldNames.length; i++) obj[fieldNames[i]] = args[i];
      obj.__adderClass__ = name;
      obj.__repr__ = () => `${name}(${fieldNames.map(f => `${f}=${pyRepr(obj[f])}`).join(', ')})`;
      return obj;
    };
  },
};

// ── re (regex) ──

const _reModule = {
  match: (pattern, string) => { const m = string.match(new RegExp(pattern)); return m ? _reMatch(m) : null; },
  search: (pattern, string) => { const m = string.match(new RegExp(pattern)); return m ? _reMatch(m) : null; },
  findall: (pattern, string) => { const re = new RegExp(pattern, 'g'); const r = []; let m; while ((m = re.exec(string))) r.push(m[1] !== undefined ? m[1] : m[0]); return r; },
  sub: (pattern, repl, string, count) => {
    if (count !== undefined && count > 0) {
      let n = 0;
      return string.replace(new RegExp(pattern, 'g'), (m) => n++ < count ? (typeof repl === 'function' ? repl(_reMatch([m])) : repl) : m);
    }
    return string.replace(new RegExp(pattern, 'g'), typeof repl === 'function' ? (m) => repl(_reMatch([m])) : repl);
  },
  split: (pattern, string, maxsplit) => {
    if (maxsplit !== undefined) {
      const parts = []; let rest = string;
      for (let i = 0; i < maxsplit; i++) {
        const m = rest.match(new RegExp(pattern));
        if (!m) break;
        parts.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      parts.push(rest);
      return parts;
    }
    return string.split(new RegExp(pattern));
  },
  compile: (pattern) => {
    const re = new RegExp(pattern, 'g');
    return {
      match: (s) => { re.lastIndex = 0; const m = re.exec(s); return m && m.index === 0 ? _reMatch(m) : null; },
      search: (s) => { re.lastIndex = 0; const m = re.exec(s); return m ? _reMatch(m) : null; },
      findall: (s) => { re.lastIndex = 0; const r = []; let m; while ((m = re.exec(s))) r.push(m[1] !== undefined ? m[1] : m[0]); return r; },
      sub: (repl, s) => s.replace(new RegExp(pattern, 'g'), repl),
      split: (s) => s.split(new RegExp(pattern)),
    };
  },
  escape: (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  IGNORECASE: 'i', I: 'i',
  MULTILINE: 'm', M: 'm',
  DOTALL: 's', S: 's',
};

function _reMatch(m) {
  return {
    group: (n) => n === undefined ? m[0] : m[n],
    groups: () => m.slice(1),
    start: () => m.index,
    end: () => m.index + m[0].length,
    span: () => [m.index, m.index + m[0].length],
    string: m.input,
    0: m[0],
  };
}

// ── string module ──

const _stringModule = {
  ascii_lowercase: 'abcdefghijklmnopqrstuvwxyz',
  ascii_uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ascii_letters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  hexdigits: '0123456789abcdefABCDEF',
  octdigits: '01234567',
  punctuation: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  whitespace: ' \t\n\r\x0b\x0c',
};

// ── this ──

const _thisModule = {
  s: `The Zen of Python, by Tim Peters

Beautiful is better than ugly.
Explicit is better than implicit.
Simple is better than complex.
Complex is better than complicated.
Flat is better than nested.
Sparse is better than dense.
Readability counts.
Special cases aren't special enough to break the rules.
Although practicality beats purity.
Errors should never pass silently.
Unless explicitly silenced.
In the face of ambiguity, refuse the temptation to guess.
There should be one-- and preferably only one --obvious way to do it.
Although that way may not be obvious at first unless you're Dutch.
Now is better than never.
Although never is often better than *right* now.
If the implementation is hard to explain, it's a bad idea.
If the implementation is easy to explain, it may be a good idea.
Namespaces are one honking great idea -- let's do more of those!`,
};
_thisModule.print = () => _thisModule.s;
_thisModule.gcu = `We set sail on this new stack because there is new knowledge to be gained, and new tools to be built, and they must be built and shared for the progress of all practitioners. For computational science, like geostatistics and all technology, has no conscience of its own. Whether it will become a force for good or ill depends on us, and only if we occupy a position of independence can we help decide whether this new ocean will be a sea of openness or a new terrifying theater of languages that forgot what they were for.

I do not say that we should or will go without the tools that others have built, any more than we go without the knowledge that others have shared, but I do say that geostatistics can be explored and mastered without feeding the fires of flamewar, without repeating the mistakes that man has made in extending his writ around this globe of ours.

There is no strife, no prejudice, no conflict of interest in a file that contains its own source. Its hazards are hostile to us all. Its conquest deserves the best of all practitioners, and its opportunity for open cooperation may never come again.

But why, some say, JavaScript? Why choose this as our language? And they may well ask, why climb the highest mountain? Why, thirty-four years after Deutsch and Journel, rewrite the FORTRAN? Why does Rice play Texas?

We choose to write JavaScript. We choose to write JavaScript... We choose to write JavaScript in this decade and do the other things, not because it is good, but because it is bad; because that goal will serve to organize and measure the best of our energies and skills, because that challenge is one that we are willing to accept, one we are unwilling to postpone, and one we intend to ship, and the others, too.`;

// ── shared cwd + path resolution ──

const _cwd = { value: '/home/nb' };
const _HOME = '/home/nb';

// Expand ~ and resolve relative paths against cwd. Used by open(), Path(), os._resolve().
export function _resolvePath(p, pth) {
  if (!p || p === '.') return _cwd.value;
  // ~ expansion
  if (p === '~') return _HOME;
  if (p.startsWith('~/')) p = _HOME + p.slice(1);
  if (pth && !pth.isAbsolute(p)) return pth.join(_cwd.value, p);
  if (pth) return pth.normalize(p);
  // fallback without path utils: just basic join
  if (p.startsWith('/')) return p;
  return _cwd.value + ((_cwd.value === '/') ? '' : '/') + p;
}

// ── sys module ──

const _sysModule = {
  version: '3.12.0 (adder)',
  version_info: [3, 12, 0, 'adder', 0],
  platform: 'auditable',
  maxsize: Number.MAX_SAFE_INTEGER,
  path: ['.', 'lib', '/usr/lib/python'],
  modules: {},
  argv: [''],
  exit: (code) => { throw new AdderError('SystemExit', String(code ?? 0)); },
  stdout: { write(s) { return String(s).length; }, flush() {}, encoding: 'utf-8' },
  stderr: { write(s) { return String(s).length; }, flush() {}, encoding: 'utf-8' },
  getsizeof: () => 0,
  getrecursionlimit: () => 1000,
  setrecursionlimit: () => null,
  executable: '',
  prefix: '/usr',
  exec_prefix: '/usr',
  get home() { return _HOME; },
};

export const adderModules = {
  math: _mathModule, json: _jsonModule, js: _jsModule, random: _randomModule,
  itertools: _itertoolsModule, functools: _functoolsModule,
  collections: _collectionsModule, re: _reModule, string: _stringModule,
  this: _thisModule, sys: _sysModule,
};

// ── filesystem exception hierarchy ──

export const _excParents = {
  FileNotFoundError: 'OSError', FileExistsError: 'OSError',
  IsADirectoryError: 'OSError', NotADirectoryError: 'OSError',
  PermissionError: 'OSError', IOError: 'OSError',
};

function _mapVFSError(e) {
  const map = { ENOENT: 'FileNotFoundError', EEXIST: 'FileExistsError',
    EISDIR: 'IsADirectoryError', ENOTDIR: 'NotADirectoryError', EACCES: 'PermissionError' };
  return new AdderError(map[e?.code] || 'OSError', e?.message || String(e));
}

// ── file object ──

async function _createAdderFile(vfs, filePath, mode) {
  const isBinary = mode.includes('b');
  const isRead = mode[0] === 'r';
  const isAppend = mode[0] === 'a';

  let _content = null, _buffer = isBinary ? [] : '', _pos = 0, _closed = false;

  if (isRead || isAppend) {
    try {
      _content = await vfs.readFile(filePath, isBinary ? 'bytes' : undefined);
      if (isAppend) _buffer = isBinary ? [_content] : _content;
    } catch (e) {
      if (isRead) throw _mapVFSError(e);
      _content = isBinary ? new Uint8Array(0) : '';
    }
  }

  const f = {
    _path: filePath, _mode: mode,
    __adderClass__: isBinary ? 'BufferedIOBase' : 'TextIOWrapper',

    read(size) {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      if (size != null) { const chunk = _content.slice(_pos, _pos + size); _pos += size; return chunk; }
      const rest = _content.slice(_pos);
      _pos = typeof _content === 'string' ? _content.length : _content.byteLength;
      return rest;
    },

    readline() {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      if (typeof _content !== 'string') throw new AdderError('IOError', 'readline on binary file');
      const nl = _content.indexOf('\n', _pos);
      if (nl === -1) { const line = _content.slice(_pos); _pos = _content.length; return line; }
      const line = _content.slice(_pos, nl + 1);
      _pos = nl + 1;
      return line;
    },

    readlines() {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      const lines = [];
      const len = typeof _content === 'string' ? _content.length : _content.byteLength;
      while (_pos < len) lines.push(f.readline());
      return lines;
    },

    write(data) {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (isRead) throw new AdderError('IOError', 'not writable');
      if (isBinary) {
        const chunk = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
        _buffer.push(chunk);
        return chunk.byteLength;
      }
      const s = String(data);
      _buffer += s;
      return s.length;
    },

    writelines(lines) { for (const line of pyIter(lines)) f.write(line); return null; },

    async close() {
      if (_closed) return;
      _closed = true;
      if (!isRead) {
        try {
          if (isBinary) {
            const total = _buffer.reduce((s, b) => s + b.byteLength, 0);
            const result = new Uint8Array(total);
            let off = 0;
            for (const b of _buffer) { result.set(b, off); off += b.byteLength; }
            await vfs.writeFile(filePath, result);
          } else {
            await vfs.writeFile(filePath, _buffer);
          }
        } catch (e) { throw _mapVFSError(e); }
      }
    },

    __enter__() { return f; },
    async __exit__() { await f.close(); return false; },
    __repr__() { return `<_io.${isBinary ? 'BufferedWriter' : 'TextIOWrapper'} name='${filePath}' mode='${mode}'>`; },
    __str__() { return f.__repr__(); },
    __bool__() { return true; },

    [Symbol.iterator]() {
      if (!isRead) throw new AdderError('IOError', 'not readable');
      let iterPos = _pos;
      const content = _content;
      return {
        next() {
          const len = typeof content === 'string' ? content.length : content.byteLength;
          if (iterPos >= len) return { done: true };
          if (typeof content !== 'string') {
            const rest = content.slice(iterPos);
            iterPos = content.byteLength;
            return { value: rest, done: false };
          }
          const nl = content.indexOf('\n', iterPos);
          if (nl === -1) {
            const line = content.slice(iterPos);
            iterPos = content.length;
            return line ? { value: line, done: false } : { done: true };
          }
          const line = content.slice(iterPos, nl + 1);
          iterPos = nl + 1;
          return { value: line, done: false };
        }
      };
    },

    get name() { return filePath; },
    get closed() { return _closed; },
  };

  return f;
}

// ── os module ──

function _createOsModule(getVfs, pth) {
  const _resolve = (p) => _resolvePath(p, pth);

  const osPath = {
    join: (...parts) => pth.join(...parts),
    dirname: (p) => pth.dirname(p),
    basename: (p) => pth.basename(p),
    splitext: (p) => { const ext = pth.extname(p); return ext ? [p.slice(0, -ext.length), ext] : [p, '']; },
    normpath: (p) => pth.normalize(p),
    relpath: (p, start) => pth.relative(start || _cwd.value, p),
    isabs: (p) => pth.isAbsolute(p),
    exists: async (p) => { try { await getVfs().stat(_resolve(p)); return true; } catch { return false; } },
    isfile: async (p) => { try { return (await getVfs().stat(_resolve(p))).type === 'file'; } catch { return false; } },
    isdir: async (p) => { try { return (await getVfs().stat(_resolve(p))).type === 'directory'; } catch { return false; } },
    getsize: async (p) => { try { return (await getVfs().stat(_resolve(p))).size; } catch (e) { throw _mapVFSError(e); } },
    sep: '/',
  };

  const os = {
    sep: '/', linesep: '\n', name: 'posix',
    path: osPath,

    listdir: async (p) => {
      try { return await getVfs().readdir(_resolve(p || '.')); }
      catch (e) { throw _mapVFSError(e); }
    },
    mkdir: async (p) => {
      try { await getVfs().mkdir(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    makedirs: async (p, exist_ok) => {
      if (exist_ok != null && typeof exist_ok === 'object' && exist_ok._kw) exist_ok = exist_ok.exist_ok;
      const resolved = _resolve(p);
      const vfs = getVfs();
      let exists = false;
      try { await vfs.stat(resolved); exists = true; } catch {}
      if (exists && !exist_ok) throw new AdderError('FileExistsError', resolved);
      if (!exists) {
        try { await vfs.mkdir(resolved, { recursive: true }); }
        catch (e) { throw _mapVFSError(e); }
      }
    },
    remove: async (p) => {
      try { await getVfs().unlink(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    unlink: async (p) => {
      try { await getVfs().unlink(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    rmdir: async (p) => {
      try { await getVfs().rmdir(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    rename: async (src, dst) => {
      try { await getVfs().rename(_resolve(src), _resolve(dst)); }
      catch (e) { throw _mapVFSError(e); }
    },
    stat: async (p) => {
      try {
        const info = await getVfs().stat(_resolve(p));
        return { st_size: info.size, st_mtime: info.modified?.getTime() / 1000 || 0,
                 st_mode: info.mode || 0, st_type: info.type };
      } catch (e) { throw _mapVFSError(e); }
    },
    getcwd: () => _cwd.value,
    chdir: (p) => { _cwd.value = _resolve(p); },

    walk: (top) => {
      const resolved = _resolve(top || '.');
      const vfs = getVfs();
      async function* gen(dir) {
        let entries;
        try { entries = await vfs.readdir(dir); } catch { return; }
        const dirs = [], files = [];
        for (const name of entries) {
          const full = dir === '/' ? '/' + name : dir + '/' + name;
          try {
            const info = await vfs.stat(full);
            if (info.type === 'directory') dirs.push(name);
            else files.push(name);
          } catch { files.push(name); }
        }
        yield [dir, dirs, files];
        for (const d of dirs) {
          yield* gen(dir === '/' ? '/' + d : dir + '/' + d);
        }
      }
      return { [Symbol.asyncIterator]() { return gen(resolved); } };
    },
  };

  return os;
}

// ── pathlib module ──

function _createPathClass(getVfs, pth) {
  function _Path(p) {
    if (typeof p === 'object' && p?._path) return p;
    let raw = String(p || '.');
    // expand ~ but don't resolve relative paths (pathlib keeps them relative)
    if (raw === '~') raw = _HOME;
    else if (raw.startsWith('~/')) raw = _HOME + raw.slice(1);
    const _p = pth.normalize(raw);
    // resolve for I/O — relative paths against cwd
    const _abs = () => pth.isAbsolute(_p) ? _p : pth.join(_cwd.value, _p);
    return {
      _path: _p,
      __adderClass__: 'PosixPath',
      get name() { return pth.basename(_p); },
      get stem() { const b = pth.basename(_p); const ext = pth.extname(_p); return ext ? b.slice(0, -ext.length) : b; },
      get suffix() { return pth.extname(_p); },
      get parent() { return _Path(pth.dirname(_p)); },
      get parts() { return _p === '/' ? ['/'] : ['/', ..._p.split('/').filter(Boolean)]; },

      __truediv__(other) { return _Path(pth.join(_p, String(other?._path || other))); },
      __str__() { return _p; },
      __repr__() { return `PosixPath('${_p}')`; },
      __eq__(other) { return _p === (other?._path || String(other)); },
      __hash__() { let h = 0; for (let i = 0; i < _p.length; i++) h = (h * 31 + _p.charCodeAt(i)) | 0; return h; },

      joinpath(...parts) { return _Path(pth.join(_p, ...parts.map(x => x?._path || String(x)))); },
      with_suffix(s) { const ext = pth.extname(_p); const base = ext ? _p.slice(0, -ext.length) : _p; return _Path(base + s); },
      with_name(n) { return _Path(pth.join(pth.dirname(_p), n)); },

      async read_text() { try { return await getVfs().readFile(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async read_bytes() { try { return await getVfs().readFile(_abs(), 'bytes'); } catch (e) { throw _mapVFSError(e); } },
      async write_text(data) { try { await getVfs().writeFile(_abs(), String(data)); } catch (e) { throw _mapVFSError(e); } },
      async write_bytes(data) { try { await getVfs().writeFile(_abs(), data); } catch (e) { throw _mapVFSError(e); } },
      async exists() { return getVfs().exists(_abs()); },
      async is_file() { try { return (await getVfs().stat(_abs())).type === 'file'; } catch { return false; } },
      async is_dir() { try { return (await getVfs().stat(_abs())).type === 'directory'; } catch { return false; } },
      async mkdir(parents, exist_ok) {
        if (parents != null && typeof parents === 'object' && parents._kw) { exist_ok = parents.exist_ok; parents = parents.parents; }
        try { await getVfs().mkdir(_abs(), { recursive: !!parents }); }
        catch (e) { if (exist_ok && e?.code === 'EEXIST') return; throw _mapVFSError(e); }
      },
      async unlink() { try { await getVfs().unlink(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async rename(target) { const t = target?._path || String(target); const ta = pth.isAbsolute(t) ? t : pth.join(_cwd.value, t); try { await getVfs().rename(_abs(), ta); return _Path(t); } catch (e) { throw _mapVFSError(e); } },
      async iterdir() {
        try {
          const entries = await getVfs().readdir(_abs());
          return entries.map(name => _Path(pth.join(_p, name)));
        } catch (e) { throw _mapVFSError(e); }
      },
      async glob(pattern) {
        try { return await getVfs().glob(pth.join(_abs(), pattern)); }
        catch (e) { throw _mapVFSError(e); }
      },
      async touch() { try { await getVfs().touch(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async stat() {
        try {
          const info = await getVfs().stat(_abs());
          return { st_size: info.size, st_mtime: info.modified?.getTime() / 1000 || 0, st_mode: info.mode || 0, st_type: info.type };
        } catch (e) { throw _mapVFSError(e); }
      },
    };
  }
  return _Path;
}

// ── shutil module ──

function _createShutilModule(getVfs) {
  return {
    copy: async (src, dst) => { try { await getVfs().cp(src, dst); } catch (e) { throw _mapVFSError(e); } },
    copy2: async (src, dst) => { try { await getVfs().cp(src, dst); } catch (e) { throw _mapVFSError(e); } },
    copytree: async (src, dst) => { try { await getVfs().cp(src, dst, { recursive: true }); } catch (e) { throw _mapVFSError(e); } },
    rmtree: async (p) => { try { await getVfs().rm(p, { recursive: true }); } catch (e) { throw _mapVFSError(e); } },
    move: async (src, dst) => { try { await getVfs().rename(src, dst); } catch (e) { throw _mapVFSError(e); } },
  };
}

// ── glob module ──

function _createGlobModule(getVfs) {
  return {
    glob: async (pattern) => { try { return await getVfs().glob(pattern); } catch (e) { throw _mapVFSError(e); } },
  };
}

// ── fs module registration ──

let _adderVFS = null;
let _vfsPath = null;

export function getAdderVFS() { return _adderVFS; }
export function _getVfsPath() { return _vfsPath; }

export function setAdderVFS(vfsInstance, pathUtils) {
  _adderVFS = vfsInstance;
  if (pathUtils) _vfsPath = pathUtils;
  // reset cwd and module cache for the new VFS
  _cwd.value = _HOME;
  for (const k of Object.keys(_sysModule.modules)) delete _sysModule.modules[k];
  // re-register modules if path available (allows calling setAdderVFS after initial load)
  if (_vfsPath) {
    delete adderModules.os;
    _ensureFsModules();
  }
}

export function _ensureFsModules(pathUtils) {
  if (adderModules.os) return;
  if (pathUtils) _vfsPath = pathUtils;
  if (!_vfsPath) {
    try { if (typeof path !== 'undefined' && path.join) _vfsPath = path; } catch {}
  }
  if (!_vfsPath) return;

  const pth = _vfsPath;
  const getVfs = () => {
    if (!_adderVFS) throw new AdderError('RuntimeError', 'filesystem not available — call adder.setVFS(vfsInstance, pathUtils) first');
    return _adderVFS;
  };

  adderModules.os = _createOsModule(getVfs, pth);
  adderModules['os.path'] = adderModules.os.path;
  adderModules.pathlib = { Path: _createPathClass(getVfs, pth) };
  adderModules.shutil = _createShutilModule(getVfs);
  adderModules.glob = _createGlobModule(getVfs);
}

// ── builtins ──

export function adderBuiltins(printFn) {
  const builtins = {
    print: (...args) => {
      let sep = ' ', end = '\n';
      // handle keyword args passed as last object with _kw marker
      if (args.length > 0 && args[args.length - 1]?._kw) {
        const kw = args.pop();
        if (kw.sep !== undefined) sep = kw.sep;
        if (kw.end !== undefined) end = kw.end;
      }
      printFn(args.map(pyStr).join(sep) + end);
      return null;
    },
    len: (obj) => {
      if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) return obj.length;
      if (obj instanceof Map || obj instanceof Set) return obj.size;
      if (obj instanceof AdderRange) return obj.length;
      if (typeof obj === 'object' && obj !== null) {
        if (typeof obj.__len__ === 'function') return obj.__len__();
        if (typeof obj.length === 'number') return obj.length;
        return Object.keys(obj).length;
      }
      throw new AdderError('TypeError', `object of type '${pyTypeName(obj)}' has no len()`);
    },
    range: (a, b, c) => new AdderRange(a, b, c),
    int: (x, base) => { if (x === undefined) return 0; if (base !== undefined) { const n = parseInt(String(x), base); if (isNaN(n)) throw new AdderError('ValueError', `invalid literal for int() with base ${base}: ${pyRepr(String(x))}`); return n; } if (typeof x === 'string') { const n = parseInt(x); if (isNaN(n)) throw new AdderError('ValueError', `invalid literal for int() with base 10: ${pyRepr(x)}`); return n; } return Math.trunc(Number(x)); },
    float: (x) => { if (x === undefined) return 0.0; if (typeof x === 'string') { const s = x.trim().toLowerCase(); if (s === 'inf' || s === '+inf' || s === 'infinity') return Infinity; if (s === '-inf' || s === '-infinity') return -Infinity; if (s === 'nan') return NaN; if (s === '') throw new AdderError('ValueError', `could not convert string to float: ${pyRepr(x)}`); const n = Number(x); if (isNaN(n)) throw new AdderError('ValueError', `could not convert string to float: ${pyRepr(x)}`); return n; } return Number(x); },
    str: (x) => x === undefined ? '' : pyStr(x),
    bool: (x) => x === undefined ? false : pyBool(x),
    list: async (x) => x === undefined ? [] : await pyCollect(x),
    tuple: async (x) => x === undefined ? [] : await pyCollect(x),
    dict: async (x) => {
      if (x === undefined) return {};
      if (x instanceof Map) return Object.fromEntries(x);
      const arr = Array.isArray(x) ? x : await pyCollect(x);
      if (arr.length && Array.isArray(arr[0])) { const o = {}; for (const [k, v] of arr) o[k] = v; return o; }
      if (typeof x === 'object') return { ...x };
      throw new AdderError('TypeError', `cannot convert '${pyTypeName(x)}' to dict`);
    },
    set: async (x) => x === undefined ? new Set() : new Set(await pyCollect(x)),
    abs: (x) => (typeof x === 'object' && x !== null && typeof x.__abs__ === 'function') ? x.__abs__() : Math.abs(x),
    round: (x, n) => {
      if (n === undefined || n === 0) return Math.round(x);
      const f = Math.pow(10, n);
      return Math.round(x * f) / f;
    },
    max: async (...args) => {
      let key = null;
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); key = kw.key; }
      const items = args.length === 1 ? await pyCollect(args[0]) : args;
      if (items.length === 0) throw new AdderError('ValueError', 'max() arg is an empty sequence');
      return items.reduce((a, b) => (key ? key(b) > key(a) : b > a) ? b : a);
    },
    min: async (...args) => {
      let key = null;
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); key = kw.key; }
      const items = args.length === 1 ? await pyCollect(args[0]) : args;
      if (items.length === 0) throw new AdderError('ValueError', 'min() arg is an empty sequence');
      return items.reduce((a, b) => (key ? key(b) < key(a) : b < a) ? b : a);
    },
    sum: async (iterable, start) => { let s = start !== undefined ? start : 0; for (const v of await pyCollect(iterable)) s += v; return s; },
    sorted: async (iterable, key, reverse) => {
      if (key?._kw) { reverse = key.reverse; key = key.key; }
      const arr = await pyCollect(iterable);
      if (key) {
        const keyed = [];
        for (let i = 0; i < arr.length; i++) keyed.push([await key(arr[i]), i, arr[i]]);
        keyed.sort((a, b) => _pyCompare(a[0], b[0]));
        const result = keyed.map(x => x[2]);
        if (reverse) result.reverse();
        return result;
      }
      arr.sort(_pyCompare);
      if (reverse) arr.reverse();
      return arr;
    },
    reversed: async (iterable) => { const arr = await pyCollect(iterable); arr.reverse(); return arr; },
    enumerate: async (iterable, start) => {
      const result = [];
      let i = start || 0;
      for (const v of await pyCollect(iterable)) result.push([i++, v]);
      return result;
    },
    zip: async (...iterables) => {
      if (iterables.length === 0) return [];
      const arrs = []; for (const it of iterables) arrs.push(await pyCollect(it));
      const minLen = Math.min(...arrs.map(a => a.length));
      const result = [];
      for (let i = 0; i < minLen; i++) result.push(arrs.map(a => a[i]));
      return result;
    },
    map: async (fn, ...iterables) => {
      const arr0 = await pyCollect(iterables[0]);
      if (iterables.length === 1) { const r = []; for (const v of arr0) r.push(await fn(v)); return r; }
      const arrs = [arr0]; for (let i = 1; i < iterables.length; i++) arrs.push(await pyCollect(iterables[i]));
      const minLen = Math.min(...arrs.map(a => a.length));
      const result = [];
      for (let i = 0; i < minLen; i++) result.push(await fn(...arrs.map(a => a[i])));
      return result;
    },
    filter: async (fn, iterable) => {
      const result = [];
      for (const v of await pyCollect(iterable)) { if (fn ? pyBool(await fn(v)) : pyBool(v)) result.push(v); }
      return result;
    },
    any: async (iterable) => { for (const v of await pyCollect(iterable)) if (pyBool(v)) return true; return false; },
    all: async (iterable) => { for (const v of await pyCollect(iterable)) if (!pyBool(v)) return false; return true; },
    isinstance: (obj, typeOrTuple) => _pyIsInstance(obj, typeOrTuple),
    type: (obj) => pyTypeName(obj),
    hasattr: (obj, name) => { try { adderGetAttr(obj, name); return true; } catch { return false; } },
    getattr: (obj, name, def) => { try { return adderGetAttr(obj, name); } catch { if (def !== undefined) return def; throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${name}'`); } },
    setattr: (obj, name, value) => { obj[name] = value; return null; },
    delattr: (obj, name) => { delete obj[name]; return null; },
    property: (fget) => ({ __property__: true, fget }),
    callable: (obj) => typeof obj === 'function',
    chr: (n) => String.fromCodePoint(n),
    ord: (c) => { if (typeof c !== 'string' || c.length !== 1) throw new AdderError('TypeError', 'ord() expected a character'); return c.codePointAt(0); },
    hex: (n) => { const v = Math.trunc(n); return v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16); },
    oct: (n) => { const v = Math.trunc(n); return v < 0 ? '-0o' + (-v).toString(8) : '0o' + v.toString(8); },
    bin: (n) => { const v = Math.trunc(n); return v < 0 ? '-0b' + (-v).toString(2) : '0b' + v.toString(2); },
    repr: pyRepr,
    format: (value, spec) => pyFormatValue(value, spec || ''),
    pow: (x, y, mod) => mod !== undefined ? _modPow(x, y, mod) : Math.pow(x, y),
    divmod: (a, b) => [Math.floor(a / b), ((a % b) + b) % b],
    id: (obj) => { if (typeof obj === 'object' && obj !== null) { if (!obj.__id__) obj.__id__ = ++_idCounter; return obj.__id__; } return 0; },
    hash: (obj) => { if (typeof obj === 'number') return obj; if (typeof obj === 'string') { let h = 0; for (let i = 0; i < obj.length; i++) h = (h * 31 + obj.charCodeAt(i)) | 0; return h; } return 0; },
    iter: (obj) => pyIter(obj),
    next: (iter, def) => { const r = iter.next(); if (r.done) { if (def !== undefined) return def; throw new AdderError('StopIteration', ''); } return r.value; },
    input: () => { throw new AdderError('NotImplementedError', 'input() is not supported in the browser'); },
    issubclass: () => false,
    vars: (obj) => obj ? { ...obj } : {},
    dir: (obj) => obj ? Object.keys(obj).sort() : [],
    object: () => ({}),
    super: () => { throw new AdderError('RuntimeError', 'super() is handled by the evaluator'); },
    ValueError: (msg) => new AdderError('ValueError', msg),
    TypeError: (msg) => new AdderError('TypeError', msg),
    KeyError: (msg) => new AdderError('KeyError', msg),
    IndexError: (msg) => new AdderError('IndexError', msg),
    AttributeError: (msg) => new AdderError('AttributeError', msg),
    RuntimeError: (msg) => new AdderError('RuntimeError', msg),
    StopIteration: (msg) => new AdderError('StopIteration', msg || ''),
    ZeroDivisionError: (msg) => new AdderError('ZeroDivisionError', msg),
    NotImplementedError: (msg) => new AdderError('NotImplementedError', msg),
    AssertionError: (msg) => new AdderError('AssertionError', msg),
    Exception: (msg) => new AdderError('Exception', msg),
    FileNotFoundError: (msg) => new AdderError('FileNotFoundError', msg),
    FileExistsError: (msg) => new AdderError('FileExistsError', msg),
    IsADirectoryError: (msg) => new AdderError('IsADirectoryError', msg),
    NotADirectoryError: (msg) => new AdderError('NotADirectoryError', msg),
    PermissionError: (msg) => new AdderError('PermissionError', msg),
    OSError: (msg) => new AdderError('OSError', msg),
    IOError: (msg) => new AdderError('IOError', msg),
    open: async (pathOrObj, mode) => {
      if (!_adderVFS) throw new AdderError('RuntimeError', 'filesystem not available — call adder.setVFS(vfsInstance, pathUtils) first');
      const raw = pathOrObj?._path ? pathOrObj._path : String(pathOrObj);
      const p = _resolvePath(raw, _vfsPath);
      return _createAdderFile(_adderVFS, p, mode || 'r');
    },
  };
  return builtins;
}

function _pyIsInstance(obj, typeOrTuple) {
  const types = Array.isArray(typeOrTuple) ? typeOrTuple : [typeOrTuple];
  const name = pyTypeName(obj);
  for (const t of types) {
    if (typeof t === 'string') { if (name === t) return true; }
    else if (typeof t === 'function') { if (obj instanceof t) return true; }
    else if (t === null) { if (obj === null) return true; }
  }
  return false;
}

function _modPow(base, exp, mod) {
  let result = 1;
  base = ((base % mod) + mod) % mod;
  while (exp > 0) {
    if (exp % 2 === 1) result = (result * base) % mod;
    exp = Math.floor(exp / 2);
    base = (base * base) % mod;
  }
  return result;
}

let _idCounter = 0;
