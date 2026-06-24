// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/loom — A virtualized canvas grid renderer behind a rich, async cell provider. Windows over millions of rows; cells carry state + type (auditability made visual); host-agnostic mount drops into a standalone page or an iframe surface unchanged. The interlace of warp (columns) and weft (rows) into the visible fabric of a table.

// ── src/model.js ──

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

// ── clipboard TSV (pure, node-testable) ──────────────────────────────────────
// The clipboard interchange is tab-separated values with Excel/Sheets quoting:
// a field is wrapped in double quotes iff it contains a tab, newline, CR or
// quote, and embedded quotes are doubled. This is exactly the dialect Excel and
// Google Sheets put on the clipboard, so copy/paste round-trips with them.

function tsvField(s) {
  s = s == null ? '' : String(s);
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Serialize a 2D matrix of cell strings to a TSV string.
function toTSV(matrix) {
  return matrix.map((row) => row.map(tsvField).join('\t')).join('\n');
}

// Parse TSV (or CSV via `delim`) clipboard text into a 2D matrix of strings.
// Honours Excel-style quoting: doubled quotes, and tabs/newlines inside quotes.
// A single trailing newline does not yield a spurious empty row.
function parseTSV(text, delim = '\t') {
  const rows = [];
  let row = [], field = '', inQ = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ── src/geometry.js ──

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

// ── src/memory-provider.js ──

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

  // Undo/redo + batch grouping (the optional loom provider contract), mirroring
  // the real strata table so loom's generic Ctrl+Z / batch path is exercised by
  // the reference provider too. ABSENT marks an overlay cell that wasn't set.
  const undoStack = [], redoStack = [];
  let txn = null, txnDepth = 0;
  const ABSENT = Symbol('absent');
  const snap = (r, c) => (overlay.has(key(r, c)) ? overlay.get(key(r, c)) : ABSENT);
  const restore = (r, c, v) => { const k = key(r, c); if (v === ABSENT) overlay.delete(k); else overlay.set(k, v); };
  const record = (op) => { if (txn) txn.push(op); else { undoStack.push([op]); redoStack.length = 0; } };
  const applyGroup = (g, useBefore) => { for (let i = g.length - 1; i >= 0; i--) restore(g[i].r, g[i].c, useBefore ? g[i].before : g[i].after); };

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

    // Provenance tooltip (optional loom contract): edited cells report base→now.
    cellTitle(r, c) {
      if (r < 0 || r >= rows.length || c < 0 || c >= columns.length) return null;
      const k = key(r, c);
      return overlay.has(k) ? `was ${fmtVal(rows[r][c])} → now ${fmtVal(overlay.get(k))}` : null;
    },

    commit(r, c, raw) {
      const before = snap(r, c);
      overlay.set(key(r, c), coerce(raw, columns[c].type));
      record({ r, c, before, after: snap(r, c) });
    },

    // Undo/redo + batch (optional loom contract; see header).
    beginBatch() { txnDepth++; if (!txn) txn = []; },
    endBatch() { txnDepth--; if (txnDepth <= 0) { if (txn && txn.length) { undoStack.push(txn); redoStack.length = 0; } txn = null; txnDepth = 0; } },
    undo() { if (!undoStack.length) return false; const g = undoStack.pop(); applyGroup(g, true); redoStack.push(g); return true; },
    redo() { if (!redoStack.length) return false; const g = redoStack.pop(); applyGroup(g, false); undoStack.push(g); return true; },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    // Inspection helpers (not part of the contract; for tests/demos).
    _overlay: overlay,
    columns,
    PENDING,
  };
}

// ── src/render.js ──

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

// A muted one-glyph type indicator drawn before each header label — type is what
// a structured table is *about*, so it's visible at a glance. Keyed by the
// CellType string values the provider reports.
const TYPE_GLYPH = { number: '#', string: 'a', category: '≡', date: '◷', bool: '✓' };

