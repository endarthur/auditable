// @gcu/strata — auditable column-oriented table working model (base+overlay)
// Auto-generated from ext/strata/src/ — do not edit directly

// -- values.js --

// @gcu/strata — values: type coercion, the null vocabulary, display formatting.
//
// Shared by ingest (parsing source rows) and the provider (parsing edits) so a
// hand-typed value and an imported one travel the same path. Pure, zero-dep.

// Column types strata carries (a subset of @gcu/loom's CellType, by value — the
// provider hands these strings straight to loom). 'category' = a low-cardinality
// string (lithology, domain); 'string' = free text; 'number' = f64.
const COL_TYPES = ['number', 'category', 'string'];

// The mining/geoscience null vocabulary — a light mirror of recon's
// NULL_SENTINELS (the full set lives there; this covers the common tokens so
// strata's built-in sniffer path handles them without a recon dependency).
const NULL_TOKENS = new Set([
  '', 'na', 'n/a', 'nan', 'null', 'none', '-', '--',
  '-9999', '-99', '-1e32', '-1e+32', '1e32',
]);

// Coerce a raw string (from CSV or an edit) to a typed value, or null.
function coerceValue(raw, type) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || NULL_TOKENS.has(s.toLowerCase())) return null;
  if (type === 'number') {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return s;
}

// Faithful display text for a typed value. Numbers print at full precision
// (a data table shows the real datum — column-level precision formatting is a
// later, additive nicety); null → empty.
function fmtCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v);
}

// -- formula.js --

// @gcu/strata — formula: compile a derived-column expression to a per-row fn.
//
// strata-spec §5: formulas are JS/adder expressions over columns, not a bespoke
// spreadsheet language. v1 compiles a JS expression to a function via `new
// Function` — a controlled emission site (emit JS string + new Function, no AIR
// routing; AIR is a later perf swap). The formula's column DEPS are the schema
// column names it references; the row's values for those columns are bound as
// arguments, so `grade * tonnes` becomes `(grade, tonnes) => grade * tonnes`.
//
// SECURITY NOTE: a formula runs when its .strata opens — the same trust model as
// a notebook cell (your own document). Sandboxing formulas from UNTRUSTED .strata
// files is a deferred concern, flagged here so it isn't forgotten.
//
// Pure (new Function is available in any JS env; no DOM). Node-testable.

// A derived cell whose formula threw for that row. Carried as the cell value;
// the provider renders it as state:error. Not serialized (derived columns
// recompute on load), so a Symbol is fine.
const FORMULA_ERROR = Symbol('strata.formulaError');

// Identifiers in `formula` that match a known column name = the deps. Over-
// inclusion is harmless (an unused extra arg): a name appearing inside a string
// literal or as a property key may be picked up, but it only adds a bound arg.
function extractDeps(formula, columnNames) {
  const names = new Set(columnNames);
  const ids = String(formula).match(/[A-Za-z_$][\w$]*/g) || [];
  const deps = [];
  const seen = new Set();
  for (const id of ids) {
    if (names.has(id) && !seen.has(id)) { seen.add(id); deps.push(id); }
  }
  return deps;
}

// Compile a formula → { formula, deps, fn }. `fn(...depValues)` evaluates one
// row. Throws (with a clear message) on a syntax error; per-row runtime errors
// are caught by the caller and surfaced as FORMULA_ERROR.
function compileFormula(formula, columnNames) {
  const deps = extractDeps(formula, columnNames);
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...deps, `"use strict"; return (${formula});`);
  } catch (e) {
    throw new Error(`strata formula compile error in "${formula}": ${e.message}`);
  }
  return { formula, deps, fn };
}

// -- table.js --

// @gcu/strata — table: the in-memory working model (strata-spec §2 role 1, §4
// layers 1-3). An immutable typed-columnar BASE + a sparse value-patch OVERLAY +
// DERIVED columns (formula-defined, computed not stored); every read is
// base⊕overlay, derived columns recompute from it. This is the spine that makes
// strata auditable and non-destructive by construction: the source is never
// mutated, edits are an op log, a cell's base value is always recoverable, and
// derived columns carry their formula (not baked-in values).
//
// v1 scope: base + value patches + per-row derived columns. Deferred §4 layers:
// structural ops (tombstones/inserts/reorder), the view pipeline. Row identity =
// implicit ordinal (§4.1). Base columns are plain arrays (null-clean); typed-
// array packing is a windowing-era optimization.
//
// Pure (new Function for formulas works in any JS env; no DOM). Node-testable.



