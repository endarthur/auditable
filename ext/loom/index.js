// @gcu/loom — virtualized canvas grid renderer (rich async cell provider)
// Auto-generated from ext/loom/src/ — do not edit directly

// -- model.js --

// @gcu/loom — model: the rich cell, the enums, and small pure value helpers.
//
// A loom cell is `{ value, state, type, style? }` — not a bare string. State
// makes strata's auditability *visual* (raw vs edited vs derived vs error);
// type drives rendering (right-aligned numbers, category chips, …). The drawing
// of each state/type is additive — the model is rich up front so nothing has to
// be retrofitted (strata-spec §11, upgrade #2).
//
// Zero DOM. Node-testable.

// Returned by provider.cellAt when the row's chunk isn't loaded yet (windowed
// big-data). The paint loop draws a placeholder and repaints on provider.onReady.
// A sentinel — *not* a Promise — so the synchronous render loop is untouched
// (strata-spec §11, upgrade #1: "you cannot bolt async onto a sync render loop"
// — so the asyncness lives in a sentinel the sync loop already understands).
const PENDING = Symbol('loom.pending');

// Cell state — drives the visual treatment of provenance (strata-spec §4/§11).
const CellState = {
  RAW: 'raw',                 // straight from the immutable base
  EDITED: 'edited',           // a value patch sits over the base (dirty)
  DERIVED: 'derived',         // computed by a formula / the DAG
  ERROR: 'error',             // formula or validation failure
  PENDING: 'pending',         // window not loaded (paired with the PENDING sentinel)
  OUT_OF_ORDER: 'out-of-order', // edited a sort/filter key; row left in place (§4.3)
};

// Cell type — drives alignment, formatting, future unit suffixes (units = v2,
// the enum reserves room now).
const CellType = {
  NUMBER: 'number',
  STRING: 'string',
  DATE: 'date',
  CATEGORY: 'category',
  BOOL: 'bool',
  NULL: 'null',
};

// Spreadsheet column letter: 0→A, 25→Z, 26→AA, … (bijective base-26).
function colLetter(n) {
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// Inverse of colLetter: 'A'→0, 'Z'→25, 'AA'→26. Returns -1 on malformed input.
function colIndex(s) {
  if (!s) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 65;
    if (c < 0 || c > 25) return -1;
    n = n * 26 + (c + 1);
  }
  return n - 1;
}

// Default display text for a raw value. Numbers: integers verbatim, else 2dp.
// Providers may override per-cell via the rich model; this is the fallback the
// in-memory provider + headers use.
function fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

// Infer a CellType from a raw JS value (the in-memory provider's default; real
// providers carry declared schema types instead).
function inferType(v) {
  if (v === null || v === undefined) return CellType.NULL;
  if (typeof v === 'number') return CellType.NUMBER;
  if (typeof v === 'boolean') return CellType.BOOL;
  if (v instanceof Date) return CellType.DATE;
  return CellType.STRING;
}

// Normalize a drag-built selection rect so r0≤r1, c0≤c1. null-safe.
function normSel(sel) {
  if (!sel) return null;
  return {
    r0: Math.min(sel.r0, sel.r1),
    c0: Math.min(sel.c0, sel.c1),
    r1: Math.max(sel.r0, sel.r1),
    c1: Math.max(sel.c0, sel.c1),
  };
}

// True if two (possibly un-normalized) selections cover the same rect.
function selEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const na = normSel(a), nb = normSel(b);
  return na.r0 === nb.r0 && na.c0 === nb.c0 && na.r1 === nb.r1 && na.c1 === nb.c1;
}

// -- geometry.js --

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
function colW(metrics, c) {
  return metrics.colWidths[c] || metrics.defaultColW;
}

// x-offset of column c's left edge = sum of widths of columns 0..c-1.
// = c * default, adjusted by the delta of any custom-width columns before c.
// O(#custom) — custom widths are sparse, so this stays cheap even at 16k cols.
function colXAt(metrics, c) {
  let x = c * metrics.defaultColW;
  const cw = metrics.colWidths;
  for (const col in cw) {
    if (Number(col) < c) x += cw[col] - metrics.defaultColW;
  }
  return x;
}

