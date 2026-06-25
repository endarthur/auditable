// @gcu/loom — render: the canvas paint core (browser-only).
//
// Extracted in spirit from tools/calque/js/grid.js's paint loop, with two
// reseams (strata-spec §11):
//   • read = provider.cellAt(r,c) (was: a prebuilt G.cells Map). The loop shape
//     is unchanged — it already only touched visible cells — so the only delta
//     is the per-cell read and a PENDING branch (upgrade #1, async-shaped).
//   • the rich cell model {value,state,type,style} drives drawing (upgrade #2):
//     type → alignment/colour, state → provenance treatment. Calque drew a bare
//     {text,header,numeric}; loom's states are additive draw branches.
// Headers are their own bands (provider.header / rowHeader), not inlined into
// the body as calque does — the body holds data rows only.
//
// All functions take the instance `g`; no module globals → grids coexist.

import { PENDING, CellState, CellType, colLetter, fmtVal } from './model.js';
import { colW, colXAt, visibleColRange, visibleRowRange } from './geometry.js';

const PAD = 6;

// A muted one-glyph type indicator drawn before each header label — type is what
// a structured table is *about*, so it's visible at a glance. Keyed by the
// CellType string values the provider reports.
const TYPE_GLYPH = { number: '#', string: 'a', category: '≡', date: '◷', bool: '✓' };

// Default GCU-dark-ish palette. options.colors overrides any key. Kept inside
// loom so the lib renders standalone without auditable's CSS tokens; a surface
// can pass --au-* values through options.colors.
export const DARK_COLORS = {
  gridLine: '#1e1e1e', hdrBg: '#1a1a1a', hdrBorder: '#2a2a2a', hdrText: '#888',
  cellText: '#bbb', cellNum: '#8cb878', cellDerived: '#c89b3c', cellError: '#d46a6a',
  cellPending: '#555', cellOutOfOrder: '#c8a13c', hdrGlyph: '#6f6f6f',
  editedBar: '#c89b3c', selFill: 'rgba(200,155,60,0.12)', selStroke: '#c89b3c',
  highlightFill: 'rgba(120,130,225,0.22)',   // cross-surface brushing tint (indigo)
  invalidFill: 'rgba(212,106,106,0.20)',     // validation-failure tint (caution red)
  bg: '#121212', scrollThumb: '#3a3a3a', scrollTrack: '#161616',
};

export const LIGHT_COLORS = {
  gridLine: '#ddd', hdrBg: '#e8e8e8', hdrBorder: '#ccc', hdrText: '#888',
  cellText: '#333', cellNum: '#3a7a30', cellDerived: '#8a6c2a', cellError: '#b03030',
  cellPending: '#bbb', cellOutOfOrder: '#9a7a1a', hdrGlyph: '#aaa',
  editedBar: '#8a6c2a', selFill: 'rgba(138,108,42,0.12)', selStroke: '#8a6c2a',
  highlightFill: 'rgba(90,100,190,0.16)',   // cross-surface brushing tint (indigo)
  invalidFill: 'rgba(176,48,48,0.13)',      // validation-failure tint (caution red)
  bg: '#fff', scrollThumb: '#c4c4c4', scrollTrack: '#ececec',
};

// Display text for a cell: explicit style.text wins, else format the value.
function cellText(cell) {
  if (cell.style && typeof cell.style.text === 'string') return cell.style.text;
  if (cell.state === CellState.PENDING) return '…';
  return fmtVal(cell.value);
}

