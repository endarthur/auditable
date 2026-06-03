// @gcu/loom — geometry: column-width model + virtualization math.
//
// Pure functions over a `metrics` object — extracted verbatim-in-spirit from
// tools/calque/js/grid.js but parameterized (no module globals), so multiple
// grids coexist and the math is node-testable. Row height is fixed for v1; the
// row helpers take `rowH` as a scalar but are written so a prefix-sum height
// index can swap in later (strata-spec §11 "reserve variable row height")
// without touching call sites.
//
// metrics = {
//   defaultColW,        // px width of a default column
//   rowH,               // px height of a row (fixed, v1)
//   colWidths,          // sparse { [colIndex]: px } — only non-default columns
//   totalRows, totalCols
// }
//
// Zero DOM. Node-testable.

// Width of column c (custom if present, else the default).
export function colW(metrics, c) {
  return metrics.colWidths[c] || metrics.defaultColW;
}

// x-offset of column c's left edge = sum of widths of columns 0..c-1.
// = c * default, adjusted by the delta of any custom-width columns before c.
// O(#custom) — custom widths are sparse, so this stays cheap even at 16k cols.
export function colXAt(metrics, c) {
  let x = c * metrics.defaultColW;
  const cw = metrics.colWidths;
  for (const col in cw) {
    if (Number(col) < c) x += cw[col] - metrics.defaultColW;
  }
  return x;
}

// Which column the x-offset falls in. Walks custom-width columns in order,
// filling the gaps between them with default-width runs (closed form per gap).
export function colAtX(metrics, x) {
  const cw = metrics.colWidths;
  const dW = metrics.defaultColW;
  let accum = 0;
  let lastCustom = -1;
  const customs = Object.keys(cw).map(Number).sort((a, b) => a - b);
  for (const ci of customs) {
    const gapCols = ci - lastCustom - 1;
    const gapEnd = accum + gapCols * dW;
    if (x < gapEnd) return lastCustom + 1 + Math.floor((x - accum) / dW);
    accum = gapEnd;
    if (x < accum + cw[ci]) return ci;
    accum += cw[ci];
    lastCustom = ci;
  }
  return lastCustom + 1 + Math.floor((x - accum) / dW);
}

// [firstCol, lastCol] visible for a horizontal scroll window [sx, sx+vw].
// Both bounds clamped to [0, totalCols-1] so scrolling past the end yields a
// valid (collapsed) range, never an inverted one.
export function visibleColRange(metrics, sx, vw) {
  const hi = metrics.totalCols - 1;
  const c0 = Math.min(hi, Math.max(0, colAtX(metrics, sx)));
  const c1 = Math.min(hi, Math.max(0, colAtX(metrics, sx + vw)));
  return [c0, c1];
}

// Total virtual width of all columns (for the scroll spacer).
export function totalWidth(metrics) {
  return colXAt(metrics, metrics.totalCols);
}

// ── Rows (fixed height, v1) ──

// Which row the y-offset falls in.
export function rowAtY(metrics, y) {
  return Math.max(0, Math.floor(y / metrics.rowH));
}

// y-offset of row r's top edge.
export function rowYAt(metrics, r) {
  return r * metrics.rowH;
}

// [firstRow, lastRow] visible for a vertical scroll window [sy, sy+vh].
// Both bounds clamped to [0, totalRows-1] (see visibleColRange).
export function visibleRowRange(metrics, sy, vh) {
  const hi = metrics.totalRows - 1;
  const r0 = Math.min(hi, Math.max(0, Math.floor(sy / metrics.rowH)));
  const r1 = Math.min(hi, Math.max(0, Math.ceil((sy + vh) / metrics.rowH)));
  return [r0, r1];
}

// Total virtual height of all rows (for the scroll spacer).
export function totalHeight(metrics) {
  return metrics.totalRows * metrics.rowH;
}

// Map a scroll-space point (x,y already offset by scroll) to a {row, col}.
export function cellAt(metrics, x, y) {
  return { row: rowAtY(metrics, y), col: Math.max(0, colAtX(metrics, x)) };
}
