// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/plot/src/  Build: node ext/plot/build.js
// @gcu/plot — Canvas 2D plotting library for Auditable
// Line, scatter, bar, histogram, imshow. GCU dark theme.

// -- scale.js --

// Linear scale with Heckbert nice-number tick generation

function _niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else {
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
  }
  return nice * Math.pow(10, exp);
}

class LinearScale {
  constructor(domain, range) {
    this.domain = domain;
    this.range = range;
  }

  transform(v) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const dr = d1 - d0;
    if (dr === 0) return (r0 + r1) / 2;
    return r0 + (v - d0) / dr * (r1 - r0);
  }

  inverse(px) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const rr = r1 - r0;
    if (rr === 0) return (d0 + d1) / 2;
    return d0 + (px - r0) / rr * (d1 - d0);
  }

  ticks(count) {
    if (count == null) count = 5;
    const [lo, hi] = this.domain;
    const range = _niceNum(hi - lo, false);
    const step = _niceNum(range / (count - 1), true);
    const start = Math.ceil(lo / step) * step;
    const end = Math.floor(hi / step) * step;
    const ticks = [];
    // safety: ensure finite loop
    if (step <= 0 || !isFinite(start) || !isFinite(end)) return [lo, hi];
    for (let v = start; v <= end + step * 0.5; v += step) {
      ticks.push(+v.toPrecision(12));
    }
    return ticks;
  }

  tickFormat() {
    const [lo, hi] = this.domain;
    const range = Math.abs(hi - lo);
    if (range === 0) return (v) => String(v);
    const mag = Math.log10(Math.max(Math.abs(lo), Math.abs(hi), 1e-30));
    if (mag > 6 || mag < -3) return (v) => v.toExponential(1);
    const dec = Math.max(0, -Math.floor(Math.log10(range)) + 1);
    return (v) => v.toFixed(Math.min(dec, 6));
  }
}

// Log10 scale — matplotlib's `set_xscale('log')` equivalent. Domain
// must be strictly positive; callers should clamp lo before passing.
// Ticks are integer powers of 10 within the domain.
class LogScale {
  constructor(domain, range) {
    // Clamp lo to a tiny positive value if non-positive (defensive).
    const [d0, d1] = domain;
    this.domain = [d0 > 0 ? d0 : 1e-300, d1 > 0 ? d1 : 1];
    this.range = range;
  }

  transform(v) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    if (v <= 0) return r0;
    const l0 = Math.log10(d0);
    const l1 = Math.log10(d1);
    const dr = l1 - l0;
    if (dr === 0) return (r0 + r1) / 2;
    return r0 + (Math.log10(v) - l0) / dr * (r1 - r0);
  }

  inverse(px) {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    const rr = r1 - r0;
    const l0 = Math.log10(d0);
    const l1 = Math.log10(d1);
    if (rr === 0) return Math.pow(10, (l0 + l1) / 2);
    return Math.pow(10, l0 + (px - r0) / rr * (l1 - l0));
  }

  ticks() {
    const [lo, hi] = this.domain;
    const loE = Math.ceil(Math.log10(lo));
    const hiE = Math.floor(Math.log10(hi));
    const ticks = [];
    // Limit decade-count so degenerate domains don't blow up.
    if (hiE - loE > 30) return [lo, hi];
    for (let e = loE; e <= hiE; e++) ticks.push(Math.pow(10, e));
    return ticks;
  }

  tickFormat() {
    return (v) => {
      const e = Math.round(Math.log10(v));
      // Pretty-print integer powers as 10^N.
      if (Math.abs(Math.pow(10, e) - v) / v < 1e-6) {
        if (e >= -3 && e <= 4) return Math.pow(10, e).toString();
        return '10^' + e;
      }
      return v.toExponential(1);
    };
  }
}

// -- color.js --

// Colormaps — polynomial approximation (same as stdlib.js)

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

const _cmaps = {
  viridis: _cmap(
    [0.267, 0.004, 5.294, -14.05, 8.5],
    [0.004, 1.384, 0.098, -2.74, 2.23],
    [0.329, 1.44, -5.11, 6.87, -3.57]
  ),
  coolwarm: _cmap(
    [0.23, 2.82, -4.67, 3.54, -0.93],
    [0.30, 1.26, -3.87, 6.49, -3.19],
    [0.75, 0.53, -3.04, 5.56, -2.82]
  ),
  turbo: _cmap(
    [0.19, 3.08, -3.92, 1.66],
    [0.08, 3.54, -8.42, 5.79],
    [0.58, -2.58, 7.52, -11.42, 6.88]
  ),
};

function getCmap(name) {
  if (typeof name === 'function') return name;
  return _cmaps[name] || _cmaps.viridis;
}

function cmapRgb(name, t) {
  return getCmap(name)(t);
}

function renderColorbar(ctx, x, y, w, h, cmap, vmin, vmax, opts) {
  const cmapFn = getCmap(cmap);
  const n = Math.max(1, Math.floor(h));
  for (let i = 0; i < n; i++) {
    const t = 1 - i / (n - 1);
    ctx.fillStyle = cmapFn(t);
    ctx.fillRect(x, y + i, w, Math.ceil(h / n) + 1);
  }
  // tick labels
  const textColor = opts?.textColor || '#ccc';
  ctx.fillStyle = textColor;
  ctx.font = opts?.font || '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const nticks = opts?.nticks || 5;
  const fmt = opts?.format || ((v) => {
    const range = Math.abs(vmax - vmin);
    if (range === 0) return String(v);
    const mag = Math.log10(Math.max(Math.abs(vmin), Math.abs(vmax), 1e-30));
    if (mag > 6 || mag < -3) return v.toExponential(1);
    const dec = Math.max(0, -Math.floor(Math.log10(range)) + 1);
    return v.toFixed(Math.min(dec, 6));
  });
  for (let i = 0; i < nticks; i++) {
    const t = i / (nticks - 1);
    const val = vmin + (1 - t) * (vmax - vmin);
    const ty = y + t * h;
    ctx.fillText(fmt(val), x + w + 4, ty);
  }
  // label
  if (opts?.label) {
    ctx.save();
    ctx.translate(x + w + 40, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label, 0, 0);
    ctx.restore();
  }
}

// -- format.js --

// Format string parser: 'r--o' → { color, linestyle, marker }

