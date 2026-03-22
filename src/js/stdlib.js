// ── STDLIB ──
// Bundled standard library for notebook work.
// Module-level — no per-cell state needed.

import { fsWrite } from './fs.js';

// ── Provider Registry ──

const _providers = { file: null, download: null };

export function registerProvider(name, fn) {
  if (name in _providers) _providers[name] = fn;
}

// ── Data ──

function csv(text, opts = {}) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sep = opts.separator || ',';
  const typed = !!opts.typed;
  const lines = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      if (text[i] === '"') {
        // quoted field
        i++;
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i]; i++; }
        }
        row.push(field);
        if (text[i] === sep) i++;
        else if (text[i] === '\r') { i++; if (text[i] === '\n') i++; break; }
        else if (text[i] === '\n') { i++; break; }
        else if (i >= len) break;
      } else {
        // unquoted field
        let field = '';
        while (i < len && text[i] !== sep && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i]; i++;
        }
        row.push(field);
        if (text[i] === sep) i++;
        else if (text[i] === '\r') { i++; if (text[i] === '\n') i++; break; }
        else if (text[i] === '\n') { i++; break; }
        else break;
      }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) lines.push(row);
  }

  if (lines.length < 2) return [];
  const headers = lines[0];
  const result = [];
  for (let r = 1; r < lines.length; r++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      let val = lines[r][c] !== undefined ? lines[r][c] : '';
      if (typed) {
        const num = Number(val);
        if (val !== '' && !isNaN(num)) val = num;
        else if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (val === '') val = null;
      }
      obj[headers[c]] = val;
    }
    result.push(obj);
  }
  return result;
}

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetchJSON: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── Math / Stats ──

function _acc(arr, fn) {
  return fn ? arr.map(fn) : arr;
}

function sum(arr, fn) {
  const vals = _acc(arr, fn);
  let s = 0;
  for (let i = 0; i < vals.length; i++) s += vals[i];
  return s;
}

function mean(arr, fn) {
  if (!arr.length) return NaN;
  return sum(arr, fn) / arr.length;
}

function median(arr, fn) {
  const vals = _acc(arr, fn).slice().sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return vals[(n - 1) / 2];
  return (vals[n / 2 - 1] + vals[n / 2]) / 2;
}

function extent(arr, fn) {
  const vals = _acc(arr, fn);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] < lo) lo = vals[i];
    if (vals[i] > hi) hi = vals[i];
  }
  return [lo, hi];
}

function bin(arr, n = 10, fn) {
  const vals = _acc(arr, fn);
  const [lo, hi] = extent(vals);
  const range = hi - lo || 1;
  const step = range / n;
  const bins = [];
  for (let i = 0; i < n; i++) {
    bins.push({ x0: lo + i * step, x1: lo + (i + 1) * step, values: [] });
  }
  for (const v of vals) {
    let idx = Math.floor((v - lo) / step);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    bins[idx].values.push(v);
  }
  return bins;
}

function linspace(start, stop, n) {
  if (n < 2) return n === 1 ? [start] : [];
  const result = new Array(n);
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) result[i] = start + i * step;
  result[n - 1] = stop; // exact endpoint
  return result;
}

// ── Array ──

function unique(arr, fn) {
  if (!fn) return [...new Set(arr)];
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const key = fn(item);
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

function zip(...arrays) {
  const len = Math.min(...arrays.map(a => a.length));
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = arrays.map(a => a[i]);
  }
  return result;
}

function cross(...arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const sub = cross(...rest);
  const result = [];
  for (const item of first) {
    for (const tail of sub) {
      result.push([item, ...tail]);
    }
  }
  return result;
}

// ── DOM / IO ──

