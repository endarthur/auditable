# @gcu/strata

**An auditable, reactive, column-oriented table: an immutable base + a value-patch overlay, reactive derived columns, a sort/filter view pipeline, group-by, and a native zip document.**

`@gcu/strata` is the data-analysis model behind the strata surface — "our own
Excel" on GCU principles: reactive, auditable, non-destructive, geoscience-grade,
composable. It holds typed columnar data, edits it without ever mutating the
source, computes in real JS, and persists to a self-describing `.strata`
document. The model is pure (zero DOM) and renders through
[`@gcu/loom`](../loom).

| Field   | Value                                                       |
|---------|-------------------------------------------------------------|
| Version | 0.2 (2026-06; undo/redo, column ops, validation over the 0.1 model) |
| Status  | Pre-1.0                                                     |
| License | MIT                                                        |
| Owner   | endarthur                                                   |
| Lineage | Delta Lake / Iceberg deletion-vectors (overlay); Frictionless Data Package (schema); the GCU `.gcudat`/`.gcupkg` zip-document family |

> This is the **shipped-v0.1** spec — what the library actually implements and
> the format contract. The full design (windowing, streaming, the big-data view
> pipeline, selection-as-predicate) lives in the private design draft
> `spec_inbox/strata-spec.md`; section references (§N) point there.

---

## Lineage

The overlay model is the data-lake pattern at cell granularity: never rewrite the
columnar base, keep a sparse delta, merge on read (Delta Lake / Iceberg
deletion-vectors; `@gcu/vfs` `OverlayBackend` is the same idea at the filesystem
layer). The schema shape follows Frictionless Data Package (`fields[{name,type,…}]`)
plus `x-`-style extensions (unit/role/analyte/formula). The native document is a
sibling of the GCU zip-document family (`.gcudat`/`.gcupkg`/`.gcudsk`).

## Premise

A table is **an immutable base + a stack of overlays**; the grid renders the
merge. That single data model makes strata auditable, non-destructive, and
scenario-capable *by construction*, and collapses six problems into one
mechanism: editing immutable data (patch, don't rewrite), undo/redo (the overlay
is the op log), dirty/flush (overlay = unsaved delta), provenance (every patch
keeps the base value), what-if scenarios (branch overlays), and multi-window
(broadcast overlay ops). Formulas are JS, not a spreadsheet dialect, so logic
moves between table and notebook with zero translation.

## Data model

```
table = createTable({ schema, columns, nrows })

  base     : columns[c][r]                 — immutable; never mutated
  overlay  : Map('r:c' → { value, base })  — sparse value patches (base cells only)
  derived  : Map(colIdx → { formula, deps, fn, cache })  — computed, not stored
  checks   : [{ name, formula, pred }]     — validation rules (sift predicates that MUST hold)
  schema   : [{ name, type, unit?, role?, analyte?, derived?, formula? }]
```

- **Undo/redo** (v0.2): the overlay *is* the op-log. `setCell`/`revert` record a
  before/after group; `beginTxn`/`endTxn` collapse a batch (paste/fill/range-delete)
  into ONE undo step; `undo`/`redo`/`canUndo`/`canRedo`. (Structural ops —
  addDerivedColumn, setColumnType, group/transform — are NOT on the undo stack.)
- **Column type relabel** (v0.2): `setColumnType(c, type)` changes alignment, the
  header glyph, and how *future* edits coerce — existing values are NOT re-coerced
  (base stays immutable; sort/display are value-driven).

- **Row identity = the implicit ordinal** (§4.1). The base never reorders, so its
  ids are free — zero storage, permanently stable.
- **Value edit** = an overlay entry keyed `r:c`, carrying the original `base` for
  provenance. Editing a cell back to its base value clears the patch.
