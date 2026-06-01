# @gcu/stereonet

Declarative, interactive, reactive **stereonet cells** for auditable — structural-geology plots as a first-class notebook cell, on top of [`@gcu/bearing`](https://github.com/gentropic/bearing.js).

A `/// stereonet` cell's source is measurements + a few directives; its output is an interactive equal-area / equal-angle net you can drag to rotate; and it **defines a scope handle** downstream cells consume reactively. Edit a measurement → the DAG re-runs the dependents.

## Cell format

One statement per line; `;` or `//` begin a comment.

```
name bedding              ; the scope variable this cell defines (default: stereonet)
proj equal-area           ; or equal-angle / wulff
view 120 30               ; rotate the net to this trend/plunge centre
g foliation               ; subsequent items join this group
plane 120 35              ; dip direction / dip
pole  210 65 #cc3333      ; with a colour
line  030 12              ; trend / plunge
contour                   ; density-contour all poles+lines (needs ≥3)
```

## The scope handle

The cell binds one name (here `bedding`). Downstream cells get:

```js
bedding.stereonet   // the live Stereonet instance
bedding.element     // the rendered SVG node
bedding.dcos        // all measurements as direction cosines
bedding.groups      // { foliation: [...], all: [...] }
bedding.stats       // { eigenvalues, eigenvectors, K, C, P, G, R, fisher, ... } | null
```

```js
/// code
const { fabricplot } = await load("@gcu/bearing");
ui.display(fabricplot.woodcockSVG([{ dcos: bedding.dcos, label: "bedding" }]));
ui.display(`S1 = ${bedding.stats.eigenvalues[0].toFixed(3)}  ·  K = ${bedding.stats.K.toFixed(2)}`);
```

## Availability

In **Auditable Works**, `@gcu/stereonet` and its engine `@gcu/bearing` ship as
`/usr/lib` builtins (bundled via `SHARED_LIBS` in `build.js`), and `stereonet` is
in the host's `LANGUAGE_PACKS` (`src/js/exec.js`) — so a `/// stereonet` cell
**auto-loads** the cell type from the builtin on first paint, and the engine
resolves via `load('@gcu/bearing')` offline. No manual install needed.

In a **standalone** `auditable.html` notebook (no `/usr/lib`), install once:

```js
install("@gcu/bearing");      // current version; the npm/esm.sh copy may lag
install("@gcu/stereonet");
```

`@gcu/bearing` is developed in the sibling repo (gentropic/bearing.js) and
vendored into this repo at `ext/bearing/` (see its README); it is **not** vendored
inside this package — the cell loads it at run time via the cell context's `load()`.

## Status & caveats

- **Pre-1.0.** The cell-type contract (`parseNames` / `findUses` /
  `execute(code, upstream, cell)` → `{ defines }`, output via `cell._ctx.display`)
  follows `EXTENSION_SPEC §3.1`, modelled on `ext/example-quip`. The pure parser
  is unit-checked (`test/stereonet.test.mjs`); the host-facing half is exercised
  by the `works-smoke` end-to-end check.
- **Roadmap:** a `tokenize` for editor highlighting of the mini-format; reactive
  `ui` view widgets (trend/plunge sliders, layer toggles) inside the cell; optional
  upstream references (`findUses`) so a cell can plot dcos defined elsewhere.

The notebook cell is the smallest "face" of a shared core (`data → interactive net
+ stats`); the same core is intended to power the OSJS Works surface and a
standalone app (gentropic/osjs).