const _colorChars = { b: '#4488ff', g: '#44bb44', r: '#ee4444', c: '#44dddd', m: '#dd44dd', y: '#dddd44', k: '#000000', w: '#ffffff' };
const _markerChars = new Set(['o', 's', '^', 'v', '<', '>', 'd', '+', 'x', '.']);

function parseFormat(fmt) {
  if (!fmt || typeof fmt !== 'string') return {};
  const result = {};
  let i = 0;
  // check for color char
  if (_colorChars[fmt[i]]) {
    result.color = _colorChars[fmt[i]];
    i++;
  }
  // check for linestyle
  if (fmt[i] === '-') {
    if (fmt[i + 1] === '-') { result.linestyle = '--'; i += 2; }
    else if (fmt[i + 1] === '.') { result.linestyle = '-.'; i += 2; }
    else { result.linestyle = '-'; i++; }
  } else if (fmt[i] === ':') {
    result.linestyle = ':';
    i++;
  }
  // check for marker
  if (_markerChars.has(fmt[i])) {
    result.marker = fmt[i];
    i++;
  }
  return result;
}

function dashArray(linestyle) {
  switch (linestyle) {
    case '--': return [6, 4];
    case '-.': return [6, 2, 2, 2];
    case ':': return [2, 3];
    default: return [];
  }
}

// -- axes.js --

// Axes — trace storage, layout computation, canvas rendering




const _defaultColors = ['#c89b3c', '#5ba3b5', '#e07050', '#7a8b99', '#b5854b', '#5bb58b'];

// matplotlib short-form aliases — `c` for color, `ls` for linestyle,
// `lw` for linewidth, etc. We accept both, callers in the wild use
// either. Resolve into canonical names at trace ingress so renderers
// can read a single key.
const _ALIASES = {
  c: 'color',
  ls: 'linestyle',
  lw: 'linewidth',
  ms: 'markersize',
  mec: 'markeredgecolor',
  mfc: 'markerfacecolor',
  mew: 'markeredgewidth',
};
function _resolveAliases(o) {
  if (!o) return o;
  for (const [a, k] of Object.entries(_ALIASES)) {
    if (o[a] !== undefined && o[k] === undefined) o[k] = o[a];
  }
  return o;
}

// Coerce inputs from various ndarray libraries (natra's WASM-arena
// descriptor, vec's data-backed shape, plain TypedArrays, native JS
// arrays, lists from adder) into a JS array we can iterate, spread,
// and Math.min/.max over. Used at every trace ingress so plt.hist /
// plt.plot / plt.bar etc. don't have to care about input shape.
function _toArr(x) {
  if (Array.isArray(x)) return x;
  if (x == null) return [];
  // natra adder wrapper: {_nd: true, _arr: <descriptor>}
  if (x._nd && x._arr) {
    const a = x._arr;
    if (a.memory && a.memory.buffer && a.dtype === 'f64' && typeof a.ptr === 'number') {
      return Array.from(new Float64Array(a.memory.buffer, a.ptr, a.length));
    }
    if (a.data) return Array.from(a.data.subarray ? a.data.subarray(0, a.length) : a.data);
  }
  // data-backed ndarray (vec / numpy-like)
  if (x.data && (x.data.buffer || ArrayBuffer.isView(x.data))) {
    return Array.from(x.data.length != null ? x.data.subarray ? x.data.subarray(0, x.length || x.data.length) : x.data : x.data);
  }
  // TypedArray / iterable
  if (ArrayBuffer.isView(x)) return Array.from(x);
  if (typeof x[Symbol.iterator] === 'function') return Array.from(x);
  return [x];
}

class Axes {
  constructor() {
    this._traces = [];
    this._title = null;
    this._xlabel = null;
    this._ylabel = null;
    this._xlim = null;
    this._ylim = null;
    this._grid = false;
    this._gridOpts = {};
    this._legend = false;
    this._legendOpts = {};
    this._colorbar = false;
    this._colorbarOpts = {};
    this._aspect = 'auto';
    this._colorIdx = 0;
  }

  _nextColor() {
    return _defaultColors[this._colorIdx++ % _defaultColors.length];
  }

  plot(x, y, fmtOrOpts, opts) {
    let o = {};
    if (typeof fmtOrOpts === 'string') {
      o = { ...parseFormat(fmtOrOpts), ...opts };
    } else if (fmtOrOpts) {
      o = { ...fmtOrOpts };
      if (o.fmt) Object.assign(o, parseFormat(o.fmt));
    }
    _resolveAliases(o);
    if (!o.color) o.color = this._nextColor();
    this._traces.push({ type: 'line', x, y, opts: o });
    return this;
  }

  scatter(x, y, opts) {
    const o = _resolveAliases({ ...opts });
    if (!o.color) o.color = this._nextColor();
    this._traces.push({ type: 'scatter', x, y, opts: o });
    return this;
  }

  bar(x, heights, opts) {
    const o = _resolveAliases({ ...opts });
    if (!o.color) o.color = this._nextColor();
    this._traces.push({ type: 'bar', x, heights, opts: o });
    return this;
  }

  barh(y, widths, opts) {
    const o = _resolveAliases({ ...opts });
    if (!o.color) o.color = this._nextColor();
    this._traces.push({ type: 'barh', y, widths, opts: o });
    return this;
  }

  hist(data, opts) {
    const o = _resolveAliases({ ...opts });
    if (!o.color) o.color = this._nextColor();
    // Normalize data + bins to JS arrays so ndarray inputs (natra,
    // vec, TypedArrays) work the same as native lists.
    const dataArr = _toArr(data);
    if (o.bins != null && typeof o.bins !== 'number') o.bins = _toArr(o.bins);
    this._traces.push({ type: 'hist', data: dataArr, opts: o });
    return this;
  }

  imshow(data, nx, ny, opts) {
    this._traces.push({ type: 'imshow', data, nx, ny, opts: _resolveAliases({ ...opts }) });
    // default to equal aspect for grid data (matches matplotlib)
    if (this._aspect === 'auto') this._aspect = 'equal';
    return this;
  }

  axhline(y, opts) {
    this._traces.push({ type: 'hline', y, opts: _resolveAliases({ color: '#888', linewidth: 1, ...opts }) });
    return this;
  }

  axvline(x, opts) {
    this._traces.push({ type: 'vline', x, opts: _resolveAliases({ color: '#888', linewidth: 1, ...opts }) });
    return this;
  }