// Default GCU-dark-ish palette. options.colors overrides any key. Kept inside
// loom so the lib renders standalone without auditable's CSS tokens; a surface
// can pass --au-* values through options.colors.
const DARK_COLORS = {
  gridLine: '#1e1e1e', hdrBg: '#1a1a1a', hdrBorder: '#2a2a2a', hdrText: '#888',
  cellText: '#bbb', cellNum: '#8cb878', cellDerived: '#c89b3c', cellError: '#d46a6a',
  cellPending: '#555', cellOutOfOrder: '#c8a13c', hdrGlyph: '#6f6f6f',
  editedBar: '#c89b3c', selFill: 'rgba(200,155,60,0.12)', selStroke: '#c89b3c',
  highlightFill: 'rgba(120,130,225,0.22)',   // cross-surface brushing tint (indigo)
  bg: '#121212', scrollThumb: '#3a3a3a', scrollTrack: '#161616',
};

const LIGHT_COLORS = {
  gridLine: '#ddd', hdrBg: '#e8e8e8', hdrBorder: '#ccc', hdrText: '#888',
  cellText: '#333', cellNum: '#3a7a30', cellDerived: '#8a6c2a', cellError: '#b03030',
  cellPending: '#bbb', cellOutOfOrder: '#9a7a1a', hdrGlyph: '#aaa',
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
    const cw = colW(metrics, c);
    const x = colXAt(metrics, c) - sx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, 0, cw - 2, metrics.hdrH);
    ctx.clip();
    ctx.textAlign = 'left';
    // Type glyph (muted), then the label.
    const glyph = (h && typeof h === 'object' && h.type) ? TYPE_GLYPH[h.type] : '';
    let lx = x + PAD;
    if (glyph) {
      ctx.fillStyle = g.colors.hdrGlyph || g.colors.cellPending;
      ctx.fillText(glyph, lx, metrics.hdrH / 2);
      lx += 12;
      ctx.fillStyle = g.colors.hdrText;
    }
    ctx.fillText(String(label), lx, metrics.hdrH / 2);
    // Right-edge state indicators: sort arrow (far right) + filter funnel (left
    // of it). Both make active view-state visible in the grid, not just a panel.
    const obj = h && typeof h === 'object';
    let rx = x + cw - 4;
    ctx.textAlign = 'right';
    if (obj && h.sort) {
      ctx.fillStyle = g.colors.hdrText;
      ctx.fillText(h.sort === 'desc' ? '↓' : '↑', rx, metrics.hdrH / 2);
      rx -= 11;
    }
    if (obj && h.filtered) {
      ctx.fillStyle = g.colors.hdrText;
      ctx.fillText('▽', rx, metrics.hdrH / 2);
    }
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

// ── src/grid.js ──

