// @gcu/strata — table: the in-memory working model (strata-spec §2 role 1, §4
// layers 1-3). An immutable typed-columnar BASE + a sparse value-patch OVERLAY +
// DERIVED columns (formula-defined, computed not stored); every read is
// base⊕overlay, derived columns recompute from it. This is the spine that makes
// strata auditable and non-destructive by construction: the source is never
// mutated, edits are an op log, a cell's base value is always recoverable, and
// derived columns carry their formula (not baked-in values).
//
// v1 scope: base + value patches + per-row derived columns. Deferred §4 layers:
// structural ops (tombstones/inserts/reorder), the view pipeline. Row identity =
// implicit ordinal (§4.1). Base columns are plain arrays (null-clean); typed-
// array packing is a windowing-era optimization.
//
// Pure (new Function for formulas works in any JS env; no DOM). Node-testable.

import { coerceValue, fmtCell, COL_TYPES } from './values.js';
import { compileFormula, FORMULA_ERROR } from './formula.js';

/**
 * @param {object} spec
 * @param {Array<{name,type,unit?,role?,analyte?}>} spec.schema  BASE column descriptors
 * @param {Array<Array>} spec.columns   per-column base arrays (length nrows)
 * @param {number} spec.nrows
 */
export function createTable({ schema, columns, nrows }) {
  const nbase = columns.length;          // base columns occupy indices 0..nbase-1
  const overlay = new Map();             // 'r:c' → { value, base }   (base cells only)
  const derived = new Map();             // colIdx → { name, type, formula, deps, fn, cache }
  const key = (r, c) => r + ':' + c;

  // Undo/redo over overlay edits — "every action reversible" made real, nearly
  // free off the overlay (which is already an op-log in spirit). Each entry is a
  // GROUP of cell ops [{r,c,before,after}] where before/after are the overlay
  // state ({value,base} | null). beginTxn/endTxn collapse a batch (paste, fill,
  // range-delete) into ONE group so a single undo reverts the whole batch.
  const undoStack = [], redoStack = [];
  let txn = null, txnDepth = 0;
  const ovSnap = (r, c) => { const o = overlay.get(key(r, c)); return o ? { value: o.value, base: o.base } : null; };
  const ovRestore = (r, c, s) => { const k = key(r, c); if (s) overlay.set(k, { value: s.value, base: s.base }); else overlay.delete(k); };
  function recordAround(r, c, mutate) {
    const before = ovSnap(r, c);
    mutate();
    const after = ovSnap(r, c);
    if ((before === null && after === null) || (before && after && before.value === after.value)) return; // no-op
    const op = { r, c, before, after };
    if (txn) txn.push(op);
    else { undoStack.push([op]); redoStack.length = 0; }
  }
  function applyGroup(ops, useBefore) {
    for (let i = ops.length - 1; i >= 0; i--) ovRestore(ops[i].r, ops[i].c, useBefore ? ops[i].before : ops[i].after);
    invalidateDerived();
  }

  // Read a cell's effective value by column index (base⊕overlay, or derived).
  function readValue(c, r, stack) {
    if (derived.has(c)) return derivedColumn(c, stack)[r];
    const k = key(r, c);
    return overlay.has(k) ? overlay.get(k).value : columns[c][r];
  }

  // Compute (and cache) a derived column. Lazy, with a cycle guard; a per-row
  // formula error becomes FORMULA_ERROR (rendered as state:error).
  function derivedColumn(c, stack) {
    const d = derived.get(c);
    if (d.cache) return d.cache;
    stack = stack || new Set();
    if (stack.has(c)) throw new Error(`strata: cyclic derived column "${d.name}"`);
    stack.add(c);
    const depIdx = d.deps.map((n) => schema.findIndex((s) => s.name === n));
    const out = new Array(nrows);
    for (let r = 0; r < nrows; r++) {
      const args = depIdx.map((ci) => readValue(ci, r, stack));
      try { out[r] = d.fn(...args); } catch { out[r] = FORMULA_ERROR; }
    }
    stack.delete(c);
    d.cache = out;
    return out;
  }

  // v1: invalidate ALL derived caches on any base edit (correct; recompute is
  // lazy on next read). Targeted dependent-only invalidation is a later
  // optimization that matters at scale, not at v1's small-data regime.
  function invalidateDerived() { for (const d of derived.values()) d.cache = null; }

  const t = {
    schema,
    nrows,
    get cols() { return schema.length; },
    get baseCount() { return nbase; },
    _base: columns,
    _overlay: overlay,

    isDerived(c) { return derived.has(c); },
    baseValue(r, c) { return columns[c][r]; },
    isEdited(r, c) { return overlay.has(key(r, c)); },

    // Merged read: { value, edited, base, derived? }.
    getCell(r, c) {
      if (derived.has(c)) return { value: derivedColumn(c)[r], edited: false, base: null, derived: true };
      const k = key(r, c);
      if (overlay.has(k)) { const o = overlay.get(k); return { value: o.value, edited: true, base: o.base }; }
      const v = columns[c][r];
      return { value: v, edited: false, base: v };
    },

    // Write a value patch (base columns only — derived cells are computed).
    setCell(r, c, value) {
      if (derived.has(c)) return;
      recordAround(r, c, () => {
        const k = key(r, c);
        const base = columns[c][r];
        if (value === base || (value == null && base == null)) overlay.delete(k);
        else overlay.set(k, { value, base });
      });
      invalidateDerived();
    },

    revert(r, c) { recordAround(r, c, () => overlay.delete(key(r, c))); invalidateDerived(); },
    dirtyCount() { return overlay.size; },

    // Change a column's declared type (number/category/string). RELABEL ONLY —
    // existing values are not re-coerced (the base stays immutable; sort/display
    // are value-driven, so unaffected). The type drives alignment, the header
    // glyph, and how FUTURE edits coerce. A schema op (like addDerivedColumn) —
    // not on the undo stack. Unknown type ignored.
    setColumnType(c, type) {
      if (c < 0 || c >= schema.length || !COL_TYPES.includes(type)) return;
      schema[c] = { ...schema[c], type };
      const d = derived.get(c); if (d) d.type = type;
    },

    // ── undo / redo (over overlay edits) ──
    // beginTxn/endTxn bracket a batch so it collapses to one undo step; nesting
    // is depth-counted (loom's batched writes never nest, but it's safe). A bare
    // setCell outside a txn is its own one-op group.
    beginTxn() { txnDepth++; if (!txn) txn = []; },
    endTxn() { txnDepth--; if (txnDepth <= 0) { if (txn && txn.length) { undoStack.push(txn); redoStack.length = 0; } txn = null; txnDepth = 0; } },
    undo() { if (!undoStack.length) return false; const g = undoStack.pop(); applyGroup(g, true); redoStack.push(g); return true; },
    redo() { if (!redoStack.length) return false; const g = redoStack.pop(); applyGroup(g, false); undoStack.push(g); return true; },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    // The effective values of column c as a fresh array (base⊕overlay, or the
    // derived computation). The bridge to the rest of the workspace.
    column(c) {
      if (derived.has(c)) return derivedColumn(c).slice();
      const out = columns[c].slice();
      for (const [k, o] of overlay) {
        const i = k.indexOf(':');
        if (Number(k.slice(i + 1)) === c) out[Number(k.slice(0, i))] = o.value;
      }
      return out;
    },

    columnByName(name) {
      const i = schema.findIndex((s) => s.name === name);
      return i < 0 ? null : this.column(i);
    },

    displayAt(r, c) {
      const v = this.getCell(r, c).value;
      return v === FORMULA_ERROR ? '#ERR' : fmtCell(v);
    },

    commitRaw(r, c, raw) { this.setCell(r, c, coerceValue(raw, schema[c].type)); },

    // Add a derived column: a JS formula over existing columns (base or earlier
    // derived). Appended after the existing columns; returns its index. Throws
    // on a formula syntax error.
    addDerivedColumn({ name, formula, type = 'number', unit }) {
      const { deps, fn } = compileFormula(formula, schema.map((s) => s.name));
      const field = { name, type, derived: true, formula };
      if (unit) field.unit = unit;
      schema.push(field);
      derived.set(schema.length - 1, { name, type, formula, deps, fn, cache: null });
      return schema.length - 1;
    },
  };
  return t;
}
