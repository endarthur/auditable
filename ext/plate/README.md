# @gcu/plate

A **figure compositor**: a page onto which you place *panels* — a chart, a table
excerpt, a stereonet, a map — arrange them, and (in a host with a bus) keep them
**live** and **linked**. Brush a cluster in one panel and the matching points
light up in the others, and in any strata table on the same data.

plate is content-agnostic: it's the layout engine over a **panel-kind registry**.
A panel kind is a thin adapter — a domain render capability (`@gcu/plot`,
`@gcu/bearing`, `@gcu/spinifex`, `@gcu/loom`) wired to draw into a box, bind to
data, and react to a selection. Adding a stereonet panel later is registering a
kind; plate doesn't change.

> v0.1 ships the page + registry + one panel kind (an interactive scatter) +
> the selection/linking wiring. It's `@gcu/surface` example #2 — the read-mostly,
> selection-consuming surface that strata and the notebook aren't.

## Why

Geoscience reporting is figure-heavy — a resource report is plates of
grade-tonnage curves, sections, maps, summary tables. plate is where you *build
the figure*, with live data and cross-panel brushing. Almost every render
capability already exists as a GCU lib, so plate is assembly + a registry + a
page model + linking, not a new rendering stack.

## Quickstart

```js
import { createPlate } from '@gcu/plate';
import { evaluatePredicate } from '@gcu/strata';   // injected; for kind:"filter"

const plate = createPlate(el, {
  host,                  // optional; host.selection = { publish, subscribe } enables linking
  evaluatePredicate,     // optional; lets plate resolve filter selections over its data
  page: { size: 'A4', orientation: 'landscape', margins: {} },
});

plate.setData({
  columns: { grade: [...], tonnes: [...] },   // name → values[]
  keys: ['0', '1', '2', ...],                 // row identity (e.g. strata base ordinals)
  numericColumns: ['grade', 'tonnes'],
});
const id = plate.addPanel({ kind: 'plot' });  // defaultSpec scatters the first two numeric cols
plate.setPanelSpec(id, { x: 'grade', y: 'tonnes' });
```

A brush on the scatter calls `host.selection.publish({ kind:'rows', rows, cols })`;
an incoming descriptor is resolved to a key set and tints the matching points.
`plate.setLinked(false)` opts out of incoming selections (the visible toggle).

## API

**Compositor** — `createPlate(el, opts) → plate`
- `addPanel({ kind, frame?, spec? }) → id` · `setData(data)` · `setPanelSpec(id, spec)`
- `setPage(spec)` · `setLinked(bool)` / `.linked` · `.lastSelection`
- `panelIds()` · `getPanelSpec(id)` · `getPanelInstance(id)` · `destroy()`

**Registry** — `registerPanelKind(kind, def)` · `getPanelKind(kind)` · `listPanelKinds()`
A panel-kind def: `{ kind, defaultSpec(data)→spec, render(el, spec, data, ctx)→instance }`.
A panel instance: `{ update(spec), setData(data), setHighlight(keySet|null), destroy() }`.
`ctx.onSelect(descriptor)` is how a panel emits a brush.

**Page model** — `PAGE_SIZES` · `pageDims(size, orientation)` · `contentRect(dims, margins)` · `resolveFrame(frame, content)`

**Linking** — `resolveSelection(desc, data, evalPred?) → Set<key> | null` (pure):
`kind:"rows"` carries keys; `kind:"none"/"cols"` clears; `kind:"filter"` is
evaluated over `data` when `evalPred` is supplied (else inert — the engine never
imports a predicate lib).

**Panels** — `plotPanel` (the built-in interactive scatter; self-registers as `'plot'`).

## Limitations (v0.1)

- One panel kind (plot/scatter). table/stereonet/map are additive registrations.
- No `.figure` document yet — a panel binds to a host-supplied dataset by path.
- No multi-panel layout editing (drag/align/snap), no export. The page model is
  there (page → frames → panels); the editor is the next growth step.
- `kind:"filter"` resolution needs an injected evaluator; `kind:"cols"/"cells"`
  and mixed enumerated+predicate selections are not resolved.

## Build & test

`node ext/plate/build.js` → `ext/plate/index.js` (concat bundle, like
sluice/recon/flowsheet/loom/strata). Pure tests: `test/plate.test.mjs` (in
`npm test`). The DOM-bound compositor + scatter + linking are exercised by
`test/plate-strata-link-smoke.mjs` (Playwright; not in `npm test`).

## License

MIT © Arthur Endlein Correia — Geoscientific Chaos Union (gentropic.org)