// @gcu/loom — grid: the host-agnostic createGrid factory (browser-only).
//
// createGrid(element, provider, options?) builds the canvas scaffold, wires
// scroll/mouse/keyboard, runs the edit→commit lifecycle, and returns an
// instance handle. No module globals — all state lives on the closure `g`, so
// any number of grids coexist in one page or surface (strata-spec §11,
// upgrade #4: host-agnostic mount, the seam that lets the same renderer drop
// into a standalone page OR a Works iframe unchanged).
//
// Scaffold + virtualized scroll + select + edit + refresh + a first-class
// selection object, plus the daily-driver ergonomics: full keyboard navigation
// (arrows/Home/End/PageUp-Down/Ctrl combos, shift-extend), range-aware
// delete/fill, TSV copy/cut/paste, undo/redo (Ctrl+Z / Ctrl+Y, via the optional
// provider.undo/redo + beginBatch/endBatch contract), and column resize (drag the
// header border; double-click it to autofit). Clipboard rides a focus-holding <textarea>
// so the native copy/cut/paste events carry e.clipboardData — no permission
// prompt, and it works under file:// (where navigator.clipboard is blocked).
// Still deferred (additive): zoom, frozen header rows, hover tooltips, variable
// row-height, persisting column widths into the document view-state.


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
    headerContextListeners: [],
    contextListeners: [],
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
  // No tabindex: the scroll div wheel/drag-scrolls but must NOT be click-
  // focusable, or it would steal focus from `clip` (where keyboard + clipboard
  // live) on every mousedown. Adding a tabindex attribute makes a div click-
  // focusable, so we deliberately leave it off.
  body.appendChild(scroll);
  g.scrollEl = scroll;

  const spacer = document.createElement('div');
  styleEl(spacer, { pointerEvents: 'none' });
  scroll.appendChild(spacer);
  g.spacer = spacer;

  // Hidden focus holder: a 1px transparent textarea that holds focus when no
  // cell is being edited. Keyboard navigation and clipboard both target it —
  // the native copy/cut/paste events on a real <textarea> carry clipboardData
  // directly, so copy/paste needs no permission and works under file:// (unlike
  // navigator.clipboard, which is blocked there). Tucked under the corner.
  const clip = document.createElement('textarea');
  styleEl(clip, {
    position: 'absolute', left: 0, top: 0, width: '1px', height: '1px',
    opacity: 0, border: 0, padding: 0, margin: 0, resize: 'none', outline: 'none',
    whiteSpace: 'pre', zIndex: 0,
  });
  clip.tabIndex = 0;
  clip.setAttribute('autocomplete', 'off');
  clip.setAttribute('autocorrect', 'off');
  clip.setAttribute('autocapitalize', 'off');
  clip.spellcheck = false;
  clip.setAttribute('aria-hidden', 'true');
  element.appendChild(clip);
  g.clip = clip;

  // Hover tooltip — shows provider.cellTitle(r,c) (provenance: was→now, derived
  // formula, …) after a short dwell. position:fixed so it floats over the canvas.
  const tip = document.createElement('div');
  tip.className = 'loom-tooltip';
  styleEl(tip, {
    position: 'fixed', display: 'none', zIndex: 10, pointerEvents: 'none',
    background: g.colors.hdrBg, color: g.colors.cellText, border: '1px solid ' + g.colors.hdrBorder,
    borderRadius: '3px', padding: '2px 6px', font: g.hdrFontPx + 'px ' + g.mono,
    whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });
  element.appendChild(tip);
  g.tip = tip;

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
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); clip.focus(); }
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
    clip.focus();
    refresh();
  }

  // ── events ──
  function onMouseDown(e) {
    if (e.button !== 0) return;
    // Suppress the default mousedown action: on a non-focusable target it would
    // move focus to <body>, blurring our hidden `clip` right after we focus it
    // (then keyboard + clipboard would be dead). We manage focus + selection
    // ourselves, so the default buys us nothing.
    e.preventDefault();
    if (g.editing) cancelEdit();
    clip.focus();
    if (g.tip) g.tip.style.display = 'none';
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

  const clampR = (r) => Math.max(0, Math.min(M.totalRows - 1, r));
  const clampC = (c) => Math.max(0, Math.min(M.totalCols - 1, c));

  // Move the active corner to (r,c). extend=true keeps the anchor (r0,c0) and
  // grows the rect; otherwise collapses to a single cell. Clamped to the grid.
  function gotoCell(r, c, extend) {
    r = clampR(r); c = clampC(c);
    if (extend && g.sel) g.sel = { r0: g.sel.r0, c0: g.sel.c0, r1: r, c1: c };
    else g.sel = { r0: r, c0: c, r1: r, c1: c };
    scrollToCell(r, c);
    repaint();
    emitSelect();
  }

  // ── range writes (delete / fill / paste) ──
  // Plain display text of a cell — the copy source and the fill seed.
  function cellPlainText(row, col) {
    const cell = provider.cellAt(row, col);
    if (cell == null || cell === PENDING) return '';
    if (cell.style && typeof cell.style.text === 'string') return cell.style.text;
    return cell.value == null ? '' : String(cell.value);
  }
  // Apply a batch of [row, col, raw] writes through the provider, then refresh
  // once. The provider owns coercion + dirty tracking (the app wraps commit).
  // beginBatch/endBatch (optional contract) group the writes into ONE undo step.
  async function applyWrites(writes) {
    if (!writes.length) return;
    if (provider.beginBatch) provider.beginBatch();
    try {
      for (const [r, c, v] of writes) {
        try { await provider.commit(r, c, v); }
        catch (e) { console.error('[loom] commit failed', e); }
      }
    } finally { if (provider.endBatch) provider.endBatch(); }
    refresh();
  }
  function clearRange() {
    const s = normSel(g.sel); if (!s) return;
    const w = [];
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) w.push([r, c, '']);
    applyWrites(w);
  }
  function fillDown() {
    const s = normSel(g.sel); if (!s || s.r1 === s.r0) return;
    const w = [];
    for (let c = s.c0; c <= s.c1; c++) {
      const src = cellPlainText(s.r0, c);
      for (let r = s.r0 + 1; r <= s.r1; r++) w.push([r, c, src]);
    }
    applyWrites(w);
  }
  function fillRight() {
    const s = normSel(g.sel); if (!s || s.c1 === s.c0) return;
    const w = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const src = cellPlainText(r, s.c0);
      for (let c = s.c0 + 1; c <= s.c1; c++) w.push([r, c, src]);
    }
    applyWrites(w);
  }

  // ── clipboard (native copy/cut/paste on the focus holder) ──
  function selMatrix() {
    const s = normSel(g.sel); if (!s) return null;
    const m = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const row = [];
      for (let c = s.c0; c <= s.c1; c++) row.push(cellPlainText(r, c));
      m.push(row);
    }
    return m;
  }
  function onCopy(e) {
    if (g.editing) return; // the cell input copies its own text
    const m = selMatrix(); if (!m) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(m));
  }
  function onCut(e) {
    if (g.editing) return;
    const m = selMatrix(); if (!m) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toTSV(m));
    clearRange();
  }
  function onPaste(e) {
    if (g.editing) return; // the cell input pastes into itself
    if (!e.clipboardData) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const m = parseTSV(text);
    if (!m.length) return;
    const s = normSel(g.sel) || { r0: 0, c0: 0, r1: 0, c1: 0 };
    const oneByOne = m.length === 1 && m[0].length === 1;
    const w = [];
    if (oneByOne && (s.r1 > s.r0 || s.c1 > s.c0)) {
      // A single value pasted over a range fills the whole range (Excel-like).
      const v = m[0][0];
      for (let r = s.r0; r <= s.r1 && r < M.totalRows; r++)
        for (let c = s.c0; c <= s.c1 && c < M.totalCols; c++) w.push([r, c, v]);
    } else {
      // Block paste anchored at the top-left, clipped to the grid (v1 base is
      // fixed-height, so a paste that runs past the last row simply stops).
      let maxCols = 0;
      for (let i = 0; i < m.length; i++) {
        const r = s.r0 + i; if (r >= M.totalRows) break;
        maxCols = Math.max(maxCols, m[i].length);
        for (let j = 0; j < m[i].length; j++) {
          const c = s.c0 + j; if (c >= M.totalCols) break;
          w.push([r, c, m[i][j]]);
        }
      }
      const r1 = clampR(s.r0 + m.length - 1), c1 = clampC(s.c0 + maxCols - 1);
      g.sel = { r0: s.r0, c0: s.c0, r1, c1 }; // select the pasted block
    }
    applyWrites(w).then(emitSelect);
  }

  function onKeyDown(e) {
    if (g.editing) return; // input handles its own keys
    if (!g.sel) return;
    const mod = e.ctrlKey || e.metaKey;
    const ext = e.shiftKey;
    const a = { r: g.sel.r1, c: g.sel.c1 };  // active (moving) corner
    const lastR = M.totalRows - 1, lastC = M.totalCols - 1;
    const page = Math.max(1, Math.floor(body.clientHeight / M.rowH) - 1);

    if (mod && !e.altKey) {
      switch (e.key) {
        case 'a': case 'A': e.preventDefault(); g.sel = { r0: 0, c0: 0, r1: lastR, c1: lastC }; repaint(); emitSelect(); return;
        // Copy/cut/paste are left to the native clipboard events on `clip`.
        case 'c': case 'C': case 'x': case 'X': case 'v': case 'V': return;
        // Undo/redo (optional provider contract). Ctrl+Z / Ctrl+Shift+Z + Ctrl+Y.
        case 'z': case 'Z': e.preventDefault(); if (e.shiftKey) { if (provider.redo) { provider.redo(); refresh(); } } else if (provider.undo) { provider.undo(); refresh(); } return;
        case 'y': case 'Y': e.preventDefault(); if (provider.redo) { provider.redo(); refresh(); } return;
        case 'd': case 'D': e.preventDefault(); fillDown(); return;
        case 'r': case 'R': e.preventDefault(); fillRight(); return;
        case 'ArrowUp':    e.preventDefault(); gotoCell(0, a.c, ext); return;
        case 'ArrowDown':  e.preventDefault(); gotoCell(lastR, a.c, ext); return;
        case 'ArrowLeft':  e.preventDefault(); gotoCell(a.r, 0, ext); return;
        case 'ArrowRight': e.preventDefault(); gotoCell(a.r, lastC, ext); return;
        case 'Home':       e.preventDefault(); gotoCell(0, 0, ext); return;
        case 'End':        e.preventDefault(); gotoCell(lastR, lastC, ext); return;
      }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); gotoCell(a.r - 1, a.c, ext); return;
      case 'ArrowDown':  e.preventDefault(); gotoCell(a.r + 1, a.c, ext); return;
      case 'ArrowLeft':  e.preventDefault(); gotoCell(a.r, a.c - 1, ext); return;
      case 'ArrowRight': e.preventDefault(); gotoCell(a.r, a.c + 1, ext); return;
      case 'Home':       e.preventDefault(); gotoCell(a.r, 0, ext); return;
      case 'End':        e.preventDefault(); gotoCell(a.r, lastC, ext); return;
      case 'PageUp':     e.preventDefault(); gotoCell(a.r - page, a.c, ext); return;
      case 'PageDown':   e.preventDefault(); gotoCell(a.r + page, a.c, ext); return;
      case 'Enter': { const s = normSel(g.sel); e.preventDefault(); gotoCell(s.r0 + 1, s.c0, false); return; }
      case 'Tab':   { const s = normSel(g.sel); e.preventDefault(); gotoCell(s.r0, s.c0 + (e.shiftKey ? -1 : 1), false); return; }
      case 'F2':    { const s = normSel(g.sel); e.preventDefault(); startEdit(s.r0, s.c0); return; }
      case 'Delete': case 'Backspace': e.preventDefault(); clearRange(); return;
      default:
        if (e.key.length === 1) { const s = normSel(g.sel); e.preventDefault(); startEdit(s.r0, s.c0, e.key); return; }
    }
  }

  // ── column resize ──
  const RESIZE_HANDLE = 5;  // px proximity to a border that grabs the resize
  const MIN_COL_W = 30;     // px floor so a column can't vanish
  // The column whose right border is within RESIZE_HANDLE of clientX, or -1.
  // A column is resized by dragging its OWN right edge (so the left edge of
  // column c grabs column c-1, the standard spreadsheet feel).
  function colBorderAt(clientX) {
    const rect = colHdr.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    if (x < 0) return -1;
    const c = Math.max(0, colAtX(M, x));
    let hit = -1;
    if (Math.abs(x - colXOf(c + 1)) <= RESIZE_HANDLE) hit = c;               // c's right edge
    else if (c > 0 && Math.abs(x - colXOf(c)) <= RESIZE_HANDLE) hit = c - 1; // c's left edge → prev col
    return (hit >= 0 && hit < M.totalCols) ? hit : -1;
  }
  // Autofit a column to the widest of its header label + the currently visible
  // cells (a bounded sample — virtualized grids can't measure every row).
  function autofitCol(c) {
    const ctx = g.colHdrCtx;
    let w = 0;
    ctx.font = '600 ' + g.hdrFontPx + 'px ' + g.mono;
    const h = provider.header ? provider.header(c) : null;
    const label = h == null ? '' : (typeof h === 'string' ? h : (h.label ?? ''));
    w = Math.max(w, ctx.measureText(String(label)).width);
    ctx.font = g.fontPx + 'px ' + g.mono;
    const [r0, r1] = visibleRowRange(M, scroll.scrollTop, body.clientHeight);
    for (let r = r0; r <= r1; r++) w = Math.max(w, ctx.measureText(cellPlainText(r, c)).width);
    M.colWidths[c] = Math.max(MIN_COL_W, Math.ceil(w) + 16); // + padding both sides
    sizeCanvases();
    repaint();
  }
  function onHeaderMouseDown(e) {
    if (e.button !== 0) return;
    const c = colBorderAt(e.clientX);
    if (c < 0) return;                 // not on a border → let click→sort happen
    e.preventDefault();
    g.suppressHeaderClick = true;      // the ensuing click must not also sort
    const startX = e.clientX, startW = colWOf(c);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev) => {
      M.colWidths[c] = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
      sizeCanvases();                  // total width changed → resize the spacer
      repaint();
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function onHeaderMove(e) {
    if (document.body.style.cursor === 'col-resize') return; // mid-drag
    colHdr.style.cursor = colBorderAt(e.clientX) >= 0 ? 'col-resize' : '';
  }
  function onHeaderDblClick(e) {
    const c = colBorderAt(e.clientX);
    if (c < 0) return;
    e.preventDefault();
    g.suppressHeaderClick = true;
    autofitCol(c);
  }

  // Column-header click → emit the column index (for click-to-sort, etc.).
  // Suppressed right after a border drag / autofit so a resize doesn't sort.
  function onHeaderClickEvt(e) {
    if (g.suppressHeaderClick) { g.suppressHeaderClick = false; return; }
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    for (const cb of g.headerListeners) { try { cb(c); } catch (err) { console.error('[loom] onHeaderClick listener threw', err); } }
  }
  // Right-click a column header → emit (col, clientX, clientY); the host builds
  // the header menu (sort/autofit/revert-column/…). No listener → native menu.
  function onHeaderContextMenuEvt(e) {
    if (!g.headerContextListeners.length) return;
    e.preventDefault();
    const rect = colHdr.getBoundingClientRect();
    const c = colAtX(M, e.clientX - rect.left + scroll.scrollLeft);
    if (c < 0 || c >= M.totalCols) return;
    for (const cb of g.headerContextListeners) { try { cb({ col: c, clientX: e.clientX, clientY: e.clientY }); } catch (err) { console.error('[loom] onHeaderContextMenu listener threw', err); } }
  }
  colHdr.addEventListener('mousedown', onHeaderMouseDown);
  colHdr.addEventListener('mousemove', onHeaderMove);
  colHdr.addEventListener('dblclick', onHeaderDblClick);
  colHdr.addEventListener('click', onHeaderClickEvt);
  colHdr.addEventListener('contextmenu', onHeaderContextMenuEvt);
  g._cleanup.push(() => colHdr.removeEventListener('mousedown', onHeaderMouseDown));
  g._cleanup.push(() => colHdr.removeEventListener('mousemove', onHeaderMove));
  g._cleanup.push(() => colHdr.removeEventListener('dblclick', onHeaderDblClick));
  g._cleanup.push(() => colHdr.removeEventListener('click', onHeaderClickEvt));
  g._cleanup.push(() => colHdr.removeEventListener('contextmenu', onHeaderContextMenuEvt));

  // ── hover tooltip ──
  let hoverKey = null, hoverTimer = null;
  function hideTip() { tip.style.display = 'none'; }
  function onHoverMove(e) {
    if (g.editing || g.selDrag || !provider.cellTitle) { hideTip(); return; }
    const { row, col } = pointToCell(e.clientX, e.clientY);
    const k = row + ':' + col;
    if (k === hoverKey) return;            // same cell — leave the pending/shown tip
    hoverKey = k;
    hideTip();
    clearTimeout(hoverTimer);
    const cx = e.clientX, cy = e.clientY;
    hoverTimer = setTimeout(() => {
      const txt = provider.cellTitle(row, col);
      if (!txt) return;
      tip.textContent = txt;
      tip.style.left = (cx + 12) + 'px';
      tip.style.top = (cy + 16) + 'px';
      tip.style.display = 'block';
    }, 350);
  }
  function onHoverLeave() { hoverKey = null; clearTimeout(hoverTimer); hideTip(); }

  // ── context menu (right-click) ──
  // loom only DETECTS the gesture and emits (row,col,sel,clientX,clientY); the
  // host builds the menu (so its items run through the host's own mutation/undo
  // wiring). With no listener, the native menu shows (a bare grid stays default).
  function onContextMenuEvt(e) {
    if (!g.contextListeners.length) return;
    e.preventDefault();
    onHoverLeave();
    clip.focus();
    const { row, col } = pointToCell(e.clientX, e.clientY);
    const ns = normSel(g.sel);
    const inSel = ns && row >= ns.r0 && row <= ns.r1 && col >= ns.c0 && col <= ns.c1;
    if (!inSel) { g.sel = { r0: row, c0: col, r1: row, c1: col }; repaint(); emitSelect(); }
    const detail = { row, col, sel: normSel(g.sel), clientX: e.clientX, clientY: e.clientY };
    for (const cb of g.contextListeners) { try { cb(detail); } catch (err) { console.error('[loom] onContextMenu listener threw', err); } }
  }

  scroll.addEventListener('scroll', () => { if (g.editing) cancelEdit(); hideTip(); hoverKey = null; repaint(); }, { passive: true });
  scroll.addEventListener('mousedown', onMouseDown);
  scroll.addEventListener('dblclick', onDblClick);
  scroll.addEventListener('mousemove', onHoverMove);
  scroll.addEventListener('mouseleave', onHoverLeave);
  scroll.addEventListener('contextmenu', onContextMenuEvt);
  g._cleanup.push(() => scroll.removeEventListener('mousedown', onMouseDown));
  g._cleanup.push(() => scroll.removeEventListener('dblclick', onDblClick));
  g._cleanup.push(() => scroll.removeEventListener('mousemove', onHoverMove));
  g._cleanup.push(() => scroll.removeEventListener('mouseleave', onHoverLeave));
  g._cleanup.push(() => scroll.removeEventListener('contextmenu', onContextMenuEvt));
  g._cleanup.push(() => clearTimeout(hoverTimer));

  // Keyboard + clipboard live on the hidden focus holder (see scaffold above).
  clip.addEventListener('keydown', onKeyDown);
  clip.addEventListener('copy', onCopy);
  clip.addEventListener('cut', onCut);
  clip.addEventListener('paste', onPaste);
  g._cleanup.push(() => clip.removeEventListener('keydown', onKeyDown));
  g._cleanup.push(() => clip.removeEventListener('copy', onCopy));
  g._cleanup.push(() => clip.removeEventListener('cut', onCut));
  g._cleanup.push(() => clip.removeEventListener('paste', onPaste));

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
    onContextMenu(cb) { g.contextListeners.push(cb); return () => { const i = g.contextListeners.indexOf(cb); if (i >= 0) g.contextListeners.splice(i, 1); }; },
    onHeaderContextMenu(cb) { g.headerContextListeners.push(cb); return () => { const i = g.headerContextListeners.indexOf(cb); if (i >= 0) g.headerContextListeners.splice(i, 1); }; },
    // Column widths (the sparse non-default map). get returns a copy; set
    // restores a saved map — the seam for persisting widths into a document's
    // view-state. autofitColumn measures the header + visible cells.
    getColWidths() { return { ...M.colWidths }; },
    setColWidths(widths) { M.colWidths = { ...(widths || {}) }; sizeCanvases(); repaint(); },
    autofitColumn(c) { autofitCol(c); },
    focus() { g.clip.focus(); },
    setColors(colors) {
      g.colors = colors;
      scroll.style.scrollbarColor = colors.scrollThumb + ' ' + colors.scrollTrack;
      corner.style.background = colors.hdrBg;
      repaint();
    },
    destroy() { for (const fn of g._cleanup) { try { fn(); } catch (_) {} } element.innerHTML = ''; },
  };
}

