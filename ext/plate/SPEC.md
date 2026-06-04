# @gcu/plate — SPEC

*A figure compositor: a page of linked, live panels over GCU domain libs.*

| | |
|---|---|
| **Package** | `@gcu/plate` |
| **Version** | 0.1.0 |
| **Build** | concat (`node ext/plate/build.js` → `index.js`) |
| **Deps** | none (zero-dep base lib; a predicate evaluator is *injected*, not imported) |
| **Runtime** | any JS env with a DOM |
| **Tests** | `test/plate.test.mjs` (pure) + `test/plate-strata-link-smoke.mjs` (Playwright) |

## Lineage

The figure-of-panels model is old and proven — QGIS Print Composer, matplotlib
`Figure`/`GridSpec`, Vega view-composition, InDesign/Scribus page+frames. plate's
distinctness: **content-agnostic** panels over GCU domain libs, **live + linked**
via the selection contract, in a Works surface, exporting via the GCU print stack.

It converges with `@gcu/osjs`'s `@gcu/compo` (a figure composer arrived at from
the stereonet side) — same engine, two directions; plate extracts from both. The
contract plate's panels speak (the selection/linking channel) is committed in
`ext/surface/SPEC.md`; the broader design rationale lives in the project's internal
design notes.

## Premise

Plotting is a **capability, not a place**: stereonet→osjs and map→terella are
destination apps, but a "plot app" would be an orphan. So plate is a layout
engine over a **panel-kind registry** (mirroring Works' surface registry); a
panel kind is a domain lib + a thin adapter. The app and the panel are siblings —
both thin consumers of the same lib at different ambition. plate hosts *panels*,
never the full apps; surfaces share libraries, never surface code (the dependency
graph stays a DAG).

## Data model

- **Page** — a fixed paper canvas (`PAGE_SIZES`, orientation, margins). Frames
  are absolute `{x,y,w,h}` rects on the page (free placement, unlike `@gcu/rails`
  docking). v0.1 uses one `'full'` frame; multi-panel is additive.
- **Panel kind** — `{ kind, defaultSpec(data)→spec, render(el, spec, data, ctx)→instance }`.
  Self-registers at module-init (the AIR-lowerer pattern).
- **Panel instance** — `{ update(spec), setData(data), setHighlight(keySet|null), destroy() }`.
- **Data** — `{ columns: {name: values[]}, keys: string[], numericColumns: string[] }`.
  `keys[i]` is the dataset's row identity (strata base ordinals when bound to a
  `.strata`), so plate↔strata share an identity space with no key-map.
- **Selection** — the linking contract descriptor (`selection-linking-contract.md`):
  `{ kind, key, rows?/cols?/predicate? }`. A brush emits `kind:"rows"`; an incoming
  descriptor resolves to a key set (`resolveSelection`) and tints points.

## Module surface (`src/`)

- `registry.js` — `registerPanelKind` / `getPanelKind` / `listPanelKinds`.
- `page.js` — `PAGE_SIZES`, `pageDims`, `contentRect`, `resolveFrame`.
- `panels/plot.js` — `plotPanel`: a self-contained interactive canvas scatter
  that owns its data→pixel transform (so brush, hit-test, highlight are local).
  Self-registers as `'plot'`.
- `plate.js` — `createPlate(el, opts)` (the compositor: page + frames + selection
  wiring) and `resolveSelection(desc, data, evalPred?)` (the pure linking logic).

## Architecture notes

- **Bespoke scatter, not over @gcu/plot (v0.1).** A scatter that participates in
  the selection contract must own its transform; `@gcu/plot` keeps that private.
  @gcu/plot delegation for static chrome (log scales, legends) is a growth path.
- **Zero-dep engine.** The predicate evaluator for `kind:"filter"` is *injected*
  (the surface passes strata's `evaluatePredicate`) so plate never imports a
  predicate lib. That lib extracts to `@gcu/sift` once plate is its 2nd consumer.
- **Linking is capability-optional.** `host.selection` absent (standalone) →
  linking is inert; the same engine runs linked (Works) and unlinked.

## NOT (out of scope for v0.1)

- The `.figure` zip document, frozen-panel snapshots, multi-page folios.
- Multi-panel layout editing: drag, align/distribute, smart guides, ruler guides.
- Export (PDF/A via `@gcu/pdf3a` + `gcu-press`).
- table/stereonet/map panel kinds (additive registrations).
- `kind:"cols"/"cells"`, mixed enumerated+predicate selections, cross-dataset
  key-maps, the `js`/transferable-buffer elevated selection tier.

## Versioning

Pre-1.0: the panel-kind contract, the data shape, and the page model are
unstable. The selection descriptor follows `selection-linking-contract.md`.
The registry is a clean extraction candidate when the 3rd panel kind arrives.