async function file(accept) {
  const opts = typeof accept === 'string' ? { accept } : (accept || {});
  if (_providers.file && !opts.embed) return _providers.file(opts.accept || accept);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) { reject(new Error('no file selected')); return; }
      if (opts.embed) {
        // embed in notebook filesystem — fsWrite is in same IIFE scope (fs.js loaded before stdlib.js)
        const path = (opts.prefix || '') + f.name;
        await fsWrite(path, new Uint8Array(await f.arrayBuffer()), { type: f.type || undefined });
        resolve(path);
      } else {
        const text = await f.text();
        resolve({ name: f.name, text, size: f.size });
      }
    };
    input.click();
  });
}

function download(data, filename, mimeType) {
  if (_providers.download) return _providers.download(data, filename, mimeType);
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const mime = mimeType || (typeof data === 'string' ? 'text/plain' : 'application/json');
  const blob = new Blob([str], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag, attrs, ...children) {
  const elem = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(elem.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        elem.addEventListener(k.slice(2), v);
      } else {
        elem.setAttribute(k, v);
      }
    }
  } else if (attrs != null) {
    // attrs is actually a child
    children.unshift(attrs);
  }
  for (const child of children) {
    if (child instanceof Node) elem.appendChild(child);
    else if (child != null) elem.appendChild(document.createTextNode(String(child)));
  }
  return elem;
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
}

function fmt(number, opts = {}) {
  const { decimals, prefix, suffix } = opts;
  let s = decimals != null ? number.toFixed(decimals)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(number);
  if (prefix) s = prefix + s;
  if (suffix) s = s + suffix;
  return s;
}

// ── Source inclusion with dependency resolution ──

function include(libs, ...names) {
  // accept single library or array of libraries
  const list = Array.isArray(libs) && libs[0] && libs[0].sources ? libs : [libs];
  // merge all libraries into unified sources + deps
  const sources = {}, deps = {};
  for (const lib of list) {
    if (!lib || !lib.sources || !lib.deps)
      throw new Error('include: expected library with sources and deps');
    Object.assign(sources, lib.sources);
    Object.assign(deps, lib.deps);
  }
  const needed = new Set();
  function walk(name) {
    if (needed.has(name)) return;
    if (!sources[name]) throw new Error(`include: unknown routine '${name}'`);
    needed.add(name);
    for (const dep of deps[name] || []) walk(dep);
  }
  names.forEach(walk);
  // topological sort: deps before dependents
  const sorted = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of deps[name] || []) visit(dep);
    sorted.push(name);
  }
  needed.forEach(visit);
  return sorted.map(n => sources[n]).join('\n\n');
}

// ── Color Science ──

// sRGB gamma transfer
function srgbToLinear(x) {
  x /= 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function linearToSrgb(x) {
  x = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, x * 255)));
}

