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
import { predicateColumns } from './predicate.js';

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
  // Which columns the active filter touches (for the header funnel glyph),
  // memoized by the filter-predicate identity (a fresh object per setFilter).
  let _fpRef, _fpCols = null;
  function filteredCols() {
    const fp = view && view.filterPredicate;
    if (fp !== _fpRef) { _fpRef = fp; _fpCols = fp ? new Set(predicateColumns(fp)) : null; }
    return _fpCols;
  }
  const nDisp = () => (view ? view.length : table.nrows);
  const under = (r) => (view ? view.at(r) : r); // display row → underlying row
  const notify = () => { for (const cb of readyListeners) { try { cb(); } catch (e) { console.error('[strata] listener threw', e); } } };

  // Column projection: the display axis is an explicit ORDER of underlying col
  // indices (default identity), minus the HIDDEN set — the column-axis mirror of
  // the row view. loom (and the app, via underCol) see only the visible columns,
  // in order. No reorder + nothing hidden → underCol(dc)===dc, identical to before.
  const hidden = new Set();        // underlying column indices that are hidden
  let order = null;                // display order of ALL underlying cols (incl hidden); null = identity
  let _vc = null, _vcCols = -1;
  function ensureOrder() {         // (re)build/extend order to cover all current columns
    if (!order) { order = []; for (let c = 0; c < table.cols; c++) order.push(c); return; }
    if (order.length !== table.cols) {
      const seen = new Set(order);
      order = order.filter((c) => c < table.cols);                 // drop stale
      for (let c = 0; c < table.cols; c++) if (!seen.has(c)) order.push(c); // append new (e.g. derived)
    }
  }
  function vc() {                  // visible underlying cols, in display order
    if (_vc === null || _vcCols !== table.cols) {
      ensureOrder();
      _vc = order.filter((c) => !hidden.has(c));
      _vcCols = table.cols;
    }
    return _vc;
  }
  const underC = (dc) => { const m = vc(); return dc >= 0 && dc < m.length ? m[dc] : -1; };
  const invalidateCols = () => { _vc = null; };

  return {
    table,
    view,

    dims() { return { rows: nDisp(), cols: vc().length }; },

    cellAt(r, c) {
      if (r < 0 || r >= nDisp() || c < 0 || c >= vc().length) return null;
      const uc = underC(c);
      const ur = under(r);
      const type = TYPE[table.schema[uc].type] || 'string';
      const hl = highlight ? highlight.has(ur) : false;
      const cell = table.getCell(ur, uc);
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
      const s = table.schema[underC(c)];
      const h = { label: s.unit ? `${s.name} (${s.unit})` : s.name, type: TYPE[s.type] || 'string' };
      // Surface the active sort IN the header (loom draws an arrow) — sort state
      // was footer-only before, invisible in the grid itself.
      if (view && view.sortSpec && view.sortSpec.by === s.name) h.sort = view.sortSpec.dir;
      const fc = filteredCols();
      if (fc && fc.has(s.name)) h.filtered = true;
      return h;
    },

    // Provenance on hover (loom shows it as a tooltip) — auditability made
    // touchable: an edited cell tells you its base; a derived cell, its formula.
    cellTitle(r, c) {
      if (r < 0 || r >= nDisp() || c < 0 || c >= vc().length) return null;
      const uc = underC(c);
      if (table.isDerived(uc)) { const f = table.schema[uc].formula; return f ? '= ' + f : null; }
      const cell = table.getCell(under(r), uc);
      return cell.edited ? `was ${fmtCell(cell.base)} → now ${fmtCell(cell.value)}` : null;
    },

    // Revert a cell to its base (display row+col → underlying). Derived cells
    // aren't editable, so nothing to revert. Recorded on the table → undoable.
    revert(r, c) {
      const uc = underC(c);
      if (uc < 0 || table.isDerived(uc)) return;
      table.revert(under(r), uc);
    },

    // Show the UNDERLYING row number (provenance) — so a sorted/filtered view
    // still tells you which base row you're looking at.
    rowHeader(r) { return under(r) + 1; },

    // Edits flow to the overlay at the underlying row. loom calls its own
    // refresh() after commit, so we don't repaint here.
    commit(r, c, raw) {
      const uc = underC(c);
      if (uc < 0 || table.isDerived(uc)) return; // computed columns aren't editable
      table.setCell(under(r), uc, coerceValue(raw, table.schema[uc].type));
    },

    // Column projection (hide/show). underCol maps a display col → underlying
    // table col — the app uses it to translate loom's col indices into table
    // indices. Mutators invalidate the cache; loom re-reads dims() on refresh().
    underCol(dc) { return underC(dc); },
    hideColumn(c) { hidden.add(c); invalidateCols(); },
    showColumn(c) { hidden.delete(c); invalidateCols(); },
    showAllColumns() { hidden.clear(); invalidateCols(); },
    hiddenColumns() { return [...hidden]; },           // underlying indices
    isColumnHidden(c) { return hidden.has(c); },
    // Display order of ALL underlying cols (incl hidden) — the Columns dialog
    // reads it, reorders, and writes it back. resetColumnOrder → identity.
    columnOrder() { ensureOrder(); return order.slice(); },
    setColumnOrder(arr) { order = arr.slice(); invalidateCols(); },
    resetColumnOrder() { order = null; invalidateCols(); },

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
