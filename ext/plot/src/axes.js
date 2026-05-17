// Axes — trace storage, layout computation, canvas rendering

import { LinearScale, LogScale } from './scale.js';
import { getCmap, renderColorbar } from './color.js';
import { parseFormat, dashArray } from './format.js';

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

export class Axes {
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

  // matshow == imshow for a 2D matrix. matplotlib's Axes.matshow has
  // a few extras (auto-aspect, no x-axis-on-bottom) but the common case
  // — `ax.matshow(corr_matrix)` — works identically.
  matshow(data, opts) { return this.imshow(data, undefined, undefined, opts); }

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