// RGB ↔ linear RGB
function rgbToLinear(r, g, b) {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}
function linearToRgb(lr, lg, lb) {
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

// linear RGB ↔ OKLAB (via LMS)
function linearToOklab(lr, lg, lb) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// OKLAB ↔ OKLCH (polar)
function oklabToOklch(L, a, b) {
  return [L, Math.sqrt(a * a + b * b), Math.atan2(b, a) * 180 / Math.PI];
}
function oklchToOklab(L, C, h) {
  const hRad = h * Math.PI / 180;
  return [L, C * Math.cos(hRad), C * Math.sin(hRad)];
}

// composite conversions
function rgbToOklab(r, g, b) {
  const [lr, lg, lb] = rgbToLinear(r, g, b);
  return linearToOklab(lr, lg, lb);
}
function rgbToOklch(r, g, b) {
  const [L, a, bb] = rgbToOklab(r, g, b);
  return oklabToOklch(L, a, bb);
}
function oklabToRgb(L, a, b) {
  const [lr, lg, lb] = oklabToLinear(L, a, b);
  return linearToRgb(lr, lg, lb);
}

// RGB ↔ HSL
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

// build frozen color object (no parsing)
function _makeColor(r, g, b, a) {
  r = Math.round(Math.max(0, Math.min(255, r)));
  g = Math.round(Math.max(0, Math.min(255, g)));
  b = Math.round(Math.max(0, Math.min(255, b)));
  a = Math.max(0, Math.min(1, a));
  return Object.freeze({
    r, g, b, a,
    hsl() { const [h, s, l] = rgbToHsl(r, g, b); return { h, s, l }; },
    oklab() { const [L, oa, ob] = rgbToOklab(r, g, b); return { L, a: oa, b: ob }; },
    oklch() { const [L, C, oh] = rgbToOklch(r, g, b); return { L, C, h: oh }; },
    linear() { const [lr, lg, lb] = rgbToLinear(r, g, b); return { r: lr, g: lg, b: lb }; },
    lighten(amt) {
      const [L, ca, cb] = rgbToOklab(r, g, b);
      const [nr, ng, nb] = oklabToRgb(Math.min(1, L + amt), ca, cb);
      return _makeColor(nr, ng, nb, a);
    },
    darken(amt) {
      const [L, ca, cb] = rgbToOklab(r, g, b);
      const [nr, ng, nb] = oklabToRgb(Math.max(0, L - amt), ca, cb);
      return _makeColor(nr, ng, nb, a);
    },
    saturate(amt) {
      const [L, C, h] = rgbToOklch(r, g, b);
      const [ca, cb] = oklchToOklab(L, Math.max(0, C + amt), h).slice(1);
      const [nr, ng, nb] = oklabToRgb(L, ca, cb);
      return _makeColor(nr, ng, nb, a);
    },
    desaturate(amt) {
      const [L, C, h] = rgbToOklch(r, g, b);
      const [ca, cb] = oklchToOklab(L, Math.max(0, C - amt), h).slice(1);
      const [nr, ng, nb] = oklabToRgb(L, ca, cb);
      return _makeColor(nr, ng, nb, a);
    },
    rotate(deg) {
      const [L, C, h] = rgbToOklch(r, g, b);
      const [_, ca, cb] = oklchToOklab(L, C, h + deg);
      const [nr, ng, nb] = oklabToRgb(L, ca, cb);
      return _makeColor(nr, ng, nb, a);
    },
    mix(other, t = 0.5) {
      const c2 = other.r !== undefined ? other : color(other);
      const [L1, a1, b1] = rgbToOklab(r, g, b);
      const [L2, a2, b2] = rgbToOklab(c2.r, c2.g, c2.b);
      const [nr, ng, nb] = oklabToRgb(
        L1 + (L2 - L1) * t, a1 + (a2 - a1) * t, b1 + (b2 - b1) * t
      );
      return _makeColor(nr, ng, nb, a + (c2.a - a) * t);
    },
    alpha(na) { return _makeColor(r, g, b, na); },
    css() { return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`; },
    hex() {
      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    },
    toString() { return a < 1 ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`; },
  });
}

// public color factory with parsing
function color(input) {
  if (input && typeof input === 'object' && input.r !== undefined) {
    return _makeColor(input.r, input.g, input.b, input.a !== undefined ? input.a : 1);
  }
  if (Array.isArray(input)) {
    return _makeColor(input[0], input[1], input[2], input[3] !== undefined ? input[3] : 1);
  }
  if (typeof input !== 'string') throw new Error('color: invalid input');
  const s = input.trim();
  // hex
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      return _makeColor(
        parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1
      );
    }
    if (h.length === 4) {
      return _makeColor(
        parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16) / 255
      );
    }
    if (h.length === 6) {
      return _makeColor(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1);
    }
    if (h.length === 8) {
      return _makeColor(
        parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255
      );
    }
    throw new Error('color: invalid hex');
  }
  // rgb()/rgba()
  let m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return _makeColor(+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1);
  // hsl()/hsla()
  m = s.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const [r, g, b] = hslToRgb(+m[1], +m[2], +m[3]);
    return _makeColor(r, g, b, m[4] !== undefined ? +m[4] : 1);
  }
  throw new Error('color: unrecognized format');
}

