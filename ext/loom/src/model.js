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
export const PENDING = Symbol('loom.pending');

// Cell state — drives the visual treatment of provenance (strata-spec §4/§11).
export const CellState = {
  RAW: 'raw',                 // straight from the immutable base
  EDITED: 'edited',           // a value patch sits over the base (dirty)
  DERIVED: 'derived',         // computed by a formula / the DAG
  ERROR: 'error',             // formula or validation failure
  PENDING: 'pending',         // window not loaded (paired with the PENDING sentinel)
  OUT_OF_ORDER: 'out-of-order', // edited a sort/filter key; row left in place (§4.3)
};

// Cell type — drives alignment, formatting, future unit suffixes (units = v2,
// the enum reserves room now).
export const CellType = {
  NUMBER: 'number',
  STRING: 'string',
  DATE: 'date',
  CATEGORY: 'category',
  BOOL: 'bool',
  NULL: 'null',
};

// Spreadsheet column letter: 0→A, 25→Z, 26→AA, … (bijective base-26).
export function colLetter(n) {
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// Inverse of colLetter: 'A'→0, 'Z'→25, 'AA'→26. Returns -1 on malformed input.
export function colIndex(s) {
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
export function fmtVal(v) {
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
export function inferType(v) {
  if (v === null || v === undefined) return CellType.NULL;
  if (typeof v === 'number') return CellType.NUMBER;
  if (typeof v === 'boolean') return CellType.BOOL;
  if (v instanceof Date) return CellType.DATE;
  return CellType.STRING;
}

// Normalize a drag-built selection rect so r0≤r1, c0≤c1. null-safe.
export function normSel(sel) {
  if (!sel) return null;
  return {
    r0: Math.min(sel.r0, sel.r1),
    c0: Math.min(sel.c0, sel.c1),
    r1: Math.max(sel.r0, sel.r1),
    c1: Math.max(sel.c0, sel.c1),
  };
}

// True if two (possibly un-normalized) selections cover the same rect.
export function selEquals(a, b) {
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
export function toTSV(matrix) {
  return matrix.map((row) => row.map(tsvField).join('\t')).join('\n');
}

// Parse TSV (or CSV via `delim`) clipboard text into a 2D matrix of strings.
// Honours Excel-style quoting: doubled quotes, and tabs/newlines inside quotes.
// A single trailing newline does not yield a spurious empty row.
export function parseTSV(text, delim = '\t') {
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
