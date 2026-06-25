// @gcu/lamina — provider: adapt a RecordViewSource to the @gcu/loom cell-provider
// contract (read-only). loom's PENDING sentinel is INJECTED (the consumer imports
// it from @gcu/loom and passes it in) so this stays decoupled from loom's bundle —
// the strata-provider trick, extended to the windowed/PENDING case.

import { LOADING } from './viewsource.js';

/**
 * @param {object} vs  a RecordViewSource (viewsource.js)
 * @param {object} opts  { PENDING }  — loom's PENDING sentinel (required for windowing)
 * @returns a loom provider: dims / cellAt / header / rowHeader / onReady
 */
export function createLaminaProvider(vs, { PENDING } = {}) {
  return {
    dims() { return { rows: vs.rowCount(), cols: vs.cols }; },
    cellAt(r, c) {
      const row = vs.rowAt(r);
      if (row === LOADING) return PENDING;          // block not loaded → loom draws a placeholder
      if (row == null) return null;                  // out of range → blank
      const v = row[c];
      if (v == null || v === '') return null;        // empty cell → blank
      return { value: v, state: 'raw', type: vs.colType(c), style: { text: v } };
    },
    header(c) { return vs.header(c); },
    rowHeader(r) { return r + 1; },
    onReady(cb) { return vs.onReady(cb); },
  };
}