// expose conversion helpers on color function
Object.assign(color, {
  srgbToLinear, linearToSrgb,
  rgbToLinear, linearToRgb,
  linearToOklab, oklabToLinear,
  oklabToOklch, oklchToOklab,
  rgbToOklab, rgbToOklch, oklabToRgb,
  rgbToHsl, hslToRgb,
});

// ── Colormaps ──

function _poly(coeffs, t) {
  let r = coeffs[coeffs.length - 1];
  for (let i = coeffs.length - 2; i >= 0; i--) r = r * t + coeffs[i];
  return r;
}

function _cmap(rC, gC, bC) {
  return (t) => {
    t = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(Math.max(0, Math.min(255, _poly(rC, t) * 255)))},${
      Math.round(Math.max(0, Math.min(255, _poly(gC, t) * 255)))},${
      Math.round(Math.max(0, Math.min(255, _poly(bC, t) * 255)))})`;
  };
}

const viridis = _cmap(
  [0.267, 0.004, 5.294, -14.05, 8.5],
  [0.004, 1.384, 0.098, -2.74, 2.23],
  [0.329, 1.44, -5.11, 6.87, -3.57]
);

const magma = _cmap(
  [-0.002, 0.804, 6.37, -15.96, 9.78],
  [0.0, -0.398, 4.23, -7.76, 4.95],
  [0.015, 2.68, -9.39, 14.23, -6.53]
);

const inferno = _cmap(
  [0.0, 0.12, 10.82, -25.58, 15.63],
  [0.0, 0.06, 2.35, -3.98, 2.56],
  [0.015, 2.26, -8.72, 13.6, -6.14]
);

const plasma = _cmap(
  [0.05, 2.63, -3.47, 2.65, -0.88],
  [0.03, -0.69, 4.07, -6.25, 3.83],
  [0.53, 1.74, -5.35, 7.55, -3.49]
);

const turbo = _cmap(
  [0.19, 3.08, -3.92, 1.66],
  [0.08, 3.54, -8.42, 5.79],
  [0.58, -2.58, 7.52, -11.42, 6.88]
);

// ── Color Scale ──

function colorScale(domain, colors) {
  if (typeof colors === 'function') {
    // colormap function: linear mapping from domain to [0,1]
    const lo = domain[0], hi = domain[domain.length - 1];
    const range = hi - lo || 1;
    return (v) => colors(Math.max(0, Math.min(1, (v - lo) / range)));
  }
  if (domain.length !== colors.length)
    throw new Error('colorScale: domain and colors must have same length');
  // parse colors once
  const parsed = colors.map(c => typeof c === 'string' ? color(c) : c);
  const lo = domain[0], hi = domain[domain.length - 1];
  return (v) => {
    v = Math.max(lo, Math.min(hi, v));
    // find segment
    for (let i = 0; i < domain.length - 1; i++) {
      if (v <= domain[i + 1] || i === domain.length - 2) {
        const segRange = domain[i + 1] - domain[i] || 1;
        const t = (v - domain[i]) / segRange;
        return parsed[i].mix(parsed[i + 1], t).css();
      }
    }
    return parsed[0].css();
  };
}

// ── Palette ──

const palette10 = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

// ── Zip / Unzip ──
// Pure browser-native zip using CompressionStream('deflate-raw').
// Same implementation as ext/sheet/src/zip.js.

const _CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  _CRC32_TABLE[i] = c;
}

function _crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = _CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const _enc = new TextEncoder();
const _dec = new TextDecoder();

async function _deflateRaw(data) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function _inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function _readU16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function _readU32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0; }
function _writeU16(buf, off, val) { buf[off] = val & 0xFF; buf[off + 1] = (val >> 8) & 0xFF; }
function _writeU32(buf, off, val) { buf[off] = val & 0xFF; buf[off + 1] = (val >> 8) & 0xFF; buf[off + 2] = (val >> 16) & 0xFF; buf[off + 3] = (val >> 24) & 0xFF; }

async function unzipFn(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = new Map();
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (_readU32(buf, i) === 0x06054B50) { eocdOff = i; break; }
  }
  if (eocdOff === -1) throw new Error('not a ZIP file: EOCD not found');
  const entryCount = _readU16(buf, eocdOff + 10);
  let cdOff = _readU32(buf, eocdOff + 16);
  for (let e = 0; e < entryCount; e++) {
    if (_readU32(buf, cdOff) !== 0x02014B50) throw new Error('bad central directory entry');
    const method = _readU16(buf, cdOff + 10);
    const crc = _readU32(buf, cdOff + 16);
    const compSize = _readU32(buf, cdOff + 20);
    const nameLen = _readU16(buf, cdOff + 28);
    const extraLen = _readU16(buf, cdOff + 30);
    const commentLen = _readU16(buf, cdOff + 32);
    const localOff = _readU32(buf, cdOff + 42);
    const name = _dec.decode(buf.subarray(cdOff + 46, cdOff + 46 + nameLen));
    cdOff += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const localNameLen = _readU16(buf, localOff + 26);
    const localExtraLen = _readU16(buf, localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) data = compressed.slice();
    else if (method === 8) data = await _inflateRaw(compressed);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (_crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    entries.set(name, data);
  }
  return entries;
}

async function zipFn(entries) {
  const items = entries instanceof Map ? [...entries] : entries;
  const localHeaders = [];
  const centralEntries = [];
  let offset = 0;
  for (const [name, raw] of items) {
    const nameBytes = _enc.encode(name);
    const crc = _crc32(raw);
    const compressed = await _deflateRaw(raw);
    const useDeflate = compressed.length < raw.length;
    const stored = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    _writeU32(local, 0, 0x04034B50);
    _writeU16(local, 4, 20);
    _writeU16(local, 8, method);
    _writeU32(local, 14, crc);
    _writeU32(local, 18, stored.length);
    _writeU32(local, 22, raw.length);
    _writeU16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    localHeaders.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    _writeU32(central, 0, 0x02014B50);
    _writeU16(central, 4, 20);
    _writeU16(central, 6, 20);
    _writeU16(central, 10, method);
    _writeU32(central, 16, crc);
    _writeU32(central, 20, stored.length);
    _writeU32(central, 24, raw.length);
    _writeU16(central, 28, nameBytes.length);
    _writeU32(central, 42, offset);
    central.set(nameBytes, 46);
    centralEntries.push(central);
    offset += local.length;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralEntries) cdSize += c.length;
  const eocd = new Uint8Array(22);
  _writeU32(eocd, 0, 0x06054B50);
  _writeU16(eocd, 8, items.length);
  _writeU16(eocd, 10, items.length);
  _writeU32(eocd, 12, cdSize);
  _writeU32(eocd, 16, cdOffset);
  const total = offset + cdSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const l of localHeaders) { result.set(l, pos); pos += l.length; }
  for (const c of centralEntries) { result.set(c, pos); pos += c.length; }
  result.set(eocd, pos);
  return result;
}

// expose for fs.js import/export
if (typeof window !== 'undefined') {
  window._stdZip = zipFn;
  window._stdUnzip = unzipFn;
}

// ── Export ──

function hsl(h, s, l, a = 1) {
  const [r, g, b] = hslToRgb(h, s, l);
  return _makeColor(r, g, b, a);
}

export const std = {
  csv, fetchJSON,
  sum, mean, median, extent, bin, linspace,
  unique, zip, cross,
  file, download, el, copy, fmt,
  include, zipArchive: zipFn, unzipArchive: unzipFn,
  color, colorScale, hsl,
  viridis, magma, inferno, plasma, turbo,
  palette10,
  ...(typeof VFS !== 'undefined' ? { VFS, path } : {}),
};
