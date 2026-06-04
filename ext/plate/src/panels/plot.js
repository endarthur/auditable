// @gcu/plate — the plot panel kind: a self-contained interactive canvas scatter.
//
// Why bespoke rather than over @gcu/plot: a scatter that participates in the
// selection contract must own its data→pixel transform — brushing, hit-testing
// and highlight-tinting all need it, and @gcu/plot keeps that transform private
// inside its render pass. So this panel owns a small explicit transform and
// draws the points itself (~one screenful of code). @gcu/plot delegation for
// the static chrome (log scales, legends, dense ticks) is a later growth path;
// what's load-bearing for v0.1 is interaction, and that lives here.
//
// Identity: a point's KEY is data.keys[i] (the dataset's row identity — the
// strata base ordinal when bound to a .strata, so plate↔strata brushing shares
// an identity space for free). A brush emits a kind:"rows" descriptor of keys;
// an incoming selection arrives as a key set and tints the matching points.

import { registerPanelKind } from '../registry.js';

// GCU accents (hard role mapping): info=teal for the data, selected=indigo for
// an incoming linked selection, action=amber for the local brush.
const COL = {
  point:     '#5aa0a0',  // teal — the data
  pointDim:  'rgba(90,160,160,0.22)',
  highlight: '#8a7dff',  // indigo — incoming selection (matches strata's tint)
  local:     '#c89b3c',  // amber  — the local brush
  axis:      '#3a3a3a',
  grid:      '#262626',
  text:      '#888',
  bg:        '#161616',
};

const M = { left: 52, right: 16, top: 16, bottom: 38 };  // plot margins (px)

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// A "nice" extent with a little padding; collapses a zero-width range.
function niceExtent(vals) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (lo === Infinity) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

// Round a tick value for display without trailing float noise.
function fmtTick(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
  const s = (Math.round(v * 1000) / 1000).toString();
  return s;
}

// ~5 evenly spaced ticks across [lo,hi].
function ticks(lo, hi, n = 5) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(lo + (hi - lo) * (i / n));
  return out;
}