// ── src/main.js ──

// @gcu/loom — a virtualized canvas grid renderer behind a rich async cell
// provider. The loom interlaces warp (columns) and weft (rows) into the visible
// fabric of cells — a host-agnostic render core extracted from the calque
// spreadsheet grid and reseamed for strata: read = provider.cellAt (async-shaped,
// windowed), write = provider.commit (to an overlay), cells carry state+type so
// auditability is visual, and mount(el, provider) drops into a standalone page
// or a Works surface unchanged. The forcing-function renderer behind strata
// (and, eventually, a retrofitted calque — two consumers keep it honest).
//
// Module manifest (build concat order):
//   model.js           — PENDING sentinel, CellState/CellType enums, helpers (pure)
//   geometry.js        — column-width + virtualization math (pure)
//   memory-provider.js — trivial in-memory reference provider (pure)
//   render.js          — canvas paint core (browser)
//   grid.js            — createGrid factory: scaffold, events, edit→commit (browser)

export {
  PENDING,
  CellState,
  CellType,
  colLetter,
  colIndex,
  fmtVal,
  inferType,
  normSel,
  selEquals,
  toTSV,
  parseTSV,
  colW,
  colXAt,
  colAtX,
  visibleColRange,
  totalWidth,
  rowAtY,
  rowYAt,
  visibleRowRange,
  totalHeight,
  cellAt,
  createMemoryProvider,
  DARK_COLORS,
  LIGHT_COLORS,
  paintCells,
  paintColHeaders,
  paintRowHeaders,
  paint,
  createGrid,
};
