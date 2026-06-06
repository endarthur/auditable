// @gcu/over — the driver. Runs a compiled row function over a record stream,
// applying the stream concerns: `delete` drops the row, `exit` stops the stream,
// and the resolved output columns (from the schema pass) project the result. When
// the transform has window aggregates, a first pass computes them per group
// (ctx.win) before the row pass.
//
// v0 table shape = an array of row objects ([{FE:62, …}, …]); strata's columnar
// table adapts to/from this at the surface.

import { computeWindows, winLookup } from './windows.js';
import { buildLookups, makeLookup, hasLookups } from './lookup.js';

const NO_WIN = () => null;

export function applyRows(rowFn, outputColumns, rows, windowDefs, lookupDefs, tables) {
  const names = outputColumns.map((c) => c.name);
  const winResults = windowDefs && windowDefs.length ? computeWindows(windowDefs, rows) : null;
  // build the lookup indexes once (hash, or per-eq-key sorted intervals) per the
  // analyzed predicate shape, before the row pass.
  const lookup = hasLookups(lookupDefs) ? makeLookup(buildLookups(lookupDefs, tables || {})) : NO_WIN;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const work = { ...rows[i] };             // seed from input → unassigned columns pass through
    // ctx.win carries the row index so ordered (running) windows resolve per-row.
    const win = winResults ? (id, key) => winLookup(winResults, id, key, i) : NO_WIN;
    const ctx = { drop: false, exit: false, win, lookup };
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