  // vlines(x, ymin, ymax) — vertical line segments. x can be scalar or
  // array. Implemented as line traces (x=[x_i,x_i] y=[ymin,ymax]) so no
  // new trace type is needed.
  vlines(x, ymin, ymax, opts) {
    const xs = _toArr(x);
    const o = _resolveAliases({ ...opts });
    if (!o.color && o.colors) o.color = Array.isArray(o.colors) ? o.colors[0] : o.colors;
    if (!o.color) o.color = this._nextColor();
    for (const xv of xs) {
      this._traces.push({ type: 'line', x: [xv, xv], y: [ymin, ymax], opts: { ...o } });
    }
    return this;
  }

  hlines(y, xmin, xmax, opts) {
    const ys = _toArr(y);
    const o = _resolveAliases({ ...opts });
    if (!o.color && o.colors) o.color = Array.isArray(o.colors) ? o.colors[0] : o.colors;
    if (!o.color) o.color = this._nextColor();
    for (const yv of ys) {
      this._traces.push({ type: 'line', x: [xmin, xmax], y: [yv, yv], opts: { ...o } });
    }
    return this;
  }

  text(x, y, text, opts) {
    this._traces.push({ type: 'text', x, y, text, opts: _resolveAliases({ color: '#ccc', fontsize: 11, ...opts }) });
    return this;
  }

  set_title(text, opts) { this._title = { text, opts }; return this; }
  set_xlabel(text, opts) { this._xlabel = { text, opts }; return this; }
  set_ylabel(text, opts) { this._ylabel = { text, opts }; return this; }
  set_xlim(lo, hi) {
    // matplotlib's set_xlim accepts either set_xlim(lo, hi) or set_xlim([lo, hi]).
    if (Array.isArray(lo) && hi === undefined) { hi = lo[1]; lo = lo[0]; }
    this._xlim = [lo, hi]; return this;
  }
  set_ylim(lo, hi) {
    if (Array.isArray(lo) && hi === undefined) { hi = lo[1]; lo = lo[0]; }
    this._ylim = [lo, hi]; return this;
  }
  set_xscale(scale) { this._xscale = scale; return this; }
  set_yscale(scale) { this._yscale = scale; return this; }
  set_zorder(_n) { /* z-order is per-trace; axes-level ordering not modelled */ return this; }
  set_aspect(aspect) { this._aspect = aspect; return this; }
  // twinx() — return a sister axes that shares this one's x-scale, has
  // its own y-scale, and renders overlaid in the same rect with its
  // y-axis on the right edge. Matches matplotlib's pyplot twinx for
  // dual-y plots (e.g. histogram on left axis, CDF on right axis).
  // The twin is NOT added to the figure's axes grid — its parent
  // renders it as part of its own _render pass.
  twinx() {
    const t = new Axes();
    t._twinOf = this;
    // Inherit x-scale settings so they stay in sync.
    t._xscale = this._xscale;
    t._xlim = this._xlim;
    this._twin = t;
    return t;
  }
  // twiny() in matplotlib shares y not x. Rare in practice; alias to
  // twinx for the common-case "I want two y-axes" intent.
  twiny() { return this.twinx(); }

  legend(opts) { this._legend = true; this._legendOpts = opts || {}; return this; }

  colorbar(opts) { this._colorbar = true; this._colorbarOpts = opts || {}; return this; }

  grid(on, opts) {
    this._grid = on !== false;
    if (opts) this._gridOpts = opts;
    return this;
  }

  // --- rendering ---

  _render(ctx, rect) {
    const textColor = '#ccc';
    const font = '11px monospace';
    const smallFont = '10px monospace';

    // compute margins
    let ml = this._ylabel ? 55 : 42;
    let mr = this._colorbar ? 70 : 12;
    // Right-side twin axis needs space for its tick labels (+ optional ylabel).
    if (this._twin) mr = Math.max(mr, this._twin._ylabel ? 55 : 42);
    let mt = this._title ? 24 : 8;
    let mb = this._xlabel ? 38 : 26;

    const plotX = rect.x + ml;
    const plotY = rect.y + mt;
    const plotW = rect.x + rect.w - mr - plotX;
    const plotH = rect.y + rect.h - mb - plotY;
    if (plotW <= 0 || plotH <= 0) return;

    // compute data ranges
    let [xlo, xhi] = this._xlim || this._dataExtent('x');
    let [ylo, yhi] = this._ylim || this._dataExtent('y');
    if (xlo === xhi) { xlo -= 0.5; xhi += 0.5; }
    if (ylo === yhi) { ylo -= 0.5; yhi += 0.5; }

    // aspect ratio adjustment
    if (this._aspect === 'equal') {
      const dataW = xhi - xlo;
      const dataH = yhi - ylo;
      const scaleX = plotW / dataW;
      const scaleY = plotH / dataH;
      if (scaleX < scaleY) {
        const center = (ylo + yhi) / 2;
        const half = (plotH / scaleX) / 2;
        ylo = center - half;
        yhi = center + half;
      } else {
        const center = (xlo + xhi) / 2;
        const half = (plotW / scaleY) / 2;
        xlo = center - half;
        xhi = center + half;
      }
    }

    // Log scale needs strictly-positive bounds; clamp lo to the
    // smallest positive value present in the data (falling back to
    // hi/10 or 1e-9) so set_xscale('log') with auto-extent works on
    // lognormal-shaped data.
    function _logBounds(lo, hi) {
      let l = lo, h = hi;
      if (l <= 0) l = h > 0 ? h / 1e6 : 1e-9;
      if (h <= l) h = l * 10;
      return [l, h];
    }
    const _xScaleCls = this._xscale === 'log' ? LogScale : LinearScale;
    const _yScaleCls = this._yscale === 'log' ? LogScale : LinearScale;
    const [xloS, xhiS] = this._xscale === 'log' ? _logBounds(xlo, xhi) : [xlo, xhi];
    const [yloS, yhiS] = this._yscale === 'log' ? _logBounds(ylo, yhi) : [ylo, yhi];
    const xScale = new _xScaleCls([xloS, xhiS], [plotX, plotX + plotW]);
    const yScale = new _yScaleCls([yloS, yhiS], [plotY + plotH, plotY]); // y flipped

    // axes background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(plotX, plotY, plotW, plotH);

    // grid
    if (this._grid) {
      ctx.strokeStyle = this._gridOpts.color || '#333';
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = this._gridOpts.alpha || 0.8;
      const xticks = xScale.ticks();
      const yticks = yScale.ticks();
      for (const v of xticks) {
        const px = xScale.transform(v);
        ctx.beginPath(); ctx.moveTo(px, plotY); ctx.lineTo(px, plotY + plotH); ctx.stroke();
      }
      for (const v of yticks) {
        const py = yScale.transform(v);
        ctx.beginPath(); ctx.moveTo(plotX, py); ctx.lineTo(plotX + plotW, py); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // render own traces (clipped to plot area)
    const lastCmapTrace = this._renderTraces(ctx, xScale, yScale, plotX, plotY, plotW, plotH);

    // render twin overlay (own traces + right-side y-axis), if present
    if (this._twin) {
      this._twin._renderAsTwin(ctx, xScale, plotX, plotY, plotW, plotH);
    }

    // axes frame
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotX, plotY, plotW, plotH);

    // ticks and labels
    ctx.fillStyle = textColor;
    ctx.font = smallFont;
    const xTicks = xScale.ticks();
    const yTicks = yScale.ticks();
    const xFmt = xScale.tickFormat();
    const yFmt = yScale.tickFormat();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xTicks) {
      const px = xScale.transform(v);
      ctx.beginPath(); ctx.moveTo(px, plotY + plotH); ctx.lineTo(px, plotY + plotH + 4); ctx.strokeStyle = '#666'; ctx.stroke();
      ctx.fillText(xFmt(v), px, plotY + plotH + 5);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yTicks) {
      const py = yScale.transform(v);
      ctx.beginPath(); ctx.moveTo(plotX - 4, py); ctx.lineTo(plotX, py); ctx.strokeStyle = '#666'; ctx.stroke();
      ctx.fillText(yFmt(v), plotX - 6, py);
    }

    // title
    if (this._title) {
      ctx.fillStyle = textColor;
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this._title.text, plotX + plotW / 2, plotY - 4);
    }

