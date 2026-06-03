// @gcu/strata — provider: adapt a StrataTable to the @gcu/loom cell-provider
// contract. This is the real provider that replaces loom's toy memory-provider:
// the base⊕overlay model rendered as a grid, edits routed back to the overlay.
//
// Deliberately decoupled from loom's *bundle*: it returns plain contract-shaped
// objects whose `state`/`type` strings match loom's CellState/CellType enum
// VALUES (loom compares by value), so strata never imports loom. The two are
// joined only by the contract, not the code.
//
// Pure, zero-dep (beyond ./values).

import { coerceValue, fmtCell } from './values.js';
import { FORMULA_ERROR } from './formula.js';

// MUST match @gcu/loom CellState / CellType enum values.
const STATE_RAW = 'raw';
const STATE_EDITED = 'edited';
const STATE_DERIVED = 'derived';
const STATE_ERROR = 'error';
const TYPE = { number: 'number', category: 'category', string: 'string' };

/**
 * @param {object} table  a StrataTable (see ./table.js)
 * @param {object} [view] a sort/filter view (see ./view.js). When present, loom
 *   renders through it — display rows map to underlying table rows — so the
 *   table+overlay stays the source of truth and loom needs no view awareness.
 * @returns a loom provider: dims / cellAt / header / rowHeader / commit / onReady
 */
export function createTableProvider(table, view) {
  const readyListeners = [];
  const nDisp = () => (view ? view.length : table.nrows);
  const under = (r) => (view ? view.at(r) : r); // display row → underlying row

  return {
    table,
    view,

    dims() { return { rows: nDisp(), cols: table.cols }; },

    cellAt(r, c) {
      if (r < 0 || r >= nDisp() || c < 0 || c >= table.cols) return null;
      const ur = under(r);
      const cell = table.getCell(ur, c);
      const type = TYPE[table.schema[c].type] || 'string';
      if (cell.derived) {
        if (cell.value === FORMULA_ERROR) return { value: null, state: STATE_ERROR, type, style: { text: '#ERR' } };
        if (cell.value == null) return null; // empty derived cell → blank
        return { value: cell.value, state: STATE_DERIVED, type, style: { text: fmtCell(cell.value) } };
      }
      if (cell.value == null && !cell.edited) return null; // empty → blank
      return {
        value: cell.value,
        state: cell.edited ? STATE_EDITED : STATE_RAW,
        type,
        style: { text: fmtCell(cell.value) },
      };
    },

    header(c) {
      const s = table.schema[c];
      return { label: s.unit ? `${s.name} (${s.unit})` : s.name, type: TYPE[s.type] || 'string' };
    },

    // Show the UNDERLYING row number (provenance) — so a sorted/filtered view
    // still tells you which base row you're looking at.
    rowHeader(r) { return under(r) + 1; },

    // Edits flow to the overlay at the underlying row. loom calls its own
    // refresh() after commit, so we don't repaint here.
    commit(r, c, raw) {
      if (table.isDerived(c)) return; // computed columns aren't editable
      table.setCell(under(r), c, coerceValue(raw, table.schema[c].type));
    },

    // Reserved for async windowing (strata-spec §11 upgrade #1): a streaming
    // base will call these when a window lands so loom repaints. v1 is fully
    // loaded, so it never fires — but the seam exists from day one.
    onReady(cb) {
      readyListeners.push(cb);
      return () => { const i = readyListeners.indexOf(cb); if (i >= 0) readyListeners.splice(i, 1); };
    },
    _notifyReady() { for (const cb of readyListeners) { try { cb(); } catch (e) { console.error('[strata] onReady listener threw', e); } } },
  };
}
