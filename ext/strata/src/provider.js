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

// MUST match @gcu/loom CellState / CellType enum values.
const STATE_RAW = 'raw';
const STATE_EDITED = 'edited';
const TYPE = { number: 'number', category: 'category', string: 'string' };

/**
 * @param {object} table  a StrataTable (see ./table.js)
 * @returns a loom provider: dims / cellAt / header / rowHeader / commit / onReady
 */
export function createTableProvider(table) {
  const readyListeners = [];

  return {
    table,

    dims() { return { rows: table.nrows, cols: table.cols }; },

    cellAt(r, c) {
      if (r < 0 || r >= table.nrows || c < 0 || c >= table.cols) return null;
      const cell = table.getCell(r, c);
      if (cell.value == null && !cell.edited) return null; // empty → blank
      return {
        value: cell.value,
        state: cell.edited ? STATE_EDITED : STATE_RAW,
        type: TYPE[table.schema[c].type] || 'string',
        style: { text: fmtCell(cell.value) },
      };
    },

    header(c) {
      const s = table.schema[c];
      return { label: s.unit ? `${s.name} (${s.unit})` : s.name, type: TYPE[s.type] || 'string' };
    },

    rowHeader(r) { return r + 1; },

    // Edits flow to the overlay. loom calls its own refresh() after commit, so
    // we don't repaint here. Coercion is the column's, owned by strata.
    commit(r, c, raw) {
      table.setCell(r, c, coerceValue(raw, table.schema[c].type));
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