/**
 * @param {object} spec
 * @param {Array<{name,type,unit?,role?,analyte?}>} spec.schema  BASE column descriptors
 * @param {Array<Array>} spec.columns   per-column base arrays (length nrows)
 * @param {number} spec.nrows
 */
function createTable({ schema, columns, nrows }) {
  const nbase = columns.length;          // base columns occupy indices 0..nbase-1
  const overlay = new Map();             // 'r:c' → { value, base }   (base cells only)
  const derived = new Map();             // colIdx → { name, type, formula, deps, fn, cache }
  const key = (r, c) => r + ':' + c;

  // Read a cell's effective value by column index (base⊕overlay, or derived).
  function readValue(c, r, stack) {
    if (derived.has(c)) return derivedColumn(c, stack)[r];
    const k = key(r, c);
    return overlay.has(k) ? overlay.get(k).value : columns[c][r];
  }

  // Compute (and cache) a derived column. Lazy, with a cycle guard; a per-row
  // formula error becomes FORMULA_ERROR (rendered as state:error).
  function derivedColumn(c, stack) {
    const d = derived.get(c);
    if (d.cache) return d.cache;
    stack = stack || new Set();
    if (stack.has(c)) throw new Error(`strata: cyclic derived column "${d.name}"`);
    stack.add(c);
    const depIdx = d.deps.map((n) => schema.findIndex((s) => s.name === n));
    const out = new Array(nrows);
    for (let r = 0; r < nrows; r++) {
      const args = depIdx.map((ci) => readValue(ci, r, stack));
      try { out[r] = d.fn(...args); } catch { out[r] = FORMULA_ERROR; }
    }
    stack.delete(c);
    d.cache = out;
    return out;
  }

  // v1: invalidate ALL derived caches on any base edit (correct; recompute is
  // lazy on next read). Targeted dependent-only invalidation is a later
  // optimization that matters at scale, not at v1's small-data regime.
  function invalidateDerived() { for (const d of derived.values()) d.cache = null; }

  const t = {
    schema,
    nrows,
    get cols() { return schema.length; },
    get baseCount() { return nbase; },
    _base: columns,
    _overlay: overlay,

    isDerived(c) { return derived.has(c); },
    baseValue(r, c) { return columns[c][r]; },
    isEdited(r, c) { return overlay.has(key(r, c)); },

    // Merged read: { value, edited, base, derived? }.
    getCell(r, c) {
      if (derived.has(c)) return { value: derivedColumn(c)[r], edited: false, base: null, derived: true };
      const k = key(r, c);
      if (overlay.has(k)) { const o = overlay.get(k); return { value: o.value, edited: true, base: o.base }; }
      const v = columns[c][r];
      return { value: v, edited: false, base: v };
    },

    // Write a value patch (base columns only — derived cells are computed).
    setCell(r, c, value) {
      if (derived.has(c)) return;
      const k = key(r, c);
      const base = columns[c][r];
      if (value === base || (value == null && base == null)) overlay.delete(k);
      else overlay.set(k, { value, base });
      invalidateDerived();
    },

    revert(r, c) { overlay.delete(key(r, c)); invalidateDerived(); },
    dirtyCount() { return overlay.size; },

    // The effective values of column c as a fresh array (base⊕overlay, or the
    // derived computation). The bridge to the rest of the workspace.
    column(c) {
      if (derived.has(c)) return derivedColumn(c).slice();
      const out = columns[c].slice();
      for (const [k, o] of overlay) {
        const i = k.indexOf(':');
        if (Number(k.slice(i + 1)) === c) out[Number(k.slice(0, i))] = o.value;
      }
      return out;
    },

    columnByName(name) {
      const i = schema.findIndex((s) => s.name === name);
      return i < 0 ? null : this.column(i);
    },

    displayAt(r, c) {
      const v = this.getCell(r, c).value;
      return v === FORMULA_ERROR ? '#ERR' : fmtCell(v);
    },

    commitRaw(r, c, raw) { this.setCell(r, c, coerceValue(raw, schema[c].type)); },

    // Add a derived column: a JS formula over existing columns (base or earlier
    // derived). Appended after the existing columns; returns its index. Throws
    // on a formula syntax error.
    addDerivedColumn({ name, formula, type = 'number', unit }) {
      const { deps, fn } = compileFormula(formula, schema.map((s) => s.name));
      const field = { name, type, derived: true, formula };
      if (unit) field.unit = unit;
      schema.push(field);
      derived.set(schema.length - 1, { name, type, formula, deps, fn, cache: null });
      return schema.length - 1;
    },
  };
  return t;
}

