# @gcu/strata

An auditable, reactive, column-oriented table — the data-analysis model behind
the strata surface, usable standalone.

- **Immutable base + value-patch overlay** — the source is never mutated; edits
  are a sparse op log, every cell's original value is recoverable, dirty/undo/
  provenance fall out of one mechanism
- **Reactive derived columns** — JS formulas over other columns (`grade *
  tonnes`), computed not stored, recomputed on edit, cycle-guarded
- **Sort / filter view pipeline** — filter is a boolean formula (same engine as
  derived columns); single-column stable sort, nulls-last; edits don't
  auto-re-sort (explicit re-apply)
- **Group-by aggregation** — `count`/`sum`/`mean`/`min`/`max` → a *new* table you
  can view, derive on, save, or group again; units propagate
- **Native `.strata` document** — a zip (schema + base columns + overlay +
  provenance) via `@gcu/archive`; growable per-column encoding
- **Ingest anything tabular** — `tableFromCsv` is `@gcu/recon`-injectable (rich
  roles/units/analytes) with a built-in sniffer fallback
- **Renders via [`@gcu/loom`](../loom)** — `createTableProvider` adapts the model
  to the loom grid; the model has zero DOM and is fully node-testable
- Pure vanilla JS, single ES module, zero *hard* deps (recon/archive are injected)

