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

import { PENDING, CellState, CellType, fmtVal, inferType } from './model.js';

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

export function createMemoryProvider(spec) {
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