- **Derived column** = formula-defined, lazily computed + cached, invalidated on
  any base edit, read-only. Supports derived-on-derived (cycle-guarded — though a
  true cycle can't form via the API: deps fix at add time, no forward refs).
- **Type** (v1): `number` | `category` | `string`. Aligns with loom's `CellType`.

Base columns are plain arrays in v1 (null-clean); typed-array packing is a
windowing-era optimization.

## Module surface

All pure, node-testable:

- `values.js` — `coerceValue`, `fmtCell`, `NULL_TOKENS` (the mining null
  vocabulary), `COL_TYPES`.
- `formula.js` — `compileFormula(formula, columnNames) → {deps, fn}` via
  `new Function` (a controlled emission site — no AIR routing in v1);
  `extractDeps`; the `FORMULA_ERROR` sentinel.
- `table.js` — `createTable`: base + overlay + derived (the model above).
- `ingest.js` — `tableFromCsv` (recon-injectable), `builtinSniff`,
  `detectDelimiter`.
- `view.js` — `createView`: the `filter → sort` pipeline (below).
- `aggregate.js` — `groupBy`, `AGG_OPS`.
- `transform.js` — `transformWithOver` / `previewOverTransform` (@gcu/over-injectable;
  the whole-table declarative verb → a new table, below).
- `document.js` — `writeStrata` / `readStrata` (the `.strata` format, below).
- `provider.js` — `createTableProvider(table, view?)`: the `@gcu/loom` adapter.

## The view pipeline (§4.3)

The read side is `filter → sort → window` over base⊕overlay, producing an ordered
list of underlying row indices. `createTableProvider(table, view)` renders loom
*through* it (display→underlying row map). Decisions:

- **Filter is a structured predicate** (`predicate.js`) — a JS-flavoured string
  the user types, *parsed* to a safe boolean-expression spec (and/or/not/
  comparisons/in/between/arithmetic), evaluated by walking the tree — never
  `new Function`. This is the §7.2 unification: filter = (later) the cross-surface
  selection-predicate, **one safe spec**, structuredClone-portable over the bus.
  Full-JS power stays in *derived columns* (`compileFormula`, owner-only); filter
  on the derived boolean flag. (Destined to extract to `@gcu/sift` when plate's
  panels become the 2nd consumer.)
- **Sort** is single-column, stable, **nulls-last regardless of direction**.
- **Edits don't auto-re-sort/filter** (§4.3 #4) — the view is a snapshot;
  `reapply()` is explicit. (Out-of-order flagging is additive.)
- v1 is in-memory (the small-data fast path); the big-data path — a materialized
  sorted copy via a `@gcu/sluice`/`@gcu/proc` pipeline — is deferred.

## Aggregation

`groupBy(table, {by, aggs}, rowIndices?)` is a single in-memory pass: bucket by
key tuple (multi-key, insertion-ordered), accumulate `count`/`sum`/`mean`/`min`/
`max` (non-numeric/null skipped per op), emit a **new `StrataTable`**. Units
propagate (sum/mean/min/max inherit the source unit; count is unitless). Because
the result is a table, it composes — view/derive/save/regroup (§7.2 "promotable").
Streaming group-by over sluice accumulators is the deferred big-data form.

## OVER transforms (the whole-table declarative verb)

`transform.js` connects **[`@gcu/over`](../over)** as strata's whole-table transform
verb — complementing the per-column JS formulas of `formula.js`. Where a derived column
is one JS expression, an OVER transform is a declarative pipeline (map/filter/project +
windows + joins + `check`/`require` + `units`) that produces a **new `StrataTable`** —
the same shape `groupBy` returns, so it composes (view/derive/save/transform again). This
is the intended convergence, not a graft: the two share strata's load-bearing invariant
(*output schema resolved before any row runs*).

```js
transformWithOver(table, overSrc, { compile, tables }) → { table, columns, checks, warnings }
previewOverTransform(table, overSrc, { compile })      → { columns, warnings, … }   // no run
```

- `compile` (@gcu/over's) is **injected** — strata stays zero-hard-dep, exactly like
  recon (ingest) and archive (document).
- Marshalling: StrataTable (base⊕overlay⊕derived) → row objects; strata schema → OVER
  inputSchema (types **and** units, so the schema preview + unit checks fire up front);
  OVER output rows → a new table (OVER's `NaN` numeric-absent → strata `null`;
  vtype → `number`/`category`/`string`; passthrough columns keep their unit/role).
- A failing `require` propagates OVER's gate (throws, carrying the report).
- Reference tables for `lookup`/joins accept StrataTables or plain row arrays.
- The strata surface exposes it as a **Transform…** dialog (live schema/warnings preview
  + the check report), shared by the standalone tool and the Works surface.
- *Follow-on:* persist the OVER recipe in the `.strata` (reproducible on reopen, like a
  derived column's formula); join-refs from other open tables; unit convergence onto
  `@gcu/dimensions`. v1 produces a detached result, single-table.

## Validation — the trust layer (v0.2)

A **check** is a sift predicate that MUST hold (`FROM < TO`, `grade >= 0`). Checks
run over the WHOLE table and their failures are made VISIBLE in the grid — strata
as the trust layer of an estimate.

```js
table.addCheck({ name, formula })   // parse + keep (throws on bad syntax)
table.removeCheck(i) / table.clearChecks() / table.checks / table.checkCount
table.runChecks() → { checks:[{name,formula,failed,columns}], failingRows:Set,
                      failingCells:Map(row→Set(col)), total }
```

- Per-row sift eval (NOT OVER's 5-row `check` sample), so `runChecks` yields the
  **complete** failing set → every failing cell can be tinted. A throwing
  predicate counts as a failure. (OVER's `check`/`require` stays the report/
  transform-flow + interval-window tool.)
- The provider tints failing cells (`setInvalid(row→cols)` → `style.invalid` +
  `header.invalid`); loom draws a caution-red wash + a `⚠` header badge.
- Checks **persist in the `.strata`** (`document.checks`) — validation travels
  with the data. The app re-runs on each mutation (once per batch), summarizes in
  the footer, offers **filter-to-failures** (OR of each check's negation), and a
  **Checks…** manager dialog + one-click header templates (not-null / ≥0 / range).
- *Deferred:* interval gaps/overlaps (downhole FROM/TO via OVER windows — the
  BMA-wizard harvest); a `unique` cross-row check kind (needs a row-set filter).

## The native `.strata` document (§3)

A zip (`@gcu/archive`, injected as `createWriter`/`readZip` — strata stays
zero-dep). A **document**, not a data format: data *plus* schema, units,
formulas, overlay, and provenance.

```
table.strata (zip)
  document.json    { strata, name, created, rowCount, colCount, columns[], view?, checks? }
  schema.json      { fields: [{ name, type, unit?, role?, analyte?, derived?, formula? }] }
  columns.json     { <name>: [base values] }     — immutable base, JSON payload
  overlay.json     { "r:c": { value, base } }     — the value-patch stack
  provenance.json  { created, source?, edits }
```

- **Base materialized** (v1 = role-2, rewrite-whole). **Derived columns store the
  formula, not data** (`encoding: 'derived'`) and recompute on load.
- **Growable.** Each column carries an `encoding` in the manifest; v1 reads/writes
  only `json`, but the read path *dispatches* on it, so a v2 `f64` typed-`.bin`
  column round-trips alongside JSON columns. `strata:N` gates breaking changes
  (`readStrata` refuses a newer document).

## Ingest

`tableFromCsv(text, { sniff? })` — with `@gcu/recon`'s `sniff` injected, the
schema carries roles/units/analytes (coord-aware: a "Y" axis isn't Yttrium);
without it, a minimal built-in numeric/string sniffer. recon is injected, not
imported.

## Architecture

The model is a closure over base/overlay/derived with O(1) cell reads and lazy
derived caches. The view is a recompute-on-demand index. The provider is a thin
contract adapter (returns loom-shaped `{value, state, type, style}` with the
string enum values loom compares against — strata never imports loom; the two are
joined by the contract, not the code). recon and archive are dependency-injected,
keeping strata pure and zero-dep.

**Column projection** (v0.2) — the column-axis mirror of the row view: the provider
holds a display-order array minus a hidden set, so loom sees only the visible
columns, in order. `underCol(dc)` maps display→underlying (the app translates
loom's col indices at every callback boundary); `hideColumn`/`showColumn`/
`showAllColumns`/`columnOrder`/`setColumnOrder`/`resetColumnOrder`. The strata
**surface** drives this from a **Columns…** manager dialog (drag/▲▼ reorder +
visibility) and **per-column filters** (a funnel `▽` on filtered headers).
The provider also delegates `undo`/`redo`/`beginBatch`/`endBatch` to the table and
exposes `cellTitle` (hover provenance), `revert`, `setHighlight` (brushing), and
`setInvalid` (validation) — the optional halves of the loom contract.

## Testing

`test/strata.test.mjs` (in `npm test`): values/coercion, table+overlay
(provenance, edit-back-clears, revert, effective column), **undo/redo** (per-edit
stack, txn collapses a batch, revert undoable), derived columns, **setColumnType**,
view (sort/filter/mapping), **column projection** (hide/show + reorder + reorder∘hide),
provider (header sort/filter/invalid flags, setInvalid tint, cellTitle, revert-maps),
**validation** (runChecks failures/rows/cells, live-edit clears), group-by, OVER
transform, and `.strata` round-trip (base+schema+overlay+derived + **checks**,
version guards). Plus `test/strata-smoke.mjs` + `test/strata-app-smoke.mjs`
(Playwright, browser-only) — the latter drives the full surface: edit/undo/redo,
sort/filter/per-column-filter, hide/show/reorder/convert-type, right-click revert,
validation + Checks dialog + filter-to-failures + check templates.

## What @gcu/strata is NOT

- **Not a grid renderer** — that's `@gcu/loom`; strata is the model behind a
  provider.
- **Not a streaming engine (yet)** — v1 is in-memory; big-data is the deferred
  sluice/proc path.
- **Not a calque/Excel formula language** — formulas are JS; calque is an optional
  import dialect + xlsx export, elsewhere.
- **Not a surface/app** — the toolbar, host I/O, and standalone↔Works parity live
  in `tools/strata` (see its `HOST.md`).

## Open questions

- **Validation enrichments:** interval gaps/overlaps (downhole FROM/TO via OVER
  windows — the BMA-wizard harvest); a `unique` cross-row check (needs a row-set
  filter — `view.setRowSet`, shared with linking's filter-to-linked).
- **Selection-linking promoted:** filter-to-linked-rows + "N rows linked" + the
  dee 3D-scene brush. (Brushing itself ships: strata↔strata + plate↔strata, §7.2.)
- Streaming/windowed base + structural overlay at scale (§4 layers 4–5).
- Multi-key sort; aggregate-cell formulas; pivots/group-by views.
- Unit-aware arithmetic through formulas (§6).
- Multi-window overlay merge (CRDT/Lamport on overlay ops, §4.1).

## Versioning

Pre-1.0: the model API and `.strata` format may change on minor bumps. The
overlay model and the version-gated growable document encoding are the
load-bearing commitments.
