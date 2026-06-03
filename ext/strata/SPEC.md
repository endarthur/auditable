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
| Version | 0.1 (shipped 2026-06)                                       |
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
  schema   : [{ name, type, unit?, role?, analyte?, derived?, formula? }]
```

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
- `document.js` — `writeStrata` / `readStrata` (the `.strata` format, below).
- `provider.js` — `createTableProvider(table, view?)`: the `@gcu/loom` adapter.

## The view pipeline (§4.3)

The read side is `filter → sort → window` over base⊕overlay, producing an ordered
list of underlying row indices. `createTableProvider(table, view)` renders loom
*through* it (display→underlying row map). Decisions:

- **Filter is a boolean formula** — compiled by the *same* engine as derived
  columns. This is the §7.2 unification: filter = derived-column row-expr = (later)
  selection-predicate, **one language**.
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

## The native `.strata` document (§3)

A zip (`@gcu/archive`, injected as `createWriter`/`readZip` — strata stays
zero-dep). A **document**, not a data format: data *plus* schema, units,
formulas, overlay, and provenance.

```
table.strata (zip)
  document.json    { strata, name, created, rowCount, colCount, columns[], view? }
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

## Testing

`test/strata.test.mjs` (37, in `npm test`): values/coercion, table+overlay
(provenance, edit-back-clears, revert, effective column), derived columns
(compute, recompute-on-edit, chains, errors, read-only), view (sort asc/desc/
nulls, filter, filter∘sort, no-auto-resort, provider+view mapping), group-by
(ops, unit propagation, composes, filtered subset, multi-key), and `.strata`
round-trip (base+schema+overlay+derived, version + error guards). Plus
`test/strata-smoke.mjs` + `test/strata-app-smoke.mjs` (Playwright, browser-only).

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

- Streaming/windowed base + structural overlay at scale (§4 layers 4–5).
- Multi-key sort; aggregate-cell formulas; pivots/group-by views.
- Unit-aware arithmetic through formulas (§6).
- Selection-as-predicate over the bus (§7.2) — lands with a chart surface.
- Multi-window overlay merge (CRDT/Lamport on overlay ops, §4.1).

## Versioning

Pre-1.0: the model API and `.strata` format may change on minor bumps. The
overlay model and the version-gated growable document encoding are the
load-bearing commitments.