// -- ingest.js --

// @gcu/strata — ingest: source adapters into the working model (strata-spec §6).
//
// v1: CSV/TSV → a typed StrataTable. Schema detection is recon-injectable: pass
// @gcu/recon's `sniff` for the rich path (roles, units, analytes — so an
// `Au_gpt` column arrives typed number with unit g/t and analyte Au), or omit it
// and strata uses a minimal built-in sniffer (delimiter + numeric/string only),
// so it ingests CSV standalone without a recon dependency. recon is *injected*,
// not imported — keeps strata zero-dep and lets a Works surface pass
// `(await load('@gcu/recon')).sniff`.
//
// Pure, zero-dep (beyond ./values, ./table).



// recon type → strata type. Generous matching (recon may say numeric/integer/
// float/categorical/text); unknown → string.
function mapReconType(t) {
  if (!t) return 'string';
  if (/num|int|float|real|double/i.test(t)) return 'number';
  if (/cat/i.test(t)) return 'category';
  return 'string';
}

// Normalize to \n, split, drop trailing blank lines.
function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// Pick the delimiter by counting candidates in the header line.
function detectCsvDelimiter(headerLine) {
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = -1;
  for (const d of cands) {
    const n = headerLine.split(d).length - 1;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

// Minimal schema sniffer (the recon-less fallback): delimiter + per-column
// number-vs-string inference over a sample.
function builtinSniff(lines) {
  const delimiter = detectCsvDelimiter(lines[0] || '');
  const header = (lines[0] || '').split(delimiter);
  const sample = lines.slice(1, 51);
  const columns = header.map((name, c) => {
    let numeric = true, saw = false;
    for (const ln of sample) {
      const v = ln.split(delimiter)[c];
      if (v == null || v.trim() === '') continue;
      saw = true;
      if (Number.isNaN(Number(v.trim()))) { numeric = false; break; }
    }
    return { name: name.trim(), type: saw && numeric ? 'number' : 'string' };
  });
  return { delimiter, columns };
}

/**
 * Parse CSV/TSV text into a StrataTable.
 * @param {string} text
 * @param {object} [opts]
 * @param {function} [opts.sniff]  @gcu/recon sniff(lines) → manifest. If given,
 *   used for delimiter + rich schema; else the built-in sniffer is used.
 * @param {number} [opts.sampleSize=200]  lines fed to the sniffer.
 */
function tableFromCsv(text, opts = {}) {
  const lines = splitLines(text);
  if (lines.length === 0) return createTable({ schema: [], columns: [], nrows: 0 });

  let delimiter, schema;
  if (typeof opts.sniff === 'function') {
    const sample = lines.slice(0, (opts.sampleSize || 200) + 1);
    const m = opts.sniff(sample);
    delimiter = m.delimiter || detectCsvDelimiter(lines[0]);
    schema = m.columns.map((col) => ({
      name: col.name,
      type: mapReconType(col.type),
      ...(col.unit ? { unit: col.unit } : {}),
      ...(col.role ? { role: col.role } : {}),
      ...(col.analyte ? { analyte: col.analyte } : {}),
    }));
  } else {
    const s = builtinSniff(lines);
    delimiter = s.delimiter;
    schema = s.columns.map((col) => ({ name: col.name, type: col.type }));
  }

  const ncols = schema.length;
  const columns = Array.from({ length: ncols }, () => []);
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter);
    for (let c = 0; c < ncols; c++) columns[c].push(coerceValue(cells[c], schema[c].type));
  }
  return createTable({ schema, columns, nrows: lines.length - 1 });
}

// -- view.js --

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