// Draw one data cell into the body context at (x,y) within w×h.
function drawCell(ctx, cell, x, y, w, h, g) {
  const c = g.colors;
  const isNum = cell.type === CellType.NUMBER;
  const pending = cell === PENDING || cell.state === CellState.PENDING;

  // Brushing/linking highlight — a soft fill behind the cell. A row of these =
  // a tinted row: the visible response to an incoming selection from another
  // surface (strata-spec §7; distinct colour from the local amber selection).
  if (cell.style && cell.style.highlight) {
    ctx.fillStyle = c.highlightFill;
    ctx.fillRect(x + 1, y, w - 1, h);
  }
  // Validation-failure wash (a check that must hold failed on this cell).
  if (cell.style && cell.style.invalid) {
    ctx.fillStyle = c.invalidFill;
    ctx.fillRect(x + 1, y, w - 1, h);
  }

  // Edited rows get a thin accent bar on the left edge (dirty marker).
  if (!pending && cell.state === CellState.EDITED) {
    ctx.fillStyle = c.editedBar;
    ctx.fillRect(x + 1, y + 1, 2, h - 1);
  }

  // Text colour by state, then type.
  let fill = c.cellText;
  let italic = false;
  if (pending) fill = c.cellPending;
  else if (cell.state === CellState.ERROR) fill = c.cellError;
  else if (cell.state === CellState.DERIVED) { fill = c.cellDerived; italic = true; }
  else if (cell.state === CellState.OUT_OF_ORDER) fill = c.cellOutOfOrder;
  else if (isNum) fill = c.cellNum;

  ctx.font = (italic ? 'italic ' : '') + g.fontPx + 'px ' + g.mono;
  ctx.fillStyle = fill;
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y, w - 2, h);
  ctx.clip();
  const text = pending ? '…' : cellText(cell);
  if (isNum && !pending) {
    ctx.textAlign = 'right';
    ctx.fillText(text, x + w - PAD, y + h / 2);
  } else {
    ctx.textAlign = 'left';
    ctx.fillText(text, x + PAD, y + h / 2);
  }
  ctx.restore();

  // Out-of-order rows: a small caution dot top-right (§4.3 — edited a sort key).
  if (!pending && cell.state === CellState.OUT_OF_ORDER) {
    ctx.fillStyle = c.cellOutOfOrder;
    ctx.beginPath();
    ctx.arc(x + w - 4, y + 4, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Paint the visible body cells + grid lines + selection.
export function paintCells(g, c0, r0, c1, r1, sx, sy, vw, vh) {
  const { ctx, dpr, metrics, provider } = g;
  const rowH = metrics.rowH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  ctx.fillStyle = g.colors.bg;
  ctx.fillRect(0, 0, vw, vh);

  // Grid lines.
  ctx.strokeStyle = g.colors.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(colXAt(metrics, c) - sx) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, vh);
  }
  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(r * rowH - sy) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(vw, y);
  }
  ctx.stroke();

  // Cells.
  for (let r = r0; r <= r1; r++) {
    const y = r * rowH - sy;
    for (let c = c0; c <= c1; c++) {
      const cell = provider.cellAt(r, c);
      if (cell == null) continue;            // empty cell — leave blank
      const x = colXAt(metrics, c) - sx;
      drawCell(ctx, cell, x, y, colW(metrics, c), rowH, g);
    }
  }

  // Selection overlay.
  const sel = g.sel;
  if (sel) {
    const ns = {
      r0: Math.min(sel.r0, sel.r1), c0: Math.min(sel.c0, sel.c1),
      r1: Math.max(sel.r0, sel.r1), c1: Math.max(sel.c0, sel.c1),
    };
    const x0 = colXAt(metrics, ns.c0) - sx;
    const y0 = ns.r0 * rowH - sy;
    const x1 = colXAt(metrics, ns.c1 + 1) - sx;
    const y1 = (ns.r1 + 1) * rowH - sy;
    ctx.fillStyle = g.colors.selFill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = g.colors.selStroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }
}

// Column header band: the column *name* (provider.header), not a letter.
export function paintColHeaders(g, c0, c1, sx, vw) {
  const { colHdrCtx: ctx, dpr, metrics, provider } = g;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, metrics.hdrH);
  ctx.fillStyle = g.colors.hdrBg;
  ctx.fillRect(0, 0, vw, metrics.hdrH);

  ctx.strokeStyle = g.colors.hdrBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = c0; c <= c1 + 1; c++) {
    const x = Math.round(colXAt(metrics, c) - sx) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, metrics.hdrH);
  }
  ctx.moveTo(0, metrics.hdrH - 0.5); ctx.lineTo(vw, metrics.hdrH - 0.5);
  ctx.stroke();

  ctx.font = '600 ' + g.hdrFontPx + 'px ' + g.mono;
  ctx.fillStyle = g.colors.hdrText;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let c = c0; c <= c1; c++) {
    const h = provider.header ? provider.header(c) : null;
    const label = h == null ? colLetter(c) : (typeof h === 'string' ? h : (h.label ?? colLetter(c)));
    const cw = colW(metrics, c);
    const x = colXAt(metrics, c) - sx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, 0, cw - 2, metrics.hdrH);
    ctx.clip();
    ctx.textAlign = 'left';
    // Type glyph (muted), then the label. A calculated/derived column shows an ƒ
    // in the derived accent instead of its type glyph, so it's visibly not a
    // source column.
    const calc = h && typeof h === 'object' && h.calc;
    const glyph = calc ? 'ƒ' : ((h && typeof h === 'object' && h.type) ? TYPE_GLYPH[h.type] : '');
    let lx = x + PAD;
    if (glyph) {
      ctx.fillStyle = calc ? (g.colors.cellDerived || g.colors.hdrText) : (g.colors.hdrGlyph || g.colors.cellPending);
      ctx.fillText(glyph, lx, metrics.hdrLabelH / 2);
      lx += 12;
      ctx.fillStyle = g.colors.hdrText;
    }
    ctx.fillText(String(label), lx, metrics.hdrLabelH / 2);
    // Right-edge state indicators: sort arrow (far right) + filter funnel (left
    // of it). Both make active view-state visible in the grid, not just a panel.
    const obj = h && typeof h === 'object';
    let rx = x + cw - 4;
    ctx.textAlign = 'right';
    if (obj && h.sort) {
      ctx.fillStyle = g.colors.hdrText;
      ctx.fillText(h.sort === 'desc' ? '↓' : '↑', rx, metrics.hdrLabelH / 2);
      rx -= 11;
    }
    if (obj && h.filtered) {
      ctx.fillStyle = g.colors.hdrText;
      ctx.fillText('▽', rx, metrics.hdrLabelH / 2);
      rx -= 11;
    }
    if (obj && h.invalid) {
      ctx.fillStyle = g.colors.cellError;
      ctx.fillText('⚠', rx, metrics.hdrLabelH / 2);
    }
    // Per-column distribution gutter (opt-in via headerGutterH + provider.headerGutter).
    if (metrics.hdrGutterH > 0 && provider.headerGutter) drawGutter(ctx, g, provider.headerGutter(c), x, metrics.hdrLabelH, cw, metrics.hdrGutterH);
    ctx.restore();
  }
}