    // xlabel
    if (this._xlabel) {
      ctx.fillStyle = textColor;
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(this._xlabel.text, plotX + plotW / 2, plotY + plotH + 22);
    }

    // ylabel
    if (this._ylabel) {
      ctx.save();
      ctx.fillStyle = textColor;
      ctx.font = font;
      ctx.translate(rect.x + 14, plotY + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this._ylabel.text, 0, 0);
      ctx.restore();
    }

    // legend
    if (this._legend) {
      this._renderLegend(ctx, plotX, plotY, plotW, plotH);
    }

    // colorbar
    if (this._colorbar && lastCmapTrace) {
      const cbX = plotX + plotW + 8;
      const cbW = 12;
      let vmin, vmax, cmap;
      if (lastCmapTrace.type === 'imshow') {
        const d = lastCmapTrace.data;
        const nodata = lastCmapTrace.opts.nodata;
        let vals = nodata != null ? d.filter(v => v !== nodata) : d;
        vmin = lastCmapTrace.opts.vmin != null ? lastCmapTrace.opts.vmin : Math.min(...vals);
        vmax = lastCmapTrace.opts.vmax != null ? lastCmapTrace.opts.vmax : Math.max(...vals);
        cmap = lastCmapTrace.opts.cmap || 'viridis';
      } else {
        const c = lastCmapTrace.opts.c;
        vmin = lastCmapTrace.opts.vmin != null ? lastCmapTrace.opts.vmin : Math.min(...c);
        vmax = lastCmapTrace.opts.vmax != null ? lastCmapTrace.opts.vmax : Math.max(...c);
        cmap = lastCmapTrace.opts.cmap || 'viridis';
      }
      renderColorbar(ctx, cbX, plotY, cbW, plotH, cmap, vmin, vmax, {
        textColor, font: smallFont, label: this._colorbarOpts.label,
      });
    }
  }

  // Render this axes' traces into the given plot rect, clipped. Returns
  // the last trace that contributed a colormap (for colorbar rendering).
  // Extracted from _render so it can be shared with the twin overlay path.
  _renderTraces(ctx, xScale, yScale, plotX, plotY, plotW, plotH) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, plotY, plotW, plotH);
    ctx.clip();
    let lastCmapTrace = null;
    for (const trace of this._traces) {
      switch (trace.type) {
        case 'imshow': this._renderImshow(ctx, trace, xScale, yScale, plotX, plotY, plotW, plotH); lastCmapTrace = trace; break;
        case 'line': this._renderLine(ctx, trace, xScale, yScale); break;
        case 'scatter': this._renderScatter(ctx, trace, xScale, yScale); if (trace.opts.c && Array.isArray(trace.opts.c)) lastCmapTrace = trace; break;
        case 'bar': this._renderBar(ctx, trace, xScale, yScale, plotY + plotH); break;
        case 'barh': this._renderBarh(ctx, trace, xScale, yScale, plotX); break;
        case 'hist': this._renderHist(ctx, trace, xScale, yScale, plotY + plotH); break;
        case 'hline': this._renderHline(ctx, trace, xScale, yScale, plotX, plotW); break;
        case 'vline': this._renderVline(ctx, trace, xScale, yScale, plotY, plotH); break;
        case 'text': this._renderText(ctx, trace, xScale, yScale); break;
      }
    }
    ctx.restore();
    return lastCmapTrace;
  }

  // Render as a twin overlay — shares the parent's xScale, uses own
  // y-scale, draws the y-axis ticks/label on the right edge of the rect.
  // Title/xlabel/legend belong to parent; only y-state matters here.
  _renderAsTwin(ctx, parentXScale, plotX, plotY, plotW, plotH) {
    // Compute own y-scale (matches the path in _render but for the
    // overlay context — no aspect-ratio adjustment, no grid).
    let [ylo, yhi] = this._ylim || this._dataExtent('y');
    if (!isFinite(ylo) || !isFinite(yhi)) return;
    if (ylo === yhi) { ylo -= 0.5; yhi += 0.5; }
    let yloS = ylo, yhiS = yhi;
    if (this._yscale === 'log') {
      if (yloS <= 0) yloS = yhiS > 0 ? yhiS / 1e6 : 1e-9;
      if (yhiS <= yloS) yhiS = yloS * 10;
    }
    const _yScaleCls = this._yscale === 'log' ? LogScale : LinearScale;
    const yScale = new _yScaleCls([yloS, yhiS], [plotY + plotH, plotY]);

    // Render traces with parent's x-scale + own y-scale.
    this._renderTraces(ctx, parentXScale, yScale, plotX, plotY, plotW, plotH);

    // Right-edge y-axis: ticks + tick labels, drawn outside the plot rect.
    ctx.fillStyle = '#ccc';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const yTicks = yScale.ticks();
    const yFmt = yScale.tickFormat();
    for (const v of yTicks) {
      const py = yScale.transform(v);
      ctx.strokeStyle = '#666';
      ctx.beginPath();
      ctx.moveTo(plotX + plotW, py);
      ctx.lineTo(plotX + plotW + 4, py);
      ctx.stroke();
      ctx.fillText(yFmt(v), plotX + plotW + 6, py);
    }

    // Right ylabel — rotated +90° (mirror of left ylabel's -90°)
    // so the text reads bottom-to-top on the right edge.
    if (this._ylabel) {
      ctx.save();
      ctx.fillStyle = '#ccc';
      ctx.font = '11px monospace';
      ctx.translate(plotX + plotW + 38, plotY + plotH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this._ylabel.text, 0, 0);
      ctx.restore();
    }
  }

  _dataExtent(axis) {
    let lo = Infinity, hi = -Infinity;
    for (const trace of this._traces) {
      switch (trace.type) {
        case 'line':
        case 'scatter': {
          const arr = axis === 'x' ? trace.x : trace.y;
          for (let i = 0; i < arr.length; i++) {
            if (arr[i] < lo) lo = arr[i];
            if (arr[i] > hi) hi = arr[i];
          }
          break;
        }
        case 'bar': {
          if (axis === 'x') {
            for (const v of trace.x) { if (v < lo) lo = v; if (v > hi) hi = v; }
          } else {
            lo = Math.min(lo, 0);
            for (const v of trace.heights) { if (v > hi) hi = v; if (v < lo) lo = v; }
          }
          break;
        }
        case 'barh': {
          if (axis === 'y') {
            for (const v of trace.y) { if (v < lo) lo = v; if (v > hi) hi = v; }
          } else {
            lo = Math.min(lo, 0);
            for (const v of trace.widths) { if (v > hi) hi = v; if (v < lo) lo = v; }
          }
          break;
        }
        case 'hist': {
          const { bins: binEdges } = this._computeHistBins(trace);
          if (axis === 'x') {
            lo = Math.min(lo, binEdges[0]);
            hi = Math.max(hi, binEdges[binEdges.length - 1]);
          } else {
            const counts = this._computeHistCounts(trace);
            lo = Math.min(lo, 0);
            for (const c of counts) if (c > hi) hi = c;
          }
          break;
        }
        case 'imshow': {
          if (axis === 'x') { lo = Math.min(lo, 0); hi = Math.max(hi, trace.nx); }
          else {
            lo = Math.min(lo, 0); hi = Math.max(hi, trace.ny);
          }
          break;
        }
        case 'hline': {
          if (axis === 'y') { lo = Math.min(lo, trace.y); hi = Math.max(hi, trace.y); }
          break;
        }
        case 'vline': {
          if (axis === 'x') { lo = Math.min(lo, trace.x); hi = Math.max(hi, trace.x); }
          break;
        }
        case 'text': {
          if (axis === 'x') { lo = Math.min(lo, trace.x); hi = Math.max(hi, trace.x); }
          else { lo = Math.min(lo, trace.y); hi = Math.max(hi, trace.y); }
          break;
        }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    // add padding for non-imshow
    const hasImshow = this._traces.some(t => t.type === 'imshow');
    if (!hasImshow && lo !== hi) {
      const pad = (hi - lo) * 0.05;
      lo -= pad;
      hi += pad;
    }
    return [lo, hi];
  }

  _computeHistBins(trace) {
    const data = trace.data;
    let bins = trace.opts.bins || 10;
    let edges;
    if (Array.isArray(bins)) {
      edges = bins;
    } else {
      const range = trace.opts.range;
      const lo = range ? range[0] : Math.min(...data);
      const hi = range ? range[1] : Math.max(...data);
      const step = (hi - lo) / bins;
      edges = [];
      for (let i = 0; i <= bins; i++) edges.push(lo + i * step);
    }
    return { bins: edges };
  }

  _computeHistCounts(trace) {
    const { bins: edges } = this._computeHistBins(trace);
    const counts = new Array(edges.length - 1).fill(0);
    for (const v of trace.data) {
      for (let i = 0; i < edges.length - 1; i++) {
        if (v >= edges[i] && (i === edges.length - 2 ? v <= edges[i + 1] : v < edges[i + 1])) {
          counts[i]++;
          break;
        }
      }
    }
    return counts;
  }

  // --- trace renderers ---

  _renderLine(ctx, trace, xScale, yScale) {
    const { x, y, opts } = trace;
    if (!x.length) return;
    ctx.strokeStyle = opts.color || '#c89b3c';
    ctx.lineWidth = opts.linewidth || 1.5;
    ctx.setLineDash(dashArray(opts.linestyle));
    ctx.beginPath();
    ctx.moveTo(xScale.transform(x[0]), yScale.transform(y[0]));
    for (let i = 1; i < x.length; i++) {
      ctx.lineTo(xScale.transform(x[i]), yScale.transform(y[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // markers
    if (opts.marker) {
      this._drawMarkers(ctx, x, y, xScale, yScale, opts.marker, opts.color || '#c89b3c', opts.markersize || 4);
    }
  }

  _renderScatter(ctx, trace, xScale, yScale) {
    const { x, y, opts } = trace;
    const cArray = Array.isArray(opts.c);
    const cmapFn = cArray ? getCmap(opts.cmap || 'viridis') : null;
    let cMin, cMax;
    if (cArray) {
      cMin = opts.vmin != null ? opts.vmin : Math.min(...opts.c);
      cMax = opts.vmax != null ? opts.vmax : Math.max(...opts.c);
    }
    const sArray = Array.isArray(opts.s);
    const defaultSize = typeof opts.s === 'number' ? opts.s : 4;
    const alpha = opts.alpha != null ? opts.alpha : 1;

    for (let i = 0; i < x.length; i++) {
      const px = xScale.transform(x[i]);
      const py = yScale.transform(y[i]);
      const r = sArray ? Math.sqrt(opts.s[i]) : Math.sqrt(defaultSize);
      ctx.globalAlpha = alpha;
      if (cArray) {
        const t = cMax !== cMin ? (opts.c[i] - cMin) / (cMax - cMin) : 0.5;
        ctx.fillStyle = cmapFn(t);
      } else {
        ctx.fillStyle = opts.c || opts.color || '#c89b3c';
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      if (opts.edgecolor) {
        ctx.strokeStyle = opts.edgecolor;
        ctx.lineWidth = opts.linewidth || 0.5;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderBar(ctx, trace, xScale, yScale, baseline) {
    const { x, heights, opts } = trace;
    const barW = opts.width || 0.8;
    ctx.fillStyle = opts.color || '#c89b3c';
    const alpha = opts.alpha != null ? opts.alpha : 1;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < x.length; i++) {
      const px = xScale.transform(x[i] - barW / 2);
      const pw = xScale.transform(x[i] + barW / 2) - px;
      const py = yScale.transform(heights[i]);
      const py0 = yScale.transform(0);
      ctx.fillRect(px, py, pw, py0 - py);
      if (opts.edgecolor) {
        ctx.strokeStyle = opts.edgecolor;
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, pw, py0 - py);
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderBarh(ctx, trace, xScale, yScale, left) {
    const { y, widths, opts } = trace;
    const barH = opts.height || 0.8;
    ctx.fillStyle = opts.color || '#c89b3c';
    const alpha = opts.alpha != null ? opts.alpha : 1;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < y.length; i++) {
      const py = yScale.transform(y[i] + barH / 2);
      const ph = yScale.transform(y[i] - barH / 2) - py;
      const px0 = xScale.transform(0);
      const px = xScale.transform(widths[i]);
      ctx.fillRect(px0, py, px - px0, ph);
      if (opts.edgecolor) {
        ctx.strokeStyle = opts.edgecolor;
        ctx.lineWidth = 1;
        ctx.strokeRect(px0, py, px - px0, ph);
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderHist(ctx, trace, xScale, yScale, baseline) {
    const { bins: edges } = this._computeHistBins(trace);
    const counts = this._computeHistCounts(trace);
    const alpha = trace.opts.alpha != null ? trace.opts.alpha : 0.8;
    ctx.fillStyle = trace.opts.color || '#c89b3c';
    ctx.globalAlpha = alpha;
    for (let i = 0; i < counts.length; i++) {
      const px0 = xScale.transform(edges[i]);
      const px1 = xScale.transform(edges[i + 1]);
      const py = yScale.transform(counts[i]);
      const py0 = yScale.transform(0);
      ctx.fillRect(px0, py, px1 - px0, py0 - py);
      if (trace.opts.edgecolor) {
        ctx.strokeStyle = trace.opts.edgecolor;
        ctx.lineWidth = 1;
        ctx.strokeRect(px0, py, px1 - px0, py0 - py);
      }
    }
    ctx.globalAlpha = 1;
  }

  _renderImshow(ctx, trace, xScale, yScale, plotX, plotY, plotW, plotH) {
    const { data, nx, ny, opts } = trace;
    const nodata = opts.nodata;
    const origin = opts.origin || 'lower';
    const cmapFn = getCmap(opts.cmap || 'viridis');

    // compute vmin/vmax
    let vmin = opts.vmin, vmax = opts.vmax;
    if (vmin == null || vmax == null) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < data.length; i++) {
        if (nodata != null && data[i] === nodata) continue;
        if (data[i] < lo) lo = data[i];
        if (data[i] > hi) hi = data[i];
      }
      if (vmin == null) vmin = lo;
      if (vmax == null) vmax = hi;
    }
    const vr = vmax - vmin || 1;

    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iy * nx + ix;
        const v = data[idx];
        if (nodata != null && v === nodata) continue;
        // data y: origin='lower' → row 0 at y=0 (bottom), origin='upper' → row 0 at y=ny (top)
        const dataY = origin === 'lower' ? iy : (ny - 1 - iy);
        const px0 = xScale.transform(ix);
        const px1 = xScale.transform(ix + 1);
        const pyTop = yScale.transform(dataY + 1); // higher y → smaller pixel (top)
        const pyBot = yScale.transform(dataY);      // lower y → larger pixel (bottom)
        ctx.fillStyle = cmapFn((v - vmin) / vr);
        ctx.fillRect(px0, pyTop, px1 - px0 + 0.5, pyBot - pyTop + 0.5);
      }
    }
  }

  _renderHline(ctx, trace, xScale, yScale, plotX, plotW) {
    const py = yScale.transform(trace.y);
    ctx.strokeStyle = trace.opts.color;
    ctx.lineWidth = trace.opts.linewidth || 1;
    ctx.setLineDash(dashArray(trace.opts.linestyle));
    ctx.beginPath(); ctx.moveTo(plotX, py); ctx.lineTo(plotX + plotW, py); ctx.stroke();
    ctx.setLineDash([]);
  }

  _renderVline(ctx, trace, xScale, yScale, plotY, plotH) {
    const px = xScale.transform(trace.x);
    ctx.strokeStyle = trace.opts.color;
    ctx.lineWidth = trace.opts.linewidth || 1;
    ctx.setLineDash(dashArray(trace.opts.linestyle));
    ctx.beginPath(); ctx.moveTo(px, plotY); ctx.lineTo(px, plotY + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }

  _renderText(ctx, trace, xScale, yScale) {
    const px = xScale.transform(trace.x);
    const py = yScale.transform(trace.y);
    ctx.fillStyle = trace.opts.color;
    ctx.font = `${trace.opts.fontsize || 11}px monospace`;
    ctx.textAlign = trace.opts.ha || 'left';
    ctx.textBaseline = trace.opts.va || 'bottom';
    ctx.fillText(trace.text, px, py);
  }

  _renderLegend(ctx, plotX, plotY, plotW, plotH) {
    const entries = [];
    for (const t of this._traces) {
      if (t.opts.label) entries.push({ label: t.opts.label, color: t.opts.color || '#c89b3c', type: t.type });
    }
    if (!entries.length) return;

    ctx.font = '10px monospace';
    const lineH = 14;
    const padding = 6;
    let maxW = 0;
    for (const e of entries) {
      const w = ctx.measureText(e.label).width;
      if (w > maxW) maxW = w;
    }
    const boxW = maxW + 24 + padding * 2;
    const boxH = entries.length * lineH + padding * 2;

    // position: default top-right
    const loc = this._legendOpts.loc || 'upper right';
    let lx, ly;
    if (loc.includes('right')) lx = plotX + plotW - boxW - 6;
    else if (loc.includes('left')) lx = plotX + 6;
    else lx = plotX + (plotW - boxW) / 2;
    if (loc.includes('upper') || loc.includes('top')) ly = plotY + 6;
    else if (loc.includes('lower') || loc.includes('bottom')) ly = plotY + plotH - boxH - 6;
    else ly = plotY + (plotH - boxH) / 2;

    ctx.fillStyle = 'rgba(30,30,30,0.85)';
    ctx.fillRect(lx, ly, boxW, boxH);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(lx, ly, boxW, boxH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < entries.length; i++) {
      const ey = ly + padding + i * lineH + lineH / 2;
      ctx.fillStyle = entries[i].color;
      if (entries[i].type === 'scatter') {
        ctx.beginPath(); ctx.arc(lx + padding + 6, ey, 3, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(lx + padding, ey - 1, 14, 2);
      }
      ctx.fillStyle = '#ccc';
      ctx.fillText(entries[i].label, lx + padding + 18, ey);
    }
  }

  _drawMarkers(ctx, x, y, xScale, yScale, marker, color, size) {
    ctx.fillStyle = color;
    const r = size / 2;
    for (let i = 0; i < x.length; i++) {
      const px = xScale.transform(x[i]);
      const py = yScale.transform(y[i]);
      switch (marker) {
        case 'o': case '.':
          ctx.beginPath(); ctx.arc(px, py, marker === '.' ? 1.5 : r, 0, Math.PI * 2); ctx.fill(); break;
        case 's':
          ctx.fillRect(px - r, py - r, size, size); break;
        case '^':
          ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px - r, py + r); ctx.lineTo(px + r, py + r); ctx.closePath(); ctx.fill(); break;
        case 'v':
          ctx.beginPath(); ctx.moveTo(px, py + r); ctx.lineTo(px - r, py - r); ctx.lineTo(px + r, py - r); ctx.closePath(); ctx.fill(); break;
        case 'd':
          ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath(); ctx.fill(); break;
        case '+':
          ctx.strokeStyle = color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px - r, py); ctx.lineTo(px + r, py); ctx.moveTo(px, py - r); ctx.lineTo(px, py + r); ctx.stroke(); break;
        case 'x':
          ctx.strokeStyle = color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r); ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r); ctx.stroke(); break;
        default:
          ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

// -- figure.js --

// Figure — canvas management, subplot grid, DPI handling


class Figure {
  constructor(nrows, ncols, opts) {
    this.nrows = nrows || 1;
    this.ncols = ncols || 1;
    const o = opts || {};
    const figsize = o.figsize || [400, 300];
    this.width = figsize[0];
    this.height = figsize[1];
    this.facecolor = o.facecolor || 'transparent';
    this._suptitle = null;

    // create axes grid
    this.axes = [];
    for (let i = 0; i < this.nrows * this.ncols; i++) {
      this.axes.push(new Axes());
    }
  }

  suptitle(text, opts) {
    this._suptitle = { text, opts };
    return this;
  }

  show() {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const canvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!canvas) return null;

    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    canvas.style.width = this.width + 'px';
    canvas.style.height = this.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // background
    if (this.facecolor !== 'transparent') {
      ctx.fillStyle = this.facecolor;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // suptitle space
    const supH = this._suptitle ? 24 : 0;

    if (this._suptitle) {
      ctx.fillStyle = '#ccc';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(this._suptitle.text, this.width / 2, 4);
    }

    // subplot layout
    const gapX = 10;
    const gapY = 10;
    const cellW = (this.width - gapX * (this.ncols - 1)) / this.ncols;
    const cellH = (this.height - supH - gapY * (this.nrows - 1)) / this.nrows;

    for (let r = 0; r < this.nrows; r++) {
      for (let c = 0; c < this.ncols; c++) {
        const idx = r * this.ncols + c;
        const ax = this.axes[idx];
        const rect = {
          x: c * (cellW + gapX),
          y: supH + r * (cellH + gapY),
          w: cellW,
          h: cellH,
        };
        ax._render(ctx, rect);
      }
    }

    return canvas;
  }

  savefig(filename) {
    const canvas = this.show();
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = filename || 'figure.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }
}

// -- api.js --

// Public API — subplots() factory, quick one-liners, plt extension registration



// matplotlib stateful interface — plt.xlabel/.ylim/.legend/etc. all
// operate on a global "current axes". subplots() and the _quick()
// wrappers update it. Cells running in sequence share the same
// _currentAx so a stateful sequence like
//   plt.hist(...)        # creates an axes, becomes current
//   plt.xlabel('x')      # sets xlabel on that axes
//   plt.vlines(...)      # adds vertical lines to that axes
// works the same as matplotlib.
let _currentFig = null;
let _currentAx = null;

function _setCurrent(fig, ax) { _currentFig = fig; _currentAx = ax; return ax; }

function subplots(nrows, ncols, opts) {
  const nr = nrows || 1;
  const nc = ncols || 1;
  const fig = new Figure(nr, nc, opts);

  if (nr === 1 && nc === 1) {
    _setCurrent(fig, fig.axes[0]);
    // array for adder tuple unpacking, named props for JS destructuring
    return Object.assign([fig, fig.axes[0]], { fig, ax: fig.axes[0] });
  }
  _setCurrent(fig, fig.axes[0]);
  return Object.assign([fig, fig.axes], { fig, axes: fig.axes });
}

// quick one-liners — create figure, add trace, return canvas
function _quick(fn) {
  return function (...args) {
    const { fig, ax } = subplots();
    fn(ax, ...args);
    _setCurrent(fig, ax);
    return fig.show();
  };
}

const plot = _quick((ax, x, y, fmtOrOpts, opts) => ax.plot(x, y, fmtOrOpts, opts));
const scatter = _quick((ax, x, y, opts) => ax.scatter(x, y, opts));
const imshow = _quick((ax, data, nx, ny, opts) => ax.imshow(data, nx, ny, opts));
const bar = _quick((ax, x, heights, opts) => ax.bar(x, heights, opts));
const cmap = getCmap;

// plt.hist — matplotlib returns (counts, edges, patches). Adder cells
// destructure as `n, bins, patches = plt.hist(...)` or index as
// `result = plt.hist(...); n = result[0]`. We return an array-like
// with both index access and named getters (.counts/.edges/.canvas)
// so JS-side use is also ergonomic.
function hist(data, opts) {
  const { fig, ax } = subplots();
  ax.hist(data, opts);
  // Compute the actual counts + edges that the trace will render with,
  // so the caller sees real values matching the drawn bars.
  const trace = ax._traces[ax._traces.length - 1];
  const { bins: edges } = ax._computeHistBins(trace);
  const counts = ax._computeHistCounts(trace);
  const canvas = fig.show();
  return Object.assign([counts, edges, canvas], {
    counts, edges, canvas,
  });
}

// matplotlib parity stubs — these are no-ops today but nearly every
// Jupyter notebook calls them at the top of cell 1 to configure global
// style. Stubbing keeps the import path running so notebooks proceed
// to the real plotting calls; actual rcParams threading through Figure
// construction is on the ROADMAP.
//
// plt.rc(group, **kwargs) — `plt.rc('font', size=14)`
function rc(_group, _opts) { /* no-op */ }
// plt.rcParams — dict-like assignable bag. `plt.rcParams['figure.figsize'] = (8, 6)`
const rcParams = {};
rcParams.update = function (obj) {
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) rcParams[k] = obj[k];
};
// plt.style.use(name) — no-op
const style = { use(_name) { /* no-op */ }, available: [] };
// plt.figure(...) — return a fresh Figure (matplotlib's figure() takes
// figsize=(w,h) and other kwargs; we accept and ignore unsupported ones).
function figure(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  return new Figure(1, 1, o);
}
// plt.show() — renders the current figure to a canvas and returns it.
// When `plt.show()` is the last expression of an adder cell, adder's
// display path picks up the canvas (via nodeType check) and renders.
// Matplotlib's pyplot also renders implicitly after each cell in
// %matplotlib inline; for now we require an explicit `plt.show()` as
// the trailing statement.
function show() {
  if (!_currentFig) return null;
  return _currentFig.show();
}
// plt.close(fig?) — close a figure (matplotlib reclaims its handle).
// We hold no figure registry, so no-op.
function close(_fig) { /* no-op */ }

// plt.subplot(nrows, ncols, index) — matplotlib's per-axes shortcut.
// Also accepts the 3-digit form `plt.subplot(311)` (sugar for 3,1,1).
// Returns the indexed axes and sets it as current. Distinct from
// `subplots(nrows, ncols)` which returns the full grid.
function subplot(...args) {
  let nrows, ncols, index;
  if (args.length === 1 && typeof args[0] === 'number' && args[0] >= 111 && args[0] < 1000) {
    const n = args[0];
    nrows = Math.floor(n / 100);
    ncols = Math.floor((n / 10) % 10);
    index = n % 10;
  } else {
    nrows = args[0] || 1;
    ncols = args[1] || 1;
    index = args[2] || 1;
  }
  const sub = subplots(nrows, ncols);
  const ax = (sub.axes && sub.axes.length) ? sub.axes[index - 1] : sub.ax;
  _setCurrent(sub.fig, ax);
  return ax;
}

// plt.cm — matplotlib's colormap namespace. Each public name is a
// colormap function `(t in [0,1]) → 'rgb(r,g,b)'`. Notebooks reference
// these as `cmap = plt.cm.viridis`. We mirror the names we have in
// getCmap; unknown / dunder access returns undefined so adder's
// attribute probing (__adderClass__, __iter__, etc.) doesn't get
// fooled into thinking every name is a cmap.
const _CMAP_NAMES = ['viridis', 'coolwarm', 'turbo'];
const cm = {};
for (const n of _CMAP_NAMES) {
  Object.defineProperty(cm, n, {
    get() { return getCmap(n); },
    enumerable: true,
  });
}
cm.get_cmap = getCmap;

// matplotlib stateful interface — module-level helpers that delegate to
// the current axes. Each lazily creates an axes if none exists yet, so
// `plt.title("x")` as the very first call still works (matches mpl).
function _ax() {
  if (!_currentAx) subplots();
  return _currentAx;
}
function gca() { return _ax(); }
function gcf() { if (!_currentFig) subplots(); return _currentFig; }
function xlabel(text, opts) { _ax().set_xlabel(text, opts); }
function ylabel(text, opts) { _ax().set_ylabel(text, opts); }
function title(text, opts) { _ax().set_title(text, opts); }
function xlim(lo, hi) { _ax().set_xlim(lo, hi); }
function ylim(lo, hi) { _ax().set_ylim(lo, hi); }
function xscale(scale) { _ax().set_xscale(scale); }
function yscale(scale) { _ax().set_yscale(scale); }
function legend(opts) { _ax().legend(opts); }
function grid(on, opts) { _ax().grid(on, opts); }
function vlines(x, ymin, ymax, opts) { _ax().vlines(x, ymin, ymax, opts); }
function hlines(y, xmin, xmax, opts) { _ax().hlines(y, xmin, xmax, opts); }
function axhline(y, opts) { _ax().axhline(y, opts); }
function axvline(x, opts) { _ax().axvline(x, opts); }
function text(x, y, s, opts) { _ax().text(x, y, s, opts); }
// matplotlib subplots_adjust controls figure margins (left/right/top/bottom/wspace/hspace).
// Canvas layout isn't margin-driven the same way; accept and discard.
function subplots_adjust(_opts) { /* no-op */ }
function tight_layout(_opts) { /* no-op */ }
function savefig(filename) { return _currentFig && _currentFig.savefig(filename); }
function clf() { _currentFig = null; _currentAx = null; }
function cla() { _currentAx = null; }

// register as auditable extension for adder `import plt`
if (typeof window !== 'undefined') {
  const _plt = {
    subplots, subplot, figure, Figure, cmap, cm, plot, scatter, imshow, hist, bar,
    rc, rcParams, style, show, close,
    gca, gcf, xlabel, ylabel, title, xlim, ylim, xscale, yscale,
    legend, grid, vlines, hlines, axhline, axvline, text,
    subplots_adjust, tight_layout, savefig, clf, cla,
  };
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/plot',
      version: '0.1.0',
      description: 'Canvas 2D plotting library \u2014 line, scatter, bar, hist, imshow',
      pluginUrl: '@gcu/plot',
      exports: { plt: _plt },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['plt'] = _plt;
    if (window._auditablePlugins) {
      window._auditablePlugins.set('@gcu/plot', { description: 'Canvas 2D plotting library \u2014 line, scatter, bar, hist, imshow' });
    }
  }
}

export { subplots, plot, scatter, imshow, hist, bar, cmap, Figure, Axes, LinearScale, getCmap };
