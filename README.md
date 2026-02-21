# auditable

a reactive computational notebook that fits in a single HTML file.

no build step. no server. no dependencies. open the file, write code, save. the HTML *is* the document, the runtime, and the lockfile.

```
auditable.html  ~65KB  <  a floppy disk
```

## what it does

- **reactive DAG** — cells track dependencies and re-execute when upstream values change
- **interactive widgets** — `slider()`, `dropdown()`, `checkbox()`, `textInput()` with live reactivity
- **markdown cells** — documentation lives alongside computation
- **module system** — `await load("https://esm.sh/d3")` for dynamic ESM imports; `install()` embeds the source in the HTML so it works offline
- **self-contained save** — Ctrl+S produces a new HTML file with all code, state, settings, and installed modules baked in
- **presentation mode** — hide the editor, show the outputs. widgets still work. press `p` or `⎚`

## quick start

1. open `auditable.html` in a browser
2. write code in cells
3. Ctrl+S to save

that's it. email the file to someone. they open it. it runs.

## keyboard shortcuts

press **F1** inside the notebook for the full reference. highlights:

| mode | key | action |
|------|-----|--------|
| command | `j` / `k` | navigate cells |
| command | `a` / `b` | insert cell above / below |
| command | `dd` | delete cell |
| command | `z` | undo delete |
| command | `m` / `y` | convert to markdown / code |
| command | `h` | collapse cell |
| command | `p` | presentation mode |
| edit | `Ctrl+Enter` | run cell |
| edit | `Shift+Enter` | run cell + advance |
| edit | `Ctrl+/` | toggle comment |
| global | `F1` | help overlay |
| global | `Ctrl+S` | save notebook |

## builtins

```js
display(value)          // render text, objects, or DOM elements
canvas(w, h)            // create a canvas element in the output
table(data, columns?)   // render array of objects as a table
slider(label, default, {min, max, step})
dropdown(label, options)
checkbox(label, default)
textInput(label, default)
load(url)               // dynamic ESM import (cached)
install(url)            // import + embed source in HTML on save
```

## directives

```js
// %manual    — skip this cell during reactive updates (only runs on explicit Ctrl+Enter or Run All)
```

## modules

```js
// load from esm.sh — works with any npm package
const d3 = await load("https://esm.sh/d3");
const { Stereonet } = await load("https://esm.sh/@gcu/bearing");

// install() fetches the source and embeds it in the HTML
// the notebook works offline after that
await install("https://esm.sh/peerjs");
```

## settings

click **⚙** in the toolbar:

- **theme** — dark (default) or light
- **editor font size** — 10–20px
- **notebook width** — narrow / default / wide / full

settings travel with the file.

## examples

the `examples/` directory contains:

| file | what it shows |
|------|---------------|
| `example_idw.html` | inverse distance weighting interpolation with viridis colormap |
| `example_lorenz.html` | lorenz attractor with adjustable σ/ρ/β and 3D rotation |
| `example_stereonet.html` | structural geology stereonet using `@gcu/bearing` |
| `example_life.html` | conway's game of life — imperative callbacks in a `// %manual` cell |
| `example_synth.html` | web audio synthesizer with keyboard UI |
| `example_mandelbrot.html` | mandelbrot set explorer with zoom, pan, and color shift |

each is a self-contained HTML file. no server required.

## how it works

cells declare variables with `const`, `let`, or `function`. the parser (`parseNames`) extracts top-level definitions — including destructuring and comma-separated declarations — and builds a dependency graph. when a cell changes, all downstream cells re-execute in topological order.

the scope is passed by value between cells via `AsyncFunction` constructors. mutable state that needs to survive across callbacks belongs in `// %manual` cells.

widgets are keyed by label. when a slider's value changes, the cell that created it re-executes, which triggers its dependents. the DAG handles the rest.

save serializes cell source as JSON in an HTML comment (`<!--AUDITABLE-DATA ... -->`), along with settings and installed module sources. the runtime reads these on load. the browser is the runtime. the HTML is the lockfile.

## philosophy

- the browser has everything: canvas, WebGL, WebGPU, WebAudio, WebRTC, Web Serial, IndexedDB
- a single file is the most portable artifact humans have invented since paper
- zero dependencies means zero supply chain risk
- if you can't email it, it's too complicated
- MIT license, software delivered as is

## roadmap

- [ ] embed system — `<!--AUDITABLE-EMBED name="data.csv" -->` + `embed()` API
- [ ] cell status indicators (spinner during async)
- [ ] split cell (`Ctrl+Shift+-`)
- [ ] merge cells (`Shift+M`)
- [ ] line numbers toggle (`l`)
- [ ] page breaks for presentations (`// %page` + arrow navigation)
- [ ] export as app (strip editor, keep widgets)
- [ ] atelier mode (drag widget outputs into a layout grid)

## license

MIT

---

part of the [geoscientific chaos union](https://gentropic.org) · by [endarthur](https://endarthur.github.io)
