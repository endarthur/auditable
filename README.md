# auditable

a reactive computational notebook that fits in a single HTML file.

no build step. no server. no dependencies. open the file, write code, save. the HTML *is* the document, the runtime, and the lockfile.

```
auditable.html  ~150KB
```

## what it does

- **reactive DAG** -- cells track dependencies and re-execute when upstream values change
- **four cell types** -- code, markdown, CSS, and HTML cells with live reactivity
- **interactive widgets** -- `slider()`, `dropdown()`, `checkbox()`, `textInput()` with live reactivity
- **module system** -- `await load("https://esm.sh/d3")` for dynamic ESM imports; `install()` embeds the source in the HTML so it works offline
- **self-contained save** -- Ctrl+S produces a new HTML file with all code, state, settings, and installed modules baked in
- **find/replace** -- Ctrl+F to search across cells, with regex and case-sensitive modes
- **presentation mode** -- hide the editor, show the outputs. widgets still work. press `p`
- **cell directives** -- `// %manual`, `// %hide`, `// %norun`, `// %cellName`, `// %goto`, `// %outputId`, `// %outputClass`
- **line numbers** -- toggleable in settings

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
| command | `m` / `y` / `s` / `t` | convert to md / code / css / html |
| command | `h` | collapse cell |
| command | `p` | presentation mode |
| edit | `Ctrl+Enter` | run cell |
| edit | `Shift+Enter` | run cell + advance |
| edit | `Ctrl+/` | toggle comment |
| global | `F1` | help overlay |
| global | `Ctrl+S` | save notebook |
| global | `Ctrl+F` | find / replace |

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
// %manual       — skip during reactive updates (only Ctrl+Enter or Run All)
// %hide         — hide cell in presentation mode
// %norun        — never auto-run this cell
// %cellName     — give the cell a display name
// %goto label   — jump to a named cell after execution
// %outputId id  — set an id on the cell's output div
// %outputClass  — add CSS classes to the cell's output div
```

## cell types

| cell | type | DAG role | defines | uses | key | label |
|------|------|----------|---------|------|-----|-------|
| code | code | reactive r/w | yes | yes | `y` | code |
| markdown | md | none | no | no | `m` | md |
| CSS | css | static side effect | no | no | `s` | css |
| HTML | html | reactive read-only | no | yes | `t` | html |

HTML cells support `${variable}` interpolation from upstream code cells.

## modules

```js
// load from esm.sh -- works with any npm package
const d3 = await load("https://esm.sh/d3");
const { Stereonet } = await load("https://esm.sh/@gcu/bearing");

// install() fetches the source and embeds it in the HTML
// the notebook works offline after that
await install("https://esm.sh/peerjs");
```

installed modules are managed in the settings panel -- view sizes, remove individual modules.

## settings

click the gear icon in the toolbar:

- **theme** -- dark (default) or light
- **editor font size** -- 10-20px
- **notebook width** -- narrow / default / wide / full
- **cell header** -- auto / always / hover / compact
- **line numbers** -- on / off
- **execution mode** -- reactive (default) or manual
- **run on load** -- yes (default) or no
- **show run toggle** -- yes or no

settings travel with the file. execution mode can also be overridden globally via localStorage.

## examples

the `examples/` directory contains:

| file | what it shows |
|------|---------------|
| `example_life.html` | conway's game of life -- imperative callbacks in a `// %manual` cell |
| `example_lorenz.html` | lorenz attractor with adjustable parameters and 3D rotation |
| `example_mandelbrot.html` | mandelbrot set explorer with zoom, pan, and color shift |
| `example_stereonet.html` | structural geology stereonet using `@gcu/bearing` |
| `example_synth.html` | web audio synthesizer with keyboard UI |
| `example_idw.html` | inverse distance weighting interpolation with viridis colormap |
| `example_dashboard.html` | multi-panel dashboard layout with CSS cells |
| `example_modules.html` | `install()` and `load()` with esm.sh modules |

each is a self-contained HTML file. no server required.

## auditable files (AF) -- experimental

`af.html` is a workspace shell for managing multiple notebooks, similar to JupyterLab. open it in a browser to get a file tree, tab bar, and iframe-based notebook editing.

**features:**
- **multi-root workspace** -- open real directories (File System Access API, Chromium only) and virtual "boxes" (IndexedDB, all browsers) side by side
- **tab management** -- preview tabs (single-click), permanent tabs (double-click or edit), drag to reorder
- **postMessage bridge** -- Ctrl+S in a notebook saves back to the workspace (disk or box)
- **box export/import** -- export a box as a self-contained `af.html` file, import it elsewhere
- **localStorage shim** -- blob URL iframes get per-file storage backed by IndexedDB, so any single-file HTML app works
- **persistence** -- workspace roots, open tabs, sidebar width, and active tab restore on reload

**build:**
```
node build.js                    # builds auditable.html
node build.js --target=af        # builds af.html (requires auditable.html)
npm run build:af                 # both
```

AF embeds the full auditable runtime, so new notebooks created inside AF are fully self-contained -- save one out and it works standalone.

## how it works

cells declare variables with `const`, `let`, or `function`. the parser (`parseNames`) extracts top-level definitions -- including destructuring and comma-separated declarations -- and builds a dependency graph. when a cell changes, all downstream cells re-execute in topological order.

the scope is passed by value between cells via `AsyncFunction` constructors. mutable state that needs to survive across callbacks belongs in `// %manual` cells.

widgets are keyed by label. when a slider's value changes, the cell that created it re-executes, which triggers its dependents. the DAG handles the rest.

save serializes cell source as JSON in an HTML comment (`<!--AUDITABLE-DATA ... -->`), along with settings and installed module sources. the runtime reads these on load. the browser is the runtime. the HTML is the lockfile.

## building

```
npm install      # (nothing to install -- zero dependencies)
node build.js    # concatenates src/ modules into auditable.html
npm test         # runs tests with node --test
```

to regenerate examples after changes:
```
node gen_examples.js
```

## philosophy

- the browser has everything: canvas, WebGL, WebGPU, WebAudio, WebRTC, Web Serial, IndexedDB
- a single file is the most portable artifact humans have invented since paper
- zero dependencies means zero supply chain risk
- if you can't email it, it's too complicated
- MIT license, software delivered as is

## roadmap

- [ ] web component widgets (`<audit-slider>`, etc.)
- [ ] export as app (strip editor, emit standalone page)
- [ ] callback widgets for real-time interaction (animation, audio)
- [ ] worker builtins for offloading computation
- [ ] embed system for binary data
- [ ] AF: af-bridge.js -- lightweight support library for AF-aware apps
  - save bridge (`AF.onSerialize`, `AF.markDirty`, `AF.setTitle`)
  - file access (`AF.readFile`, `AF.writeFile`, `AF.listFiles`)
  - worker delegation (`AF.runWorker`) -- app hands compute to AF's origin context, gets results back. enables heavy streaming workloads (e.g. block model processing) with direct FSAA handle access, no postMessage copying for raw data
  - inter-tab messaging (`AF.broadcast`, `AF.onMessage`)
  - graceful no-op when running standalone
- [ ] AF: packed boxes -- compressed box export using CompressionStream/DecompressionStream (gzip, zero dependencies). self-extracting, floppy-friendly
- [ ] AF: service worker backend for proper origins (PWA)
- [ ] AF: terminal / JS REPL panel
- [ ] AF: cross-notebook search

## license

MIT

---

part of the [geoscientific chaos union](https://gentropic.org) -- by [endarthur](https://endarthur.github.io)