function mountScatter(el, spec0, data0, ctx) {
  let spec = spec0 || {};
  let data = data0 || { columns: {}, keys: [] };
  let highlight = null;        // Set<key> — incoming linked selection
  let local = null;            // Set<key> — the last local brush

  el.innerHTML = '';
  el.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair';
  el.appendChild(canvas);
  const cctx = canvas.getContext('2d');

  // Live layout state (recomputed each paint): CSS px size + the transform.
  let W = 0, H = 0, tx = null;

  function buildTransform() {
    const xs = data.columns[spec.x] || [];
    const ys = data.columns[spec.y] || [];
    const [xlo, xhi] = niceExtent(xs);
    const [ylo, yhi] = niceExtent(ys);
    const px = M.left, py = M.top;
    const pw = Math.max(1, W - M.left - M.right);
    const ph = Math.max(1, H - M.top - M.bottom);
    tx = {
      xlo, xhi, ylo, yhi, px, py, pw, ph,
      X: (v) => px + ((v - xlo) / (xhi - xlo)) * pw,
      Y: (v) => py + (1 - (v - ylo) / (yhi - ylo)) * ph,
    };
  }

  function resize() {
    const r = el.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function paint() {
    buildTransform();
    const { px, py, pw, ph } = tx;
    cctx.clearRect(0, 0, W, H);
    cctx.fillStyle = COL.bg;
    cctx.fillRect(0, 0, W, H);

    // grid + ticks
    cctx.font = '10px monospace';
    cctx.fillStyle = COL.text;
    cctx.strokeStyle = COL.grid;
    cctx.lineWidth = 1;
    cctx.textAlign = 'center'; cctx.textBaseline = 'top';
    for (const t of ticks(tx.xlo, tx.xhi)) {
      const X = tx.X(t);
      cctx.beginPath(); cctx.moveTo(X, py); cctx.lineTo(X, py + ph); cctx.stroke();
      cctx.fillText(fmtTick(t), X, py + ph + 6);
    }
    cctx.textAlign = 'right'; cctx.textBaseline = 'middle';
    for (const t of ticks(tx.ylo, tx.yhi)) {
      const Y = tx.Y(t);
      cctx.beginPath(); cctx.moveTo(px, Y); cctx.lineTo(px + pw, Y); cctx.stroke();
      cctx.fillText(fmtTick(t), px - 6, Y);
    }

    // frame
    cctx.strokeStyle = COL.axis;
    cctx.strokeRect(px, py, pw, ph);

    // axis labels
    cctx.fillStyle = COL.text;
    cctx.textAlign = 'center'; cctx.textBaseline = 'bottom';
    cctx.fillText(spec.x || '', px + pw / 2, H - 4);
    cctx.save();
    cctx.translate(12, py + ph / 2); cctx.rotate(-Math.PI / 2);
    cctx.textBaseline = 'top'; cctx.fillText(spec.y || '', 0, 0);
    cctx.restore();

    // points — dim the field when an incoming highlight is active so the
    // selected ones pop; draw highlighted + locally-brushed on top.
    const xs = data.columns[spec.x] || [];
    const ys = data.columns[spec.y] || [];
    const keys = data.keys || [];
    const dimField = !!(highlight && highlight.size);
    const top = [];   // [x, y, color, ring] drawn last
    for (let i = 0; i < keys.length; i++) {
      const xv = xs[i], yv = ys[i];
      if (!isNum(xv) || !isNum(yv)) continue;
      const X = tx.X(xv), Y = tx.Y(yv);
      const k = keys[i];
      const hot = highlight && highlight.has(k);
      const loc = local && local.has(k);
      if (hot || loc) { top.push([X, Y, hot ? COL.highlight : COL.point, loc]); continue; }
      cctx.fillStyle = dimField ? COL.pointDim : COL.point;
      cctx.beginPath(); cctx.arc(X, Y, 3, 0, Math.PI * 2); cctx.fill();
    }
    for (const [X, Y, color, ring] of top) {
      cctx.fillStyle = color;
      cctx.beginPath(); cctx.arc(X, Y, 3.5, 0, Math.PI * 2); cctx.fill();
      if (ring) { cctx.strokeStyle = COL.local; cctx.lineWidth = 1.5;
        cctx.beginPath(); cctx.arc(X, Y, 5.5, 0, Math.PI * 2); cctx.stroke(); }
    }

    // live brush rect
    if (brush) {
      const { x0, y0, x1, y1 } = brush;
      cctx.fillStyle = 'rgba(200,155,60,0.12)';
      cctx.strokeStyle = COL.local; cctx.lineWidth = 1;
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      cctx.fillRect(rx, ry, rw, rh); cctx.strokeRect(rx, ry, rw, rh);
    }
  }

  // ── brushing ──
  let brush = null;
  function localXY(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function onDown(ev) {
    if (ev.button !== 0) return;
    const p = localXY(ev);
    brush = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* synthetic pointer */ }
  }
  function onMove(ev) {
    if (!brush) return;
    const p = localXY(ev);
    brush.x1 = p.x; brush.y1 = p.y; paint();
  }
  function onUp() {
    if (!brush) return;
    const b = brush; brush = null;
    const rx = Math.min(b.x0, b.x1), ry = Math.min(b.y0, b.y1);
    const rw = Math.abs(b.x1 - b.x0), rh = Math.abs(b.y1 - b.y0);
    if (rw < 3 && rh < 3) {           // a click, not a drag → clear
      local = null; paint();
      ctx && ctx.onSelect && ctx.onSelect({ kind: 'none', key: '#row' });
      return;
    }
    const xs = data.columns[spec.x] || [];
    const ys = data.columns[spec.y] || [];
    const keys = data.keys || [];
    const picked = [];
    const sel = new Set();
    for (let i = 0; i < keys.length; i++) {
      const xv = xs[i], yv = ys[i];
      if (!isNum(xv) || !isNum(yv)) continue;
      const X = tx.X(xv), Y = tx.Y(yv);
      if (X >= rx && X <= rx + rw && Y >= ry && Y <= ry + rh) { picked.push(keys[i]); sel.add(keys[i]); }
    }
    local = sel; paint();
    ctx && ctx.onSelect && ctx.onSelect(
      picked.length
        ? { kind: 'rows', key: '#row', rows: picked, cols: [spec.x, spec.y] }
        : { kind: 'none', key: '#row' });
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);

  // ResizeObserver keeps the canvas crisp as the frame changes.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(el);
  }
  resize();

  return {
    update(nextSpec) { spec = { ...spec, ...nextSpec }; paint(); },
    setData(nextData) { data = nextData || { columns: {}, keys: [] }; local = null; paint(); },
    setHighlight(keySet) { highlight = keySet || null; paint(); },
    getHighlight() { return highlight ? [...highlight] : null; },   // smoke/debug
    getSpec() { return { ...spec }; },
    destroy() {
      if (ro) ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      el.innerHTML = '';
    },
  };
}

export const plotPanel = {
  kind: 'plot',
  // A sane starting panel: scatter the first two numeric columns.
  defaultSpec(data) {
    const nums = (data && data.numericColumns) || [];
    return { x: nums[0] || null, y: nums[1] || nums[0] || null };
  },
  render(el, spec, data, ctx) { return mountScatter(el, spec, data, ctx); },
};

registerPanelKind('plot', plotPanel);
