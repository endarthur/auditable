// @gcu/strata — transform: run an OVER transform over a StrataTable, producing a
// NEW StrataTable (the same shape `groupBy` returns — a result you can view, save,
// derive on, or transform again).
//
// OVER (@gcu/over) is the whole-table declarative verb — map/filter/project + windows
// + joins + check/require + units — to strata's per-column JS formulas (formula.js).
// strata-extra-spec is its origin; this is the wiring that fulfills it. The two share
// the load-bearing invariant: the output SCHEMA is resolved before any row runs.
//
// `compile` is INJECTED (strata stays zero-hard-dep, exactly like recon/archive) — the
// caller passes @gcu/over's `compile`. Pure / node-testable; this module only marshals
// the columnar model ↔ OVER's row objects.

import { createTable } from './table.js';

// strata type ↔ OVER vtype. strata carries number/category/string; OVER's richer set
// collapses back to those (int/float/bool → number).
const TYPE_TO_OVER = { number: 'float', category: 'category', string: 'string' };
const OVER_TO_TYPE = { int: 'number', float: 'number', bool: 'number', string: 'string', category: 'category', dynamic: 'string' };

// StrataTable → array of row objects (merged base⊕overlay; derived columns computed).
function tableToRows(table) {
  const names = table.schema.map((s) => s.name);
  const cols = names.map((_, c) => table.column(c));
  const rows = new Array(table.nrows);
  for (let r = 0; r < table.nrows; r++) {
    const o = {};
    for (let c = 0; c < names.length; c++) o[names[c]] = cols[c][r];
    rows[r] = o;
  }
  return rows;
}

// strata schema → OVER inputSchema (types + units), so OVER resolves the output schema
// and checks units up front (the auditable win).
function tableToInputSchema(table) {
  return table.schema.map((s) => {
    const f = { name: s.name, type: TYPE_TO_OVER[s.type] || 'dynamic' };
    if (s.unit) f.unit = s.unit;
    return f;
  });
}

// Reference tables for OVER's lookup/join — accept StrataTables or plain row arrays.
function refTables(tables) {
  if (!tables) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(tables)) out[k] = (v && v.schema && typeof v.column === 'function') ? tableToRows(v) : v;
  return out;
}

function requireCompile(opts) {
  if (typeof opts.compile !== 'function') throw new Error('strata transform: inject @gcu/over `compile` via opts.compile');
  return opts.compile;
}

// Resolve the output schema WITHOUT running — strata's static-schema preview (column
// list + warnings), for showing a transform's result shape before it executes.
export function previewOverTransform(table, overSource, opts = {}) {
  const c = requireCompile(opts)(overSource, { inputSchema: tableToInputSchema(table) });
  return { columns: c.outputColumns, warnings: c.warnings || [], windows: c.windows, lookups: c.lookups, joins: c.joins, checks: c.checks };
}

// Run the transform → { table, columns, checks, warnings }. `table` is a fresh
// StrataTable; `checks`/`warnings` are OVER's report (surface them in the UI). A
// failing `require` propagates OVER's throw (the gate) — catch it for the report.
export function transformWithOver(table, overSource, opts = {}) {
  const c = requireCompile(opts)(overSource, { inputSchema: tableToInputSchema(table) });
  const res = c.run(tableToRows(table), refTables(opts.tables));

  // carry unit/role/analyte forward for passthrough (same-named) columns; new/derived
  // columns get name+type only (proper output units await the @gcu/dimensions
  // convergence — strata's unit model and OVER's aren't unified yet).
  const inByName = new Map(table.schema.map((s) => [s.name, s]));
  const schema = res.columns.map((col) => {
    const field = { name: col.name, type: OVER_TO_TYPE[col.vtype] || 'string' };
    const src = inByName.get(col.name);
    if (src) { if (src.unit) field.unit = src.unit; if (src.role) field.role = src.role; if (src.analyte) field.analyte = src.analyte; }
    return field;
  });

  const nrows = res.rows.length;
  const columns = res.columns.map((col) => {
    const out = new Array(nrows);
    for (let r = 0; r < nrows; r++) {
      let v = res.rows[r][col.name];
      if (v === undefined || (typeof v === 'number' && v !== v)) v = null;   // OVER NaN (numeric absent) → strata null
      out[r] = v;
    }
    return out;
  });

  return { table: createTable({ schema, columns, nrows }), columns: res.columns, checks: res.checks || [], warnings: res.warnings || [] };
}
