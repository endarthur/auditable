# @gcu/loom

**A virtualized canvas grid renderer behind a rich, async cell provider — windowed over millions of rows, state-aware per cell, host-agnostic to mount.**

`@gcu/loom` is the table-rendering kernel for the GCU stack. It draws a grid from
whatever a *provider* gives it: dimensions, per-cell `{value, state, type}`,
headers, and a commit sink for edits. The render core (canvas virtualization,
scroll, selection paint, column geometry) was extracted from a production
spreadsheet grid; loom reseams it behind a deliberately rich interface so the
same renderer serves a small hand-edited sheet and a 50-million-row streamed
model, standalone or embedded.

| Field   | Value                                              |
|---------|----------------------------------------------------|
| Version | 0.1 (shipped 2026-06)                              |
| Status  | Pre-1.0                                            |
| License | MIT                                               |
| Owner   | endarthur                                          |
| Lineage | the calque canvas grid (render core); a provider model in the shape of slick-grid / ag-grid datasources |

---

## Lineage

The only production virtualized grid in the repo was `tools/calque/js/grid.js`
(canvas render, true scroll virtualization, in-place edit, range select, paste,
frozen headers) — coupled to calque's spreadsheet model via a prebuilt
`(r,c) → text` map. loom is the **extract + reseam** of that: keep the render
core's soul (the draw/scroll/virtualize loop), replace the two coupling seams —
**read** (`buildCellMap` → `provider.cellAt`) and **write** (calque source edit →
`provider.commit`). The provider idea is the same one slick-grid / ag-grid call a
"datasource"; loom's is richer (state + async) because it serves an auditable,
windowed table.

## Premise

Two properties a normal grid doesn't need force the whole design:

1. **Auditability is visual.** A cell isn't a string — it's a value plus a
   *state* (raw / edited / derived / error / pending / out-of-order) and a *type*.
   State drives how it's drawn (an edit gets an accent bar; a derived value is
   italic; an error shows `#ERR`). The model has to be rich up front; *drawing*
   each state is additive, but you can't retrofit the model.

2. **Reads are async-shaped.** A million-row model can't load all at once
   (mobile single-buffer caps at ~2 GB). The render loop already touches only the
   visible window, so the read path must allow a cell to be *not loaded yet* —
   `cellAt` returns a `PENDING` sentinel, loom draws a placeholder, and a provider
   `onReady` callback triggers a repaint when the window lands. Async lives in a
   sentinel the sync loop understands; the loop shape never changes.

Both are retrofit-brutal, so both are in the contract from v0.1.

## Data model

**The cell** — what `provider.cellAt(r, c)` returns:

```
cell = { value, state, type, style? }   |   null (blank)   |   PENDING (sentinel)

state : CellState = raw | edited | derived | error | pending | out-of-order
type  : CellType  = number | string | date | category | bool | null
style?: { text }  — explicit display text; else fmtVal(value)
```

`PENDING` is a `Symbol`, never a `Promise` — the render loop stays synchronous.

**The metrics** — geometry state (per grid instance, never global):

```
metrics = { defaultColW, rowH, hdrH, rowHdrW, colWidths{}, totalRows, totalCols }
```

Column widths are sparse (only non-default columns stored); `colXAt`/`colAtX`
walk them in O(#custom). Row height is a fixed scalar in v1 — the row helpers are
written so a prefix-sum height index swaps in without touching call sites.

## Module surface

Pure (zero DOM, node-testable):

- `model.js` — `PENDING`, `CellState`, `CellType`; `colLetter`/`colIndex`,
  `fmtVal`, `inferType`, `normSel`, `selEquals`.
- `geometry.js` — `colW`, `colXAt`, `colAtX`, `visibleColRange`, `totalWidth`;
  `rowAtY`, `rowYAt`, `visibleRowRange`, `totalHeight`, `cellAt`. All take a
  `metrics` object; both scroll bounds clamp to the grid.
- `memory-provider.js` — `createMemoryProvider({columns, rows})`: a reference
  provider (immutable base + sparse edit overlay → `EDITED` state). Contract docs
  as code.

Browser (canvas + DOM):

- `render.js` — `paint` / `paintCells` / `paintColHeaders` / `paintRowHeaders`;
  `DARK_COLORS`, `LIGHT_COLORS`. The cell-draw branch is by `state` then `type`.
  Headers are their own bands (`provider.header` / `rowHeader`) — *not* inlined as
  body cells the way calque did; the body is data rows only.
- `grid.js` — `createGrid(element, provider, options)`: the host-agnostic factory.
  Builds the canvas scaffold, wires scroll/mouse/keyboard, runs the edit→commit
  lifecycle, returns an instance handle. All state on the closure — any number of
  grids coexist.

## The four design-now upgrades

Architectural, brutal to retrofit, all present in v0.1:

1. **Async cell provider** — `cellAt → PENDING` + `onReady` repaint. The
   small-sheet/windowed-big-data difference.
2. **Rich cell model** — `{value, state, type, style}`, not a string. Auditability
   made visual.
3. **First-class selection** — structured `{r0,c0,r1,c1}`, normalized, published
   via `onSelect` on commit. The cross-surface brushing/linking seam.
4. **Host-agnostic mount** — `mount(el, provider)`, no globals → drops into a
   standalone page or an iframe surface unchanged.

## Editability

Drawn from cell state, not a separate flag: loom refuses to start an edit on a
cell whose `state` is `DERIVED` or that is `PENDING`. Everything else is editable;
the keystroke/F2/double-click opens an input, and commit sends the raw string to
`provider.commit(r, c, raw)` — the provider coerces per its column type.

## Architecture

`createGrid` builds: a corner div, a column-header canvas, a row-header canvas, a
body holding the main canvas (visible, `pointer-events:none`) under a scroll div
(transparent, scrollbar-bearing, focusable) with a sizing spacer. Scroll events
repaint; a `ResizeObserver` re-sizes. The paint loop computes the visible window
via `visibleColRange`/`visibleRowRange` and draws only those cells — swapping a
`Map.get` for `provider.cellAt` is the entire async reseam, loop shape unchanged.

## Testing

- `test/loom.test.mjs` — 17 pure tests: model (enums, col letters, sel) +
  geometry (uniform + custom-width round-trips, clamping) + the memory provider
  (raw→edited overlay, range guards, row-of-objects). In `npm test`.
- `test/loom-smoke.mjs` — Playwright over loopback HTTP: mounts the demo, asserts
  3 sized canvases, painted pixels, selection publish, edit→overlay, no console
  errors. Browser-only (not in `npm test`).

## What @gcu/loom is NOT

- **Not a data model.** It renders a provider; the data, types, formulas, and
  persistence live behind the provider (`@gcu/strata` is one).
- **Not a spreadsheet app.** No formula bar, no menus, no file I/O — those belong
  to the host.
- **Not a DOM-cell grid.** Cells are canvas-drawn; there's a future a11y DOM
  mirror but no per-cell DOM.
- **Not GPU.** 2D canvas; a WebGL path is unscoped.

## Open questions

- Variable row height (prefix-sum index) — reserved, not built.
- Frozen *key columns* (pin `hole_id`/`depth`) — additive on the render core.
- An a11y DOM mirror for keyboard/screen-reader use.
- Whether the second real consumer (a retrofitted calque) reshapes the provider —
  the two-examples discipline applies here too.

## Versioning

Pre-1.0; the provider contract and instance API may shift on minor bumps. The
rich cell model and the `PENDING` sentinel are the load-bearing commitments.