// Draw a column's distribution glyph in the header gutter strip. `gd` (from
// provider.headerGutter) is { kind:'hist', bins:[0..1], nullRate, approx } |
// { kind:'cat', segments:[fractions], nullRate, approx } | null. Runs inside the
// per-column save/restore, so ctx state changes don't leak.
function drawGutter(ctx, g, gd, x, top, cw, gh) {
  const x0 = x + 1, w = cw - 2;
  ctx.fillStyle = g.colors.hdrBorder;            // hairline under the label
  ctx.fillRect(x0 - 1, top, cw, 1);
  if (!gd || w <= 1) return;
  const nullH = 2, padTop = 3;
  const plotTop = top + padTop, plotH = Math.max(0, gh - padTop - nullH - 1);
  if (gd.kind === 'hist' && gd.bins && gd.bins.length) {
    const n = gd.bins.length, bw = w / n;
    ctx.fillStyle = g.colors.cellNum;
    for (let i = 0; i < n; i++) {
      const v = gd.bins[i] || 0; if (v <= 0) continue;
      const bh = Math.max(v * plotH, 1);
      ctx.fillRect(x0 + i * bw, plotTop + (plotH - bh), Math.max(bw - 0.5, 0.5), bh);
    }
  } else if (gd.kind === 'cat' && gd.segments && gd.segments.length) {
    const total = gd.segments.reduce((s, v) => s + v, 0) || 1;
    let cx = x0;
    for (let i = 0; i < gd.segments.length; i++) {
      const sw = (gd.segments[i] / total) * w;
      ctx.globalAlpha = Math.max(0.3, 1 - i * 0.13);
      ctx.fillStyle = g.colors.cellDerived;
      ctx.fillRect(cx, plotTop, Math.max(sw - 0.5, 0.5), plotH);
      cx += sw;
    }
    ctx.globalAlpha = 1;
  }
  if (gd.nullRate != null) {                      // null-rate bar along the bottom
    const by = top + gh - nullH;
    ctx.fillStyle = g.colors.gridLine; ctx.fillRect(x0, by, w, nullH);
    if (gd.nullRate > 0) { ctx.globalAlpha = 0.65; ctx.fillStyle = g.colors.cellError; ctx.fillRect(x0, by, w * gd.nullRate, nullH); ctx.globalAlpha = 1; }
  }
  if (gd.approx) {                                // a muted ≈ marks a sampled (not exact) glyph
    ctx.fillStyle = g.colors.hdrGlyph; ctx.font = '9px ' + g.mono; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('≈', x0 + w, top + 1);
  }
}

// Row header band: provider.rowHeader(r) (default r+1).
export function paintRowHeaders(g, r0, r1, sy, vh) {
  const { rowHdrCtx: ctx, dpr, metrics, provider } = g;
  const w = metrics.rowHdrW, rowH = metrics.rowH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, vh);
  ctx.fillStyle = g.colors.hdrBg;
  ctx.fillRect(0, 0, w, vh);

  ctx.strokeStyle = g.colors.hdrBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = r0; r <= r1 + 1; r++) {
    const y = Math.round(r * rowH - sy) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(w, y);
  }
  ctx.moveTo(w - 0.5, 0); ctx.lineTo(w - 0.5, vh);
  ctx.stroke();

  ctx.font = g.hdrFontPx + 'px ' + g.mono;
  ctx.fillStyle = g.colors.hdrText;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let r = r0; r <= r1; r++) {
    const label = provider.rowHeader ? provider.rowHeader(r) : (r + 1);
    const y = r * rowH - sy + rowH / 2;
    ctx.fillText(String(label ?? r + 1), w - PAD, y);
  }
}

// Full repaint of the three bands.
export function paint(g) {
  if (!g.ctx) return;
  const sx = g.scrollEl.scrollLeft, sy = g.scrollEl.scrollTop;
  const vw = g.canvas.width / g.dpr, vh = g.canvas.height / g.dpr;
  const [c0, c1] = visibleColRange(g.metrics, sx, vw);
  const [r0, r1] = visibleRowRange(g.metrics, sy, vh);
  paintCells(g, c0, r0, c1, r1, sx, sy, vw, vh);
  paintColHeaders(g, c0, c1, sx, vw);
  paintRowHeaders(g, r0, r1, sy, vh);
}