function createView(table) {
  let sort = null;     // { by: columnName, dir: 'asc' | 'desc' }
  let filter = null;   // { formula, fn, deps, depIdx } | null
  let rows = identity();

  function identity() { return Array.from({ length: table.nrows }, (_, i) => i); }
  function colIdx(name) { return table.schema.findIndex((s) => s.name === name); }

  function recompute() {
    let r = identity();
    if (filter) {
      r = r.filter((i) => {
        try { return !!filter.fn(...filter.depIdx.map((ci) => table.getCell(i, ci).value)); }
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
    get active() { return !!(sort || filter); },

    // Set/clear the sort. spec = { by: columnName, dir? } | null.
    setSort(spec) {
      sort = spec ? { by: spec.by, dir: spec.dir || 'asc' } : null;
      recompute();
    },

    // Set/clear the filter. formula = a boolean JS expression over columns, or
    // null. Throws on a compile (syntax) error so the caller can surface it;
    // per-row runtime errors just exclude the row.
    setFilter(formula) {
      if (!formula) { filter = null; recompute(); return; }
      const { deps, fn } = compileFormula(formula, table.schema.map((s) => s.name));
      filter = { formula, fn, deps, depIdx: deps.map(colIdx) };
      recompute();
    },

    // Re-run the pipeline against the table's CURRENT state (edits don't
    // auto-re-sort/filter; this is the explicit re-apply, §4.3 #4).
    reapply() { recompute(); },
  };
}

// -- aggregate.js --

// @gcu/strata — aggregate: group-by + aggregation (strata-spec §5 aggregate cells).
//
// groupBy(table, { by, aggs }, rowIndices?) → a fresh summary StrataTable: one
// row per distinct key tuple, with aggregate columns. The result IS a table, so
// it flows through the rest of strata unchanged — view it in loom, save it as
// .strata, chart it, group it again (the §7.2 "promotable: selection → … → a new
// table" idea, here for aggregation). Operates over EFFECTIVE values (base⊕
// overlay, derived computed); pass `view.rows()` as rowIndices to aggregate the
// currently filtered set.
//
// v1 = single in-memory pass (the small-data fast path). Streaming group-by over
// @gcu/sluice accumulators (welford/t-digest) for big data is the deferred §4.3
// pipeline path — same engine, different host.
//
// Pure, zero-dep (beyond ./table). Node-testable.


// Aggregation ops. count needs no column; the rest skip non-numeric/null values
// (so a sum over a column with gaps is the sum of what's there, not NaN).
const OPS = {
  count: { needsCol: false, init: () => 0, step: (a) => a + 1, fin: (a) => a },
  sum: { needsCol: true, init: () => ({ s: 0, any: false }),
    step: (a, v) => { if (typeof v === 'number') { a.s += v; a.any = true; } return a; },
    fin: (a) => (a.any ? a.s : null) },
  mean: { needsCol: true, init: () => ({ s: 0, n: 0 }),
    step: (a, v) => { if (typeof v === 'number') { a.s += v; a.n++; } return a; },
    fin: (a) => (a.n ? a.s / a.n : null) },
  min: { needsCol: true, init: () => ({ m: null }),
    step: (a, v) => { if (typeof v === 'number' && (a.m === null || v < a.m)) a.m = v; return a; },
    fin: (a) => a.m },
  max: { needsCol: true, init: () => ({ m: null }),
    step: (a, v) => { if (typeof v === 'number' && (a.m === null || v > a.m)) a.m = v; return a; },
    fin: (a) => a.m },
};

const AGG_OPS = Object.keys(OPS);

/**
 * @param {object} table   a StrataTable
 * @param {object} spec     { by: name|name[], aggs: [{ op, col?, as? }] }
 * @param {number[]} [rowIndices]  rows to aggregate (default: all). Pass
 *   view.rows() to aggregate the filtered set.
 * @returns {object} a new summary StrataTable (key columns + aggregate columns)
 */
function groupBy(table, spec, rowIndices) {
  const by = Array.isArray(spec.by) ? spec.by : [spec.by];
  const keyIdx = by.map((n) => table.schema.findIndex((s) => s.name === n));
  if (keyIdx.some((i) => i < 0)) throw new Error('groupBy: unknown key column');

  const aggs = spec.aggs.map((a) => {
    if (!OPS[a.op]) throw new Error(`groupBy: unknown op "${a.op}"`);
    if (OPS[a.op].needsCol && a.col == null) throw new Error(`groupBy: op "${a.op}" needs a column`);
    const colIdx = a.col != null ? table.schema.findIndex((s) => s.name === a.col) : -1;
    if (a.col != null && colIdx < 0) throw new Error(`groupBy: unknown column "${a.col}"`);
    return { op: a.op, colIdx, as: a.as || (a.col ? `${a.op}_${a.col}` : a.op) };
  });

  const rows = rowIndices || Array.from({ length: table.nrows }, (_, i) => i);

  // Single pass: bucket rows by key tuple (insertion-ordered), accumulate.
  const groups = new Map();
  const order = [];
  for (const r of rows) {
    const keyVals = keyIdx.map((ci) => table.getCell(r, ci).value);
    const keyStr = JSON.stringify(keyVals);
    let g = groups.get(keyStr);
    if (!g) { g = { keyVals, accs: aggs.map((a) => OPS[a.op].init()) }; groups.set(keyStr, g); order.push(keyStr); }
    for (let i = 0; i < aggs.length; i++) {
      const v = aggs[i].colIdx >= 0 ? table.getCell(r, aggs[i].colIdx).value : undefined;
      g.accs[i] = OPS[aggs[i].op].step(g.accs[i], v);
    }
  }

  // Result schema: key columns (copied, unit preserved) + aggregate columns
  // (number; sum/mean/min/max inherit the source column's unit, count is unitless).
  const schema = [];
  for (const ci of keyIdx) {
    const s = table.schema[ci];
    schema.push({ name: s.name, type: s.type, ...(s.unit ? { unit: s.unit } : {}) });
  }
  for (const a of aggs) {
    const srcUnit = a.colIdx >= 0 && a.op !== 'count' ? table.schema[a.colIdx].unit : undefined;
    schema.push({ name: a.as, type: 'number', ...(srcUnit ? { unit: srcUnit } : {}) });
  }

  const columns = schema.map(() => []);
  for (const keyStr of order) {
    const g = groups.get(keyStr);
    let c = 0;
    for (let k = 0; k < keyIdx.length; k++) columns[c++].push(g.keyVals[k]);
    for (let i = 0; i < aggs.length; i++) columns[c++].push(OPS[aggs[i].op].fin(g.accs[i]));
  }

  return createTable({ schema, columns, nrows: order.length });
}

// -- document.js --

// @gcu/strata — document: the native `.strata` file (strata-spec §3).
//
// A `.strata` is a DOCUMENT, not a data format: a zip (sibling of .gcudat/
// .gcupkg, via @gcu/archive) holding the data PLUS its schema, units, the
// overlay, and provenance — things Arrow/CSV have nowhere to put. v1 is role-2
// (small/medium, rewrite-whole — no chunking), so the base is materialized and
// self-contained.
//
//   table.strata (zip)
//     document.json    { strata, name, created, rowCount, colCount, columns[], view? }
//     schema.json      { fields: [{ name, type, unit?, role?, analyte? }] }  ← Frictionless-shaped
//     columns.json     { <name>: [base values…] }          ← the immutable base
//     overlay.json     { "r:c": { value, base }, … }        ← the value-patch stack (§4)
//     provenance.json  { created, source?, edits }          ← v1: minimal
//
// GROWABLE BY DESIGN: each column carries an `encoding` in document.json's
// `columns[]` manifest. v1 writes/reads only `'json'`, but the read path
// dispatches on it, so a v2 `'f64'` typed-.bin column (the windowing-era packing)
// drops in alongside JSON columns and they round-trip together. The format
// version (`strata: N`) gates breaking changes.
//
// @gcu/archive is INJECTED (createWriter for write, readZip for read), not
// imported — strata stays zero-dep; a surface passes `await load('@gcu/archive')`.


const STRATA_VERSION = 1;

function jsonBytes(obj) { return new TextEncoder().encode(JSON.stringify(obj)); }

/**
 * Serialize a StrataTable to `.strata` zip bytes.
 * @param {object} table
 * @param {object} opts
 * @param {function} opts.createWriter  @gcu/archive createWriter (required)
 * @param {string}   [opts.name]        document name
 * @param {string}   [opts.created]     ISO timestamp (defaults to now)
 * @param {string}   [opts.source]      provenance: where the data came from
 * @param {object}   [opts.view]        view config (sort/filter) — reserved
 * @returns {Promise<Uint8Array>}
 */
async function writeStrata(table, opts = {}) {
  const { createWriter } = opts;
  if (typeof createWriter !== 'function') {
    throw new Error('writeStrata: opts.createWriter (@gcu/archive) is required');
  }
  const created = opts.created || new Date().toISOString();

  // Derived columns are computed-not-stored: they carry `encoding: 'derived'`
  // (no payload) and their formula travels in schema.json, recomputing on load.
  const columnsManifest = table.schema.map((s) => ({ name: s.name, encoding: s.derived ? 'derived' : 'json' }));
  const document = {
    strata: STRATA_VERSION,
    name: opts.name || 'untitled',
    created,
    rowCount: table.nrows,
    colCount: table.cols,
    columns: columnsManifest,
  };
  if (opts.view) document.view = opts.view;

  // BASE columns only (not merged, not derived) — the overlay is stored
  // separately so base⊕overlay reconstitutes losslessly on load.
  const columns = {};
  for (let c = 0; c < table.cols; c++) {
    if (table.schema[c].derived) continue;
    columns[table.schema[c].name] = table._base[c];
  }

  const overlay = {};
  for (const [k, o] of table._overlay) overlay[k] = { value: o.value, base: o.base };

  const provenance = {
    created,
    ...(opts.source ? { source: opts.source } : {}),
    edits: Object.keys(overlay).length,
  };

  const w = createWriter('memory', { format: 'zip' });
  await w.addFile('document.json', jsonBytes(document));
  await w.addFile('schema.json', jsonBytes({ fields: table.schema }));
  await w.addFile('columns.json', jsonBytes(columns));
  await w.addFile('overlay.json', jsonBytes(overlay));
  await w.addFile('provenance.json', jsonBytes(provenance));
  return w.close();
}

/**
 * Parse `.strata` zip bytes back into a StrataTable.
 * @param {Uint8Array} bytes
 * @param {object} opts
 * @param {function} opts.readZip  @gcu/archive readZip(bytes, innerPath) (required)
 * @returns {{ table: object, document: object }}
 */
function readStrata(bytes, opts = {}) {
  const { readZip } = opts;
  if (typeof readZip !== 'function') {
    throw new Error('readStrata: opts.readZip (@gcu/archive) is required');
  }
  const dec = new TextDecoder();
  const readJson = (name) => { const b = readZip(bytes, name); return b ? JSON.parse(dec.decode(b)) : null; };

  const document = readJson('document.json');
  if (!document || !document.strata) throw new Error('readStrata: not a .strata document');
  if (document.strata > STRATA_VERSION) {
    throw new Error(`readStrata: document format v${document.strata} is newer than this build (v${STRATA_VERSION})`);
  }

  const schema = (readJson('schema.json') || { fields: [] }).fields;
  const colsRaw = readJson('columns.json') || {};

  // Build the BASE table first (derived columns reconstruct from their formula).
  const baseFields = schema.filter((s) => !s.derived);
  const columns = baseFields.map((s) => {
    const m = (document.columns || []).find((x) => x.name === s.name);
    if (m && m.encoding && m.encoding !== 'json' && m.encoding !== 'derived') {
      // GROWTH SEAM (v2): m.encoding === 'f64' →
      //   new Float64Array(readZip(bytes, `columns/${m.name}.bin`).buffer) → Array
      throw new Error(`readStrata: column encoding '${m.encoding}' not supported in this build`);
    }
    return colsRaw[s.name] || [];
  });

  const table = createTable({ schema: baseFields, columns, nrows: document.rowCount });

  // Reconstitute derived columns in their original (post-base) order, so a
  // derived-on-derived formula sees its inputs already present.
  for (const s of schema) {
    if (s.derived) table.addDerivedColumn({ name: s.name, formula: s.formula, type: s.type, unit: s.unit });
  }

  // Reapply the value-patch overlay. setCell recomputes base from the freshly
  // loaded columns (identical to the stored base), so a patch equal to base
  // self-clears — exactly the live-edit semantics.
  const overlay = readJson('overlay.json') || {};
  for (const k of Object.keys(overlay)) {
    const i = k.indexOf(':');
    table.setCell(Number(k.slice(0, i)), Number(k.slice(i + 1)), overlay[k].value);
  }

  return { table, document };
}

// -- provider.js --

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
function createTableProvider(table, view) {
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

export {
  AGG_OPS,
  COL_TYPES,
  FORMULA_ERROR,
  NULL_TOKENS,
  builtinSniff,
  coerceValue,
  compileFormula,
  createTable,
  createTableProvider,
  createView,
  detectCsvDelimiter,
  extractDeps,
  fmtCell,
  groupBy,
  readStrata,
  tableFromCsv,
  writeStrata,
};
