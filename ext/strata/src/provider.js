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
  let highlight = null;   // Set<baseOrdinal> | null — rows brushed by an incoming selection
  const nDisp = () => (view ? view.length : table.nrows);
  const under = (r) => (view ? view.at(r) : r); // display row → underlying row
  const notify = () => { for (const cb of readyListeners) { try { cb(); } catch (e) { console.error('[strata] listener threw', e); } } };

  return {
    table,
    view,

    dims() { return { rows: nDisp(), cols: table.cols }; },

    cellAt(r, c) {
      if (r < 0 || r >= nDisp() || c < 0 || c >= table.cols) return null;
      const ur = under(r);
      const type = TYPE[table.schema[c].type] || 'string';
      const hl = highlight ? highlight.has(ur) : false;
      const cell = table.getCell(ur, c);
      let out;
      if (cell.derived) {
        if (cell.value === FORMULA_ERROR) out = { value: null, state: STATE_ERROR, type, style: { text: '#ERR' } };
        else if (cell.value == null) out = null;                 // empty derived → blank
        else out = { value: cell.value, state: STATE_DERIVED, type, style: { text: fmtCell(cell.value) } };
      } else if (cell.value == null && !cell.edited) {
        out = null;                                              // empty → blank
      } else {
        out = { value: cell.value, state: cell.edited ? STATE_EDITED : STATE_RAW, type, style: { text: fmtCell(cell.value) } };
      }
      // Brushing tints the WHOLE row — empty cells in a brushed row get a blank
      // highlighted cell so the row tints edge-to-edge (loom skips null cells).
      if (hl) {
        if (out == null) return { value: null, state: STATE_RAW, type, style: { text: '', highlight: true } };
        out.style = { ...out.style, highlight: true };
      }
      return out;
    },

    header(c) {
      const s = table.schema[c];
      const h = { label: s.unit ? `${s.name} (${s.unit})` : s.name, type: TYPE[s.type] || 'string' };
      // Surface the active sort IN the header (loom draws an arrow) — sort state
      // was footer-only before, invisible in the grid itself.
      if (view && view.sortSpec && view.sortSpec.by === s.name) h.sort = view.sortSpec.dir;
      return h;
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

    // Undo/redo + batch grouping — the optional loom provider contract. loom
    // calls beginBatch/endBatch around multi-cell writes (paste/fill/range-delete)
    // so each is one undo step, and Ctrl+Z/Ctrl+Y call undo/redo. Delegated to
    // the table (which owns the overlay op-log).
    beginBatch() { table.beginTxn(); },
    endBatch() { table.endTxn(); },
    undo() { return table.undo(); },
    redo() { return table.redo(); },
    canUndo() { return table.canUndo(); },
    canRedo() { return table.canRedo(); },

    // Reserved for async windowing (strata-spec §11 upgrade #1): a streaming
    // base will call these when a window lands so loom repaints. v1 is fully
    // loaded, so it never fires — but the seam exists from day one.
    // Cross-surface brushing (strata-spec §7): tint a set of base-ordinal rows
    // (the incoming selection, resolved to underlying ids by the app). null
    // clears. Repaints via the same onReady seam loom already listens on.
    setHighlight(rowIds) {
      highlight = rowIds == null ? null : (rowIds instanceof Set ? rowIds : new Set(rowIds));
      notify();
    },
    get highlightCount() { return highlight ? highlight.size : 0; },

    onReady(cb) {
      readyListeners.push(cb);
      return () => { const i = readyListeners.indexOf(cb); if (i >= 0) readyListeners.splice(i, 1); };
    },
    _notifyReady() { notify(); },
  };
}