`@gcu/strata` is part of the [Auditable](https://github.com/endarthur/auditable)
ecosystem. Geoscience-grade: drillhole/assay/blockmodel data is tabular, and the
overlay spine makes edits non-destructive and auditable by construction.

## Why?

Excel's power is its curse: any value anywhere, an invisible dependency graph,
errors that hide forever, a silo that dies past ~1M rows. strata inverts each.
The load-bearing idea is the **overlay**: a table is an immutable base plus a
stack of patches, and the grid renders the *merge*. One mechanism gives you
non-destructive editing, undo, dirty/flush, provenance, and what-if scenarios —
by construction, not bolted on. Formulas are real JS expressions (the same ones
you'd write in a notebook cell), not a bespoke spreadsheet language. The model is
pure and streaming-shaped, so it scales from a hand-edited parameters sheet to a
windowed million-row block model.

## Installation

```bash
npm install @gcu/strata
```

## Quickstart

```js
import {
  tableFromCsv, createTableProvider, createView, groupBy,
  writeStrata, readStrata,
} from '@gcu/strata';
import { createGrid } from '@gcu/loom';
import { sniff } from '@gcu/recon';                 // optional: rich schema
import { createWriter, readZip } from '@gcu/archive';

// Ingest CSV → a typed table (recon detects Au_gpt → number, unit g/t, analyte Au)
const table = tableFromCsv(csvText, { sniff });

// A reactive derived column
table.addDerivedColumn({ name: 'metal', formula: 'grade * tonnes', unit: 'kg' });

// Render it
const view = createView(table);
const grid = createGrid(el, createTableProvider(table, view), { theme: 'dark' });

// Filter + sort (the view; the grid renders through it)
view.setFilter('grade > 2 && domain == "ox"');
view.setSort({ by: 'grade', dir: 'desc' });

// Group-by → a fresh summary table
const summary = groupBy(table, {
  by: 'domain',
  aggs: [{ op: 'count', as: 'n' }, { op: 'mean', col: 'grade' }],
}, view.rows());                                    // aggregate the FILTERED set

// Save / load the native document
const bytes = await writeStrata(table, { createWriter, name: 'assays' });
const { table: reopened } = readStrata(bytes, { readZip });
```

## The model — `createTable`

```js
const t = createTable({ schema, columns, nrows });
//   schema  : [{ name, type, unit?, role?, analyte? }]   (base columns)
//   columns : per-column base arrays (length nrows)
//   type    : 'number' | 'category' | 'string'

t.getCell(r, c)        // { value, edited, base, derived? } — the base⊕overlay merge
t.setCell(r, c, value) // write a value patch (base cells only; editing back to base clears it)
t.baseValue(r, c)      // the immutable source value, ignoring patches
t.isEdited(r, c) / t.revert(r, c) / t.dirtyCount()
t.column(c) / t.columnByName(name)   // effective (merged) column as a fresh array
t.commitRaw(r, c, raw)               // coerce a raw string by the column's type, then setCell
t.addDerivedColumn({ name, formula, type?, unit? })   // a computed column; returns its index
t.schema / t.nrows / t.cols / t.baseCount / t.isDerived(c)
```

The base array is **never mutated** — `_base[c]` always holds the source; the
overlay (`'r:c' → {value, base}`) holds the edits. Row identity is the implicit
ordinal (the base never reorders, so its ids are free).

## Derived columns & formulas

A formula is a JS expression over column names, compiled via `new Function`:

```js
import { compileFormula, FORMULA_ERROR } from '@gcu/strata';

const { deps, fn } = compileFormula('grade * tonnes', columnNames);
// deps = the column names referenced; fn(...depValues) evaluates one row
```

Derived columns are **computed, not stored** — the `.strata` carries the formula,
not the data, and recomputes on load. A per-row eval error becomes the
`FORMULA_ERROR` sentinel (rendered `#ERR`). Derived cells are read-only.
Derived-on-derived chains; true cycles can't form through the API (deps fix at
add time, no forward refs).

> A formula runs when its `.strata` opens — the same trust as a notebook cell.
> Sandboxing formulas from *untrusted* documents is a deferred concern.

## The view — sort / filter

```js
const v = createView(table);
v.setFilter('grade > 2')        // a boolean formula; throws on a syntax error
v.setSort({ by: 'grade', dir: 'desc' })   // stable, nulls-last
v.reapply()                     // edits don't auto-re-sort; this is the explicit re-apply
v.rows()  / v.length / v.at(displayRow) / v.active / v.sortSpec / v.filterFormula
```

`createTableProvider(table, view)` makes loom render *through* the view: display
rows map to underlying rows, row headers show the underlying base number, commits
map back. The table stays the single source of truth; loom needs no view
awareness.

## Group-by — `groupBy`

```js
groupBy(table, { by, aggs }, rowIndices?) → a new summary StrataTable
//   by   : name | name[]        (multi-key, insertion-ordered groups)
//   aggs : [{ op, col?, as? }]  op ∈ AGG_OPS = ['count','sum','mean','min','max']
//   rowIndices : default all; pass view.rows() to aggregate the filtered set
```

The result *is* a `StrataTable`, so it composes — view it, derive on it, save it,
group it again. `sum`/`mean`/`min`/`max` skip non-numeric/null and inherit the
source column's unit; `count` is unitless.

## The `.strata` document

```js
const bytes = await writeStrata(table, { createWriter, name?, source?, view? });
const { table, document } = readStrata(bytes, { readZip });
```

A zip (`@gcu/archive`, injected): `document.json` (manifest) + `schema.json`
(Frictionless-shaped `fields[]`) + `columns.json` (base, materialized) +
`overlay.json` (the patch stack) + `provenance.json`. Per-column `encoding` in
the manifest makes the format **growable** — v1 reads/writes `json` columns, a v2
`f64` typed-`.bin` mode coexists. The `strata:N` version gates breaking changes.

## Ingest

```js
tableFromCsv(text, { sniff?, sampleSize? })   // sniff = @gcu/recon's sniff (optional)
builtinSniff(lines)                           // the recon-less fallback (delimiter + number/string)
detectCsvDelimiter(headerLine)
```

With recon injected you get roles (`coord-x`, `id`), units (`g/t`, `%`), and
analytes (`Au`); without it, a minimal numeric/string sniffer. recon is
*injected, not imported* — strata stays zero-dep.

## Build, test

```bash
node ext/strata/build.js           # bundle src/ → index.js
node --test test/strata.test.mjs   # 37 tests (model, formula, view, group-by, .strata round-trip)
```

`ext/strata/demo.html` loads `examples/data/blockmodel-sample.csv` (serve over
http).

## Limitations (v1)

Deliberate scope; the design (`spec_inbox/strata-spec.md`) tracks the full vision:

- **In-memory only.** Streaming/windowing over `@gcu/sluice` + `@gcu/proc` (for
  tens-of-millions of rows) is the deferred big-data path; v1 loads the table.
- **Value-patch overlay only.** Structural ops (insert/delete/reorder rows at
  scale) are §4 layers not yet built.
- **Single-column sort; per-row formulas.** Multi-key sort and aggregate-cell
  formulas (`sum(grade)` inline) are follow-ups.
- **`json` column payload.** Typed `.bin` packing arrives with the windowing path.
- **Units carry but don't compute.** Unit-aware arithmetic is v2.

## Versioning

Pre-1.0: the model API and `.strata` format may change on minor bumps. The
overlay model and the document's version-gated growable encoding are the
load-bearing commitments.

## License

MIT — see [LICENSE](../../LICENSE).

## Author

Arthur Endlein Correia / [Geoscientific Chaos Union](https://gentropic.org)
