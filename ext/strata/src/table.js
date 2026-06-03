// @gcu/strata — table: the in-memory working model (strata-spec §2 role 1, §4
// layers 1-2). An immutable typed-columnar BASE + a sparse value-patch OVERLAY;
// every read is base⊕overlay. This is the spine that makes strata auditable and
// non-destructive by construction: the source is never mutated, edits are an op
// log (= undo stack = dirty delta = the eventual overlay.json), and a cell's
// provenance (raw vs edited, and its original base value) is always recoverable.
//
// v1 scope: base + value patches only. Deferred (the other §4 layers): derived
// columns (the DAG), structural ops (tombstones/inserts/reorder), the view
// pipeline. Row identity = implicit ordinal (§4.1) — free because the base never
// moves. Base columns are plain arrays for v1 (null-clean); typed-array packing
// is a windowing-era optimization.
//
// Pure, zero-dep (beyond ./values).

import { coerceValue, fmtCell } from './values.js';

/**
 * @param {object} spec
 * @param {Array<{name,type,unit?,role?,analyte?}>} spec.schema  column descriptors
 * @param {Array<Array>} spec.columns   per-column base arrays (length nrows)
 * @param {number} spec.nrows
 */
export function createTable({ schema, columns, nrows }) {
  const overlay = new Map();             // 'r:c' → { value, base }
  const key = (r, c) => r + ':' + c;

  const t = {
    schema,
    nrows,
    cols: schema.length,
    _base: columns,
    _overlay: overlay,

    // Base value at (r,c) — the immutable source, ignoring any patch.
    baseValue(r, c) { return columns[c][r]; },

    isEdited(r, c) { return overlay.has(key(r, c)); },

    // Merged read: { value, edited, base }. `base` is the original datum so the
    // UI can show "was X" provenance on an edited cell.
    getCell(r, c) {
      const k = key(r, c);
      if (overlay.has(k)) { const o = overlay.get(k); return { value: o.value, edited: true, base: o.base }; }
      const v = columns[c][r];
      return { value: v, edited: false, base: v };
    },

    // Write a value patch. Editing a cell back to its base value clears the
    // patch (no phantom dirty marks) — equality is by value (numbers/strings).
    setCell(r, c, value) {
      const k = key(r, c);
      const base = columns[c][r];
      if (value === base || (value == null && base == null)) { overlay.delete(k); return; }
      overlay.set(k, { value, base });
    },

    // Drop a patch, reverting (r,c) to base.
    revert(r, c) { overlay.delete(key(r, c)); },

    // Number of cells currently patched (the dirty count).
    dirtyCount() { return overlay.size; },

    // The effective (base⊕overlay) values of column c, as a fresh array. The
    // bridge to the rest of the workspace: a notebook reads this as an array, a
    // chart plots it, export writes it.
    column(c) {
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

    // Display text for (r,c) — faithful formatting of the merged value.
    displayAt(r, c) { return fmtCell(this.getCell(r, c).value); },

    // Coerce + commit a raw edited string to (r,c), per the column's type.
    commitRaw(r, c, raw) { this.setCell(r, c, coerceValue(raw, schema[c].type)); },
  };
  return t;
}