// Which column the x-offset falls in. Walks custom-width columns in order,
// filling the gaps between them with default-width runs (closed form per gap).
function colAtX(metrics, x) {
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
function visibleColRange(metrics, sx, vw) {
  const hi = metrics.totalCols - 1;
  const c0 = Math.min(hi, Math.max(0, colAtX(metrics, sx)));
  const c1 = Math.min(hi, Math.max(0, colAtX(metrics, sx + vw)));
  return [c0, c1];
}

// Total virtual width of all columns (for the scroll spacer).
function totalWidth(metrics) {
  return colXAt(metrics, metrics.totalCols);
}

// ── Rows (fixed height, v1) ──

// Which row the y-offset falls in.
function rowAtY(metrics, y) {
  return Math.max(0, Math.floor(y / metrics.rowH));
}

// y-offset of row r's top edge.
function rowYAt(metrics, r) {
  return r * metrics.rowH;
}

// [firstRow, lastRow] visible for a vertical scroll window [sy, sy+vh].
// Both bounds clamped to [0, totalRows-1] (see visibleColRange).
function visibleRowRange(metrics, sy, vh) {
  const hi = metrics.totalRows - 1;
  const r0 = Math.min(hi, Math.max(0, Math.floor(sy / metrics.rowH)));
  const r1 = Math.min(hi, Math.max(0, Math.ceil((sy + vh) / metrics.rowH)));
  return [r0, r1];
}

// Total virtual height of all rows (for the scroll spacer).
function totalHeight(metrics) {
  return metrics.totalRows * metrics.rowH;
}

// Map a scroll-space point (x,y already offset by scroll) to a {row, col}.
function cellAt(metrics, x, y) {
  return { row: rowAtY(metrics, y), col: Math.max(0, colAtX(metrics, x)) };
}

// -- memory-provider.js --

// @gcu/loom — memory-provider: a trivial in-memory reference provider.
//
// The simplest thing that satisfies the loom provider contract: a fixed set of
// typed columns over an in-memory row array, with edits kept in a sparse overlay
// map so committed cells render as state:EDITED (the auditability-made-visual
// demo, and a stand-in for strata's real base+overlay until that lands). Pure —
// no DOM — so it doubles as the contract's executable documentation and is
// node-testable on its own.
//
// Shape:
//   createMemoryProvider({
//     columns: [{ name, type? }, …],   // type optional → inferred from first row
//     rows:    [[v, …], …] | [{name:v}, …],
//   })


function coerce(raw, type) {
  if (raw === '' || raw == null) return null;
  switch (type) {
    case CellType.NUMBER: { const n = Number(raw); return Number.isNaN(n) ? raw : n; }
    case CellType.BOOL: {
      const s = String(raw).toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      return raw;
    }
    default: return String(raw);
  }
}

function createMemoryProvider(spec) {
  const columns = spec.columns.map((c) => ({ name: c.name, type: c.type || null }));
  // Normalize rows to a 2D array indexed [r][c].
  const rows = spec.rows.map((row) =>
    Array.isArray(row) ? row.slice() : columns.map((c) => row[c.name]));

  // Infer any unspecified column types from the first non-null cell.
  for (let c = 0; c < columns.length; c++) {
    if (columns[c].type) continue;
    let t = CellType.STRING;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r][c] != null) { t = inferType(rows[r][c]); break; }
    }
    columns[c].type = t;
  }

  // Sparse edit overlay: key `${r}:${c}` → value. Base `rows` is never mutated
  // (the overlay-is-the-spine principle, in miniature).
  const overlay = new Map();
  const key = (r, c) => r + ':' + c;

  return {
    dims() { return { rows: rows.length, cols: columns.length }; },

    cellAt(r, c) {
      if (r < 0 || r >= rows.length || c < 0 || c >= columns.length) return null;
      const k = key(r, c);
      const edited = overlay.has(k);
      const value = edited ? overlay.get(k) : rows[r][c];
      if (value == null && !edited) return null;
      return {
        value,
        state: edited ? CellState.EDITED : CellState.RAW,
        type: columns[c].type,
        style: { text: fmtVal(value) },
      };
    },

    header(c) { return { label: columns[c].name, type: columns[c].type }; },
    rowHeader(r) { return r + 1; },

    commit(r, c, raw) {
      overlay.set(key(r, c), coerce(raw, columns[c].type));
    },

    // Inspection helpers (not part of the contract; for tests/demos).
    _overlay: overlay,
    columns,
    PENDING,
  };
}

