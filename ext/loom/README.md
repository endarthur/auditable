# @gcu/loom

A virtualized canvas grid renderer behind a rich, async cell provider — the
table-rendering kernel for the GCU stack.

- **Virtualized canvas render** — scrolls to any row of a 50-million-row model;
  only the visible window is drawn
- **Rich async cell provider** — `cellAt(r,c)` returns `{value, state, type,
  style}` *or* a `PENDING` sentinel, so a windowed/streaming backend can fill
  cells as chunks arrive
- **State-aware drawing** — cells render their provenance: raw · edited (accent
  bar) · derived (italic) · error (`#ERR`) · pending (`…`) · out-of-order
- **First-class selection** — structured, normalized, published on commit
  (`onSelect`) for cross-surface brushing/linking
- **Host-agnostic mount** — `createGrid(el, provider)`; no globals, no app-shell
  assumptions, multiple instances per page
- **Themed** — a palette object (dark/light built in) drives every colour, incl.
  the scrollbar; swap at runtime
- Pure vanilla JS, single ES module, zero runtime deps; ~31 KB unminified

`@gcu/loom` is part of the [Auditable](https://github.com/endarthur/auditable)
ecosystem. It's the grid behind [`@gcu/strata`](../strata) (columnar + overlay
data) and is usable standalone with any provider you write.

## Why?

A grid that wants to be *auditable* and *windowed* needs two things a normal
spreadsheet grid doesn't: every cell must carry **state** (is this raw data, an
edit, a computed value, an error?) so the UI can show provenance visually; and
the read path must be **async-shaped** so a million-row model can stream into
view instead of loading all at once. You cannot bolt either onto a sync,
string-valued render loop after the fact — so loom is built around a rich,
possibly-pending cell from line one. The render core was extracted from a
production virtualized canvas spreadsheet and reseamed behind this provider
interface; the hard 80% (canvas virtualization, scroll, selection paint) is
battle-tested, the interface is where loom's soul lives.

## Installation

```bash
npm install @gcu/loom
```

## Quickstart

```js
import { createGrid, createMemoryProvider } from '@gcu/loom';

// A trivial in-memory provider (loom ships one as a reference).
const provider = createMemoryProvider({
  columns: [{ name: 'id' }, { name: 'grade' }, { name: 'domain' }],
  rows: [
    [1, 2.5, 'ox'],
    [2, 0.8, 'sulf'],
    [3, 4.21, 'ox'],
  ],
});

const grid = createGrid(document.getElementById('grid'), provider, { theme: 'dark' });
grid.onSelect((sel) => console.log('selected', sel));   // {r0,c0,r1,c1} | null
```

The host element is sized by you (loom fills it). Double-click / F2 / type to
edit; arrows/Enter/Tab to move; drag to range-select; click a header for
`onHeaderClick`.

## The provider contract

loom renders whatever a provider gives it. A provider is a plain object:

```js
provider.dims()        → { rows, cols }              // rows can be 50_000_000
provider.cellAt(r, c)  → cell | null | PENDING       // null = blank
provider.header(c)     → { label, type? } | string   // column band (default: A,B,…)
provider.rowHeader(r)  → string | number             // row band   (default: r+1)
provider.commit(r, c, rawString)  → void | Promise   // an edit; provider coerces
provider.onReady?(cb)  → unsubscribe                 // fires when a window lands → repaint
```

A **cell** is the rich model — not a bare string:

```js
{
  value,                 // the underlying value
  state,                 // CellState — drives provenance treatment
  type,                  // CellType  — drives alignment / colour
  style?: { text }       // optional explicit display text (else fmtVal(value))
}
```

```js
import { CellState, CellType, PENDING } from '@gcu/loom';

CellState = { RAW, EDITED, DERIVED, ERROR, PENDING, OUT_OF_ORDER }   // string enum
CellType  = { NUMBER, STRING, DATE, CATEGORY, BOOL, NULL }
```

`cellAt` may return the `PENDING` sentinel (a `Symbol`, *not* a Promise) when a
windowed backend hasn't loaded that row's chunk — loom draws a placeholder and
repaints when the provider's `onReady` fires. The sync render loop is untouched;
the asyncness lives in the sentinel it already understands. A cell whose `state`
is `DERIVED` (or `PENDING`) is treated as **read-only** — loom won't start an
edit on it.

Edits flow as raw strings to `provider.commit(r, c, rawString)` — the provider
owns coercion (it knows the column's type). loom calls its own `refresh()` after
a commit.

## The grid instance

```js
const grid = createGrid(element, provider, options?);

grid.refresh()                 // re-read dims + repaint (after a data change)
grid.getSelection()            // normalized { r0, c0, r1, c1 } | null
grid.setSelection(sel)         // set + repaint + notify
grid.onSelect(cb)              // → unsubscribe; cb(normalizedSel) on commit
grid.onHeaderClick(cb)         // → unsubscribe; cb(colIndex) on header click
grid.focus()                   // focus the grid (keyboard nav)
grid.setColors(palette)        // swap the theme palette (e.g. dark ⇆ light)
grid.destroy()                 // tear down listeners + DOM
grid.element / grid.provider   // back-references
```

`options`: `{ colors?, theme?: 'dark'|'light', defaultColW?, rowH?, hdrH?,
rowHdrW?, fontPx?, hdrFontPx?, mono?, colWidths? }`. `colors` is a full palette
object (see `DARK_COLORS` / `LIGHT_COLORS` exports) overriding any key.

## Pure helpers (no DOM)

The model + geometry layers are pure and node-testable, exported for reuse:

```js
// model.js
colLetter(n) / colIndex(s)     // 0 ⇄ 'A', 26 ⇄ 'AA'
fmtVal(v) / inferType(v)
normSel(sel) / selEquals(a, b)

// geometry.js — operate on a `metrics` object
colW / colXAt / colAtX / visibleColRange / totalWidth
rowAtY / rowYAt / visibleRowRange / totalHeight / cellAt
```

## Build, test

```bash
node ext/loom/build.js          # bundle src/ → index.js (single ES module)
node --test test/loom.test.mjs  # 17 pure tests (model + geometry + memory provider)
node test/loom-smoke.mjs        # Playwright: mount / paint / select / edit (needs a browser)
```

`ext/loom/demo.html` is a 500-row demo over the in-memory provider (serve over
http — ES-module imports don't resolve from `file://`).

## Limitations (v1)

Deliberate v1 scope; all additive later:

- **Fixed row height.** A prefix-sum height index (variable rows / wrapped text)
  is a designed-in swap-in, not built.
- **Not yet built** (extracted from calque's render core, reseam pending):
  column resize, zoom, frozen header rows, hover tooltips, copy/paste. The cell
  model and render loop are structured so these are additive.
- **Single backing renderer** (2D canvas). No WebGL/GPU path.
- **Edits are single-cell.** Range fill / paste-block land with copy/paste.

## Versioning

Pre-1.0: the provider contract and instance API may change on minor bumps. The
rich cell model (`{value, state, type, style}`) and the `PENDING` sentinel are
the load-bearing commitments and are the least likely to move.

## License

MIT — see [LICENSE](../../LICENSE).

## Author

Arthur Endlein Correia / [Geoscientific Chaos Union](https://gentropic.org)
