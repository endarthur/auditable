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

// Default GCU-dark-ish palette. options.colors overrides any key. Kept inside
// loom so the lib renders standalone without auditable's CSS tokens; a surface
// can pass --au-* values through options.colors.
export const DARK_COLORS = {
  gridLine: '#1e1e1e', hdrBg: '#1a1a1a', hdrBorder: '#2a2a2a', hdrText: '#888',
  cellText: '#bbb', cellNum: '#8cb878', cellDerived: '#c89b3c', cellError: '#d46a6a',
  cellPending: '#555', cellOutOfOrder: '#c8a13c',
  editedBar: '#c89b3c', selFill: 'rgba(200,155,60,0.12)', selStroke: '#c89b3c',
  bg: '#121212',
};

export const LIGHT_COLORS = {
  gridLine: '#ddd', hdrBg: '#e8e8e8', hdrBorder: '#ccc', hdrText: '#888',
  cellText: '#333', cellNum: '#3a7a30', cellDerived: '#8a6c2a', cellError: '#b03030',
  cellPending: '#bbb', cellOutOfOrder: '#9a7a1a',
  editedBar: '#8a6c2a', selFill: 'rgba(138,108,42,0.12)', selStroke: '#8a6c2a',
  bg: '#fff',
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
    const x = colXAt(metrics, c) - sx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, 0, colW(metrics, c) - 2, metrics.hdrH);
    ctx.clip();
    ctx.fillText(String(label), x + PAD, metrics.hdrH / 2);
    ctx.restore();
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
