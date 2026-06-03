// @gcu/strata — view: the sort/filter pipeline over a table (strata-spec §4.3).
//
// The view is the read-side pipeline — `filter → sort → window` over base⊕overlay
// — producing an ordered list of underlying row indices. A view-aware provider
// renders through it, so loom stays unchanged and the table+overlay stays the
// single source of truth (display-row → underlying-row is the only mapping).
//
// Unifications, per the spec:
//   • FILTER is a boolean formula over columns, compiled by the SAME engine as
//     derived columns (formula.js). "filter to grade>2" and a future "select
//     grade>2" are the same row-expr (§7.2) — one language for filter, derived
//     columns, and (later) selection-as-predicate.
//   • SORT is single-column for v1 (stable, nulls-last); multi-key later.
//
// v1 = in-memory (the small-data fast path, the 95% case). The big-data path —
// a materialized sorted copy via a proc/sluice pipeline — is the deferred §4.3
// follow-up. Edits do NOT auto-re-sort/filter (§4.3 #4): the view is a snapshot;
// reapply() is explicit. Out-of-order flagging is an additive nicety on top.
//
// Pure (formula compile via formula.js; no DOM). Node-testable.

import { parsePredicate, evaluatePredicate } from './predicate.js';

// Compare two non-null values: numbers numerically, else lexical.
function cmpVal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Full comparator with direction. Nulls sort LAST regardless of dir (so they
// don't flip to the top on a descending sort).
function cmp(a, b, dir) {
  const an = a == null, bn = b == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return dir * cmpVal(a, b);
}

export function createView(table) {
  let sort = null;     // { by: columnName, dir: 'asc' | 'desc' }
  let filter = null;   // { formula, pred } | null  — pred = the structured predicate spec
  let rows = identity();

  function identity() { return Array.from({ length: table.nrows }, (_, i) => i); }
  function colIdx(name) { return table.schema.findIndex((s) => s.name === name); }

  function recompute() {
    let r = identity();
    if (filter) {
      const nameIdx = new Map(table.schema.map((s, k) => [s.name, k]));
      r = r.filter((i) => {
        const get = (name) => { const ci = nameIdx.get(name); return ci === undefined ? undefined : table.getCell(i, ci).value; };
        try { return evaluatePredicate(filter.pred, get); }
        catch { return false; } // a per-row eval error excludes the row
      });
    }
    if (sort) {
      const ci = colIdx(sort.by);
      const dir = sort.dir === 'desc' ? -1 : 1;
      r = r.slice().sort((a, b) => cmp(table.getCell(a, ci).value, table.getCell(b, ci).value, dir));
    }
    rows = r;
  }

  return {
    get length() { return rows.length; },
    at(displayRow) { return rows[displayRow]; },
    rows() { return rows.slice(); },

    get sortSpec() { return sort; },
    get filterFormula() { return filter ? filter.formula : null; },
    get filterPredicate() { return filter ? filter.pred : null; }, // the structured spec (for the selection bus)
    get active() { return !!(sort || filter); },

    // Set/clear the sort. spec = { by: columnName, dir? } | null.
    setSort(spec) {
      sort = spec ? { by: spec.by, dir: spec.dir || 'asc' } : null;
      recompute();
    },

    // Set/clear the filter. formula = a boolean expression over columns (a
    // JS-flavoured subset), or null. Parsed to a structured predicate spec (safe,
    // bus-portable — never new Function); throws on disallowed syntax so the
    // caller can surface it. Per-row eval errors just exclude the row. Full-JS
    // logic lives in derived columns; filter on the derived flag.
    setFilter(formula) {
      if (!formula) { filter = null; recompute(); return; }
      const pred = parsePredicate(formula);
      filter = { formula, pred };
      recompute();
    },

    // Re-run the pipeline against the table's CURRENT state (edits don't
    // auto-re-sort/filter; this is the explicit re-apply, §4.3 #4).
    reapply() { recompute(); },
  };
}
