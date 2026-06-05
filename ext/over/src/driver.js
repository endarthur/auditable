// @gcu/over — the driver. Runs a compiled row function over a record stream,
// applying the stream concerns: `delete` drops the row, `exit` stops the stream,
// and the resolved output columns (from the schema pass) project the result. When
// the transform has window aggregates, a first pass computes them per group
// (ctx.win) before the row pass.
//
// v0 table shape = an array of row objects ([{FE:62, …}, …]); strata's columnar
// table adapts to/from this at the surface.

import { computeWindows, winLookup } from './windows.js';

export function applyRows(rowFn, outputColumns, rows, windowDefs) {
  const names = outputColumns.map((c) => c.name);
  const winResults = windowDefs && windowDefs.length ? computeWindows(windowDefs, rows) : null;
  const win = winResults ? (id, key) => winLookup(winResults, id, key) : () => null;

  const out = [];
  for (const row of rows) {
    const work = { ...row };                 // seed from input → unassigned columns pass through
    const ctx = { drop: false, exit: false, win };
    rowFn.run(work, ctx);
    if (!ctx.drop) {
      const projected = {};
      for (const n of names) projected[n] = n in work ? work[n] : null;
      out.push(projected);
    }
    if (ctx.exit) break;
  }
  return out;
}
