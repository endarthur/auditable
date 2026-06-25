// @gcu/lamina — calculated columns: read-time derived columns appended to a record
// source. NEVER materialized, never written — exactly the strata derived-column
// precedent, but over lamina's windowed/never-resident scan. Two decorators mirror
// the two consumers: the CURSOR (filter/sort/stats + result views) and the BROWSE
// VIEW (the unfiltered grid).
//
// `calcs`: [{ name, type, fn }] where `fn(fieldsSoFar) => value` is precompiled by
// the caller (e.g. @gcu/expr's compile against [...baseColumns, ...calcNames]) — so
// @gcu/lamina stays expression-engine-agnostic. The fn indexes into the FULL
// extended field array, so a calc may reference base columns AND earlier calc
// columns; they're computed left-to-right (a forward reference reads undefined →
// the engine's blank). `baseCount` = the number of base columns.

import { LOADING } from './viewsource.js';

// Append RAW calc values (numbers stay numbers) — for the scan path, where
// filter/sort/stats want exact values.
function extendRaw(base, calcs) {
  const out = base.slice();
  for (const c of calcs) out.push(c.fn(out));
  return out;
}
// Append STRINGIFIED calc values — for the display path (the loom provider writes
// row[c] straight into the cell text, like every other lamina field).
function extendDisp(base, calcs) {
  const out = base.slice();
  for (const c of calcs) { const v = c.fn(out); out.push(v == null ? '' : String(v)); }
  return out;
}

// Decorate a record cursor (cursor.js / a backing adapter): eachRecord yields the
// extended raw fields; readByLoc yields the extended display fields. Everything
// else passes through. Empty calcs → the source unchanged.
export function withCalcCursor(source, baseCount, calcs) {
  if (!calcs || !calcs.length) return source;
  return {
    ...source,
    eachRecord: (opts, visit) => source.eachRecord(opts, (disp, fields, l0, l1) => visit(disp, extendRaw(fields, calcs), l0, l1)),
    readByLoc: async (l0, l1) => extendDisp(await source.readByLoc(l0, l1), calcs),
  };
}

// Decorate a browse ViewSource (createRecordViewSource / createDmViewSource):
// rowAt appends the calc fields (display), cols/header/colType extend. LOADING /
// null pass through untouched so windowing still works.
export function withCalcView(vs, baseCount, calcs) {
  if (!calcs || !calcs.length) return vs;
  const cols = baseCount + calcs.length;
  const dec = {
    kind: vs.kind, cols, schema: vs.schema,
    rowCount() { return vs.rowCount(); },
    rowAt(r) { const row = vs.rowAt(r); return (row === LOADING || row == null) ? row : extendDisp(row, calcs); },
    async ensureRow(r) { await vs.ensureRow(r); return dec.rowAt(r); },
    header(c) { return c < baseCount ? vs.header(c) : { label: calcs[c - baseCount].name, type: calcs[c - baseCount].type || 'string', calc: true }; },
    colType(c) { return c < baseCount ? vs.colType(c) : (calcs[c - baseCount].type || 'string'); },
    onReady(cb) { return vs.onReady(cb); },
  };
  if (vs.rowHeaderAt) dec.rowHeaderAt = (r) => vs.rowHeaderAt(r);   // a result view reports the original row #
  return dec;
}