// -- render.js --

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



const PAD = 6;

// Default GCU-dark-ish palette. options.colors overrides any key. Kept inside
// loom so the lib renders standalone without auditable's CSS tokens; a surface
// can pass --au-* values through options.colors.
const DARK_COLORS = {
  gridLine: '#1e1e1e', hdrBg: '#1a1a1a', hdrBorder: '#2a2a2a', hdrText: '#888',
  cellText: '#bbb', cellNum: '#8cb878', cellDerived: '#c89b3c', cellError: '#d46a6a',
  cellPending: '#555', cellOutOfOrder: '#c8a13c',
  editedBar: '#c89b3c', selFill: 'rgba(200,155,60,0.12)', selStroke: '#c89b3c',
  highlightFill: 'rgba(120,130,225,0.22)',   // cross-surface brushing tint (indigo)
  bg: '#121212', scrollThumb: '#3a3a3a', scrollTrack: '#161616',
};

const LIGHT_COLORS = {
  gridLine: '#ddd', hdrBg: '#e8e8e8', hdrBorder: '#ccc', hdrText: '#888',
  cellText: '#333', cellNum: '#3a7a30', cellDerived: '#8a6c2a', cellError: '#b03030',
  cellPending: '#bbb', cellOutOfOrder: '#9a7a1a',
  editedBar: '#8a6c2a', selFill: 'rgba(138,108,42,0.12)', selStroke: '#8a6c2a',
  highlightFill: 'rgba(90,100,190,0.16)',   // cross-surface brushing tint (indigo)
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
function paintCells(g, c0, r0, c1, r1, sx, sy, vw, vh) {
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
function paintColHeaders(g, c0, c1, sx, vw) {
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
function paintRowHeaders(g, r0, r1, sy, vh) {
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
function paint(g) {
  if (!g.ctx) return;
  const sx = g.scrollEl.scrollLeft, sy = g.scrollEl.scrollTop;
  const vw = g.canvas.width / g.dpr, vh = g.canvas.height / g.dpr;
  const [c0, c1] = visibleColRange(g.metrics, sx, vw);
  const [r0, r1] = visibleRowRange(g.metrics, sy, vh);
  paintCells(g, c0, r0, c1, r1, sx, sy, vw, vh);
  paintColHeaders(g, c0, c1, sx, vw);
  paintRowHeaders(g, r0, r1, sy, vh);
}

// -- grid.js --

// @gcu/loom — grid: the host-agnostic createGrid factory (browser-only).
//
// createGrid(element, provider, options?) builds the canvas scaffold, wires
// scroll/mouse/keyboard, runs the edit→commit lifecycle, and returns an
// instance handle. No module globals — all state lives on the closure `g`, so
// any number of grids coexist in one page or surface (strata-spec §11,
// upgrade #4: host-agnostic mount, the seam that lets the same renderer drop
// into a standalone page OR a Works iframe unchanged).
//
// This is the de-risk slice: scaffold + virtualized scroll + select + edit +
// refresh + a first-class selection object. Deferred (second pass, additive):
// column resize, zoom, frozen header rows, hover tooltips, copy/paste.




const SPACER_CAP = 16000000; // browser max element dimension, roughly

function styleEl(el, props) { for (const k in props) el.style[k] = props[k]; }

function readMono() {
  if (typeof getComputedStyle !== 'function') return 'monospace';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
  return v || 'ui-monospace, monospace';
}

/**
 * @param {HTMLElement} element  host (sized by the caller; loom fills it)
 * @param {object} provider      dims/cellAt/header/rowHeader/commit/onReady
 * @param {object} [options]     { colors?, theme?, defaultColW?, rowH?, hdrH?,
 *                                 rowHdrW?, fontPx?, hdrFontPx?, mono? }
 * @returns {object} instance    { refresh, getSelection, setSelection, onSelect,
 *                                 focus, destroy, element, provider }
 */
function createGrid(element, provider, options = {}) {
  const dims = provider.dims();
  const g = {
    el: element,
    provider,
    dpr: window.devicePixelRatio || 1,
    colors: options.colors || (options.theme === 'light' ? LIGHT_COLORS : DARK_COLORS),
    mono: options.mono || readMono(),
    fontPx: options.fontPx || 13,
    hdrFontPx: options.hdrFontPx || 11,
    metrics: {
      defaultColW: options.defaultColW || 100,
      rowH: options.rowH || 24,
      hdrH: options.hdrH || 24,
      rowHdrW: options.rowHdrW || 48,
      colWidths: options.colWidths || {},
      totalRows: dims.rows,
      totalCols: dims.cols,
    },
    sel: null,
    selDrag: false,
    editing: null,
    selectListeners: [],
    headerListeners: [],
    _cleanup: [],
  };

  // ── scaffold ──
  element.innerHTML = '';
  if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
  element.style.overflow = 'hidden';
  const M = g.metrics;

  const corner = document.createElement('div');
  styleEl(corner, { position: 'absolute', left: 0, top: 0, width: M.rowHdrW + 'px', height: M.hdrH + 'px', background: g.colors.hdrBg, borderRight: '1px solid ' + g.colors.hdrBorder, borderBottom: '1px solid ' + g.colors.hdrBorder, zIndex: 3 });
  element.appendChild(corner);

  const colHdr = document.createElement('canvas');
  styleEl(colHdr, { position: 'absolute', left: M.rowHdrW + 'px', top: 0, height: M.hdrH + 'px', zIndex: 2 });
  element.appendChild(colHdr);
  g.colHdrCanvas = colHdr; g.colHdrCtx = colHdr.getContext('2d');

  const rowHdr = document.createElement('canvas');
  styleEl(rowHdr, { position: 'absolute', left: 0, top: M.hdrH + 'px', width: M.rowHdrW + 'px', zIndex: 2 });
  element.appendChild(rowHdr);
  g.rowHdrCanvas = rowHdr; g.rowHdrCtx = rowHdr.getContext('2d');

  const body = document.createElement('div');
  styleEl(body, { position: 'absolute', left: M.rowHdrW + 'px', top: M.hdrH + 'px', right: 0, bottom: 0, overflow: 'hidden' });
  element.appendChild(body);
  g.body = body;

  const canvas = document.createElement('canvas');
  styleEl(canvas, { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' });
  body.appendChild(canvas);
  g.canvas = canvas; g.ctx = canvas.getContext('2d');

  const scroll = document.createElement('div');
  styleEl(scroll, {
    position: 'absolute', inset: 0, overflow: 'auto', outline: 'none',
    // Standard scrollbar styling (Chrome 121+/Firefox) — themed, set inline so
    // loom stays self-contained (no CSS file); every consumer inherits it.
    scrollbarWidth: 'thin', scrollbarColor: g.colors.scrollThumb + ' ' + g.colors.scrollTrack,
  });
  scroll.tabIndex = 0; // focusable → keyboard scoped to this instance
  body.appendChild(scroll);
  g.scrollEl = scroll;

  const spacer = document.createElement('div');
  styleEl(spacer, { pointerEvents: 'none' });
  scroll.appendChild(spacer);
  g.spacer = spacer;

  // ── sizing ──
  function sizeCanvases() {
    const dpr = g.dpr;
    const viewW = body.clientWidth, viewH = body.clientHeight;
    for (const [cv, w, h] of [[canvas, viewW, viewH], [colHdr, viewW, M.hdrH], [rowHdr, M.rowHdrW, viewH]]) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    spacer.style.width = Math.min(totalWidth(M), SPACER_CAP) + 'px';
    spacer.style.height = Math.min(totalHeight(M), SPACER_CAP) + 'px';
  }

  function repaint() { paint(g); }

  // ── selection ──
  function emitSelect() {
    const ns = normSel(g.sel);
    for (const cb of g.selectListeners) { try { cb(ns); } catch (e) { console.error('[loom] onSelect listener threw', e); } }
  }
  function setSel(sel, notify) {
    const changed = !selEquals(g.sel, sel);
    g.sel = sel;
    repaint();
    if (notify && changed) emitSelect();
  }

  function pointToCell(clientX, clientY) {
    const rect = scroll.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    const y = clientY - rect.top + scroll.scrollTop;
    return cellAt(M, x, y);
  }

  function scrollToCell(r, c) {
    const left = colXOf(c), top = r * M.rowH;
    const vw = body.clientWidth, vh = body.clientHeight;
    if (left < scroll.scrollLeft) scroll.scrollLeft = left;
    else if (left + colWOf(c) > scroll.scrollLeft + vw) scroll.scrollLeft = left + colWOf(c) - vw;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + M.rowH > scroll.scrollTop + vh) scroll.scrollTop = top + M.rowH - vh;
  }
  // tiny local geometry shims (avoid importing colXAt/colW just for these two)
  function colWOf(c) { return M.colWidths[c] || M.defaultColW; }
  function colXOf(c) { let x = c * M.defaultColW; for (const k in M.colWidths) if (Number(k) < c) x += M.colWidths[k] - M.defaultColW; return x; }

  // ── edit lifecycle ──
  function startEdit(row, col, initialChar) {
    if (g.editing) cancelEdit();
    const cur = provider.cellAt(row, col);
    // Computed (derived) or not-yet-loaded (pending) cells aren't editable —
    // the cell state drives editability, no extra flag needed.
    if (cur === PENDING || (cur && cur.state === CellState.DERIVED)) return;
    const input = document.createElement('input');
    input.type = 'text';
    styleEl(input, {
      position: 'absolute', font: g.fontPx + 'px ' + g.mono, boxSizing: 'border-box',
      padding: '0 5px', margin: 0, border: '2px solid ' + g.colors.selStroke,
      background: g.colors.bg, color: g.colors.cellText, zIndex: 5,
      left: (colXOf(col) - scroll.scrollLeft) + 'px',
      top: (row * M.rowH - scroll.scrollTop) + 'px',
      width: colWOf(col) + 'px', height: M.rowH + 'px',
    });
    const original = cur && cur.style && typeof cur.style.text === 'string'
      ? cur.style.text
      : (cur && cur.value != null ? String(cur.value) : '');
    input.value = initialChar !== undefined ? initialChar : original;
    body.appendChild(input);
    input.focus();
    if (initialChar !== undefined) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();

    g.editing = { row, col, input };
    input.addEventListener('keydown', onEditKey);
  }
  function onEditKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitEdit(1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit(0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); scroll.focus(); }
  }
  function removeInput() {
    if (!g.editing) return;
    g.editing.input.removeEventListener('keydown', onEditKey);
    g.editing.input.remove();
    g.editing = null;
  }
  function cancelEdit() { removeInput(); }
  async function commitEdit(dRow, dCol) {
    if (!g.editing) return;
    const { row, col, input } = g.editing;
    const raw = input.value;
    removeInput();
    // Provider owns coercion (column types). loom passes the raw edited string.
    try { await provider.commit(row, col, raw); }
    catch (e) { console.error('[loom] commit failed', e); }
    const nr = Math.max(0, row + dRow), nc = Math.max(0, col + dCol);
    setSel({ r0: nr, c0: nc, r1: nr, c1: nc }, true);
    scroll.focus();
    refresh();
  }

  // ── events ──
  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (g.editing) cancelEdit();
    scroll.focus();
    const { row, col } = pointToCell(e.clientX, e.clientY);
    setSel({ r0: row, c0: col, r1: row, c1: col }, false);
    g.selDrag = true;
    const onMove = (ev) => {
      const c = pointToCell(ev.clientX, ev.clientY);
      g.sel.r1 = c.row; g.sel.c1 = c.col;
      repaint();
    };
    const onUp = () => {
      g.selDrag = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      emitSelect();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function onDblClick(e) {
    const { row, col } = pointToCell(e.clientX, e.clientY);
    setSel({ r0: row, c0: col, r1: row, c1: col }, true);
    startEdit(row, col);
  }

  function moveSel(dr, dc, extend) {
    const s = normSel(g.sel) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    if (extend) {
      const r = Math.max(0, g.sel.r1 + dr), c = Math.max(0, g.sel.c1 + dc);
      g.sel = { r0: g.sel.r0, c0: g.sel.c0, r1: r, c1: c };
      scrollToCell(r, c);
    } else {
      const r = Math.max(0, s.r0 + dr), c = Math.max(0, s.c0 + dc);
      g.sel = { r0: r, c0: c, r1: r, c1: c };
      scrollToCell(r, c);
    }
    repaint();
    emitSelect();
  }

  function onKeyDown(e) {
    if (g.editing) return; // input handles its own keys
    if (!g.sel) return;
    const s = normSel(g.sel);
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSel(-1, 0, e.shiftKey); return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSel(1, 0, e.shiftKey); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSel(0, -1, e.shiftKey); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveSel(0, 1, e.shiftKey); return; }
      if (e.key === 'Enter')      { e.preventDefault(); moveSel(1, 0, false); return; }
      if (e.key === 'Tab')        { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1, false); return; }
      if (e.key === 'F2')         { e.preventDefault(); startEdit(s.r0, s.c0); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        Promise.resolve(provider.commit(s.r0, s.c0, '')).then(refresh).catch((err) => console.error('[loom] clear failed', err));
        return;
      }
      if (e.key.length === 1) { e.preventDefault(); startEdit(s.r0, s.c0, e.key); return; }
    }
  }

  // Column-header click → emit the column index (for click-to-sort, etc.).
  function onHeaderClickEvt(e) {
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    for (const cb of g.headerListeners) { try { cb(c); } catch (err) { console.error('[loom] onHeaderClick listener threw', err); } }
  }
  colHdr.addEventListener('click', onHeaderClickEvt);
  g._cleanup.push(() => colHdr.removeEventListener('click', onHeaderClickEvt));

  scroll.addEventListener('scroll', () => { if (g.editing) cancelEdit(); repaint(); }, { passive: true });
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('dblclick', onDblClick);
  scroll.addEventListener('keydown', onKeyDown);
  g._cleanup.push(() => scroll.removeEventListener('mousedown', onMouseDown));
  g._cleanup.push(() => scroll.removeEventListener('dblclick', onDblClick));
  g._cleanup.push(() => scroll.removeEventListener('keydown', onKeyDown));

  const ro = new ResizeObserver(() => { sizeCanvases(); repaint(); });
  ro.observe(element);
  g._cleanup.push(() => ro.disconnect());

  // Async windowing: provider signals a window landed → repaint (upgrade #1).
  if (typeof provider.onReady === 'function') {
    const off = provider.onReady(() => repaint());
    if (typeof off === 'function') g._cleanup.push(off);
  }

  // ── public instance ──
  function refresh() {
    const d = provider.dims();
    M.totalRows = d.rows; M.totalCols = d.cols;
    sizeCanvases();
    repaint();
  }

  sizeCanvases();
  repaint();

  return {
    element,
    provider,
    refresh,
    getSelection() { return normSel(g.sel); },
    setSelection(sel) { setSel(sel, true); },
    onSelect(cb) { g.selectListeners.push(cb); return () => { const i = g.selectListeners.indexOf(cb); if (i >= 0) g.selectListeners.splice(i, 1); }; },
    onHeaderClick(cb) { g.headerListeners.push(cb); return () => { const i = g.headerListeners.indexOf(cb); if (i >= 0) g.headerListeners.splice(i, 1); }; },
    focus() { g.scrollEl.focus(); },
    setColors(colors) {
      g.colors = colors;
      scroll.style.scrollbarColor = colors.scrollThumb + ' ' + colors.scrollTrack;
      corner.style.background = colors.hdrBg;
      repaint();
    },
    destroy() { for (const fn of g._cleanup) { try { fn(); } catch (_) {} } element.innerHTML = ''; },
  };
}

export {
  CellState,
  CellType,
  DARK_COLORS,
  LIGHT_COLORS,
  PENDING,
  cellAt,
  colAtX,
  colIndex,
  colLetter,
  colW,
  colXAt,
  createGrid,
  createMemoryProvider,
  fmtVal,
  inferType,
  normSel,
  paint,
  paintCells,
  paintColHeaders,
  paintRowHeaders,
  rowAtY,
  rowYAt,
  selEquals,
  totalHeight,
  totalWidth,
  visibleColRange,
  visibleRowRange,
};
