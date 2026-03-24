# @gcu/runtime — headless auditable notebooks

Run auditable notebooks in Node.js without a browser. Zero DOM dependencies.

## Quick start

```js
import { createNotebook } from './runtime.js';

const nb = createNotebook();
nb.addCell('code', 'const x = 10');
nb.addCell('code', 'const y = x * 2');
const result = await nb.run();
console.log(result.scope.y); // 20
```

## Loading notebooks

```js
// from a /// text definition
nb.loadTxt(fs.readFileSync('examples/defs/basics/idw.txt', 'utf8'));

// from a saved .html notebook
nb.loadHtml(fs.readFileSync('examples/basics/example_idw.html', 'utf8'));

// both return metadata
const { title, settings, moduleUrls } = nb.loadTxt(txt);
const { title, settings, modules } = nb.loadHtml(html);
```

## Static analysis

Inspect the dependency graph without executing anything:

```js
nb.loadTxt(src);
const graph = nb.analyze();
// [
//   { id: 0, type: 'code', defines: ['radius'], uses: [] },
//   { id: 1, type: 'code', defines: ['area'], uses: ['radius'] },
// ]
```

## Running

```js
const result = await nb.run();

result.scope    // { radius: 5, area: 78.54... } — all defined variables
result.cells    // per-cell results: [{ id, defines, output, error }, ...]
result.poisoned // Set of variable names blocked by upstream errors
```

## Standard library

`std` is injected automatically — `std.csv`, `std.sum`, `std.color`, etc. all work. `load('@std')` also works.

```js
nb.addCell('code', 'const avg = std.mean([1, 2, 3, 4, 5])');
nb.addCell('code', 'const { sum } = await load("@std")');
```

Available: csv, sum, mean, median, extent, bin, linspace, unique, zip, cross, fmt, include, color, colorScale, hsl, viridis/magma/inferno/plasma/turbo, palette10, zipArchive, unzipArchive.

Not available headlessly: file, download, el, copy, fetchJSON, VFS, path (these require browser APIs).

## Module loading

```js
const nb = createNotebook({
  // pre-loaded module registry
  modules: {
    '@my/lib': myLibModule,
    'https://esm.sh/d3': d3Module,
  },
  // fallback for URLs not in registry
  load: async (url) => import(url),
});
```

Resolution order: registry → custom loader → error. Results cached across cells.

`install()` delegates to `load()` (no persistence in headless mode).

## Plugin cell types

```js
const nb = createNotebook({
  cellTypes: {
    calc: {
      parseNames: (code) => new Set(['result']),
      findUses: (code, allDefined) => new Set([...allDefined].filter(n => code.includes(n))),
      execute: async (code, upstream, cell) => {
        const val = eval(code);
        return { defines: { result: val } };
      },
    },
  },
});

nb.addCell('calc', '2 + 2');
nb.addCell('code', 'const doubled = result * 2');
const r = await nb.run();
// r.scope.doubled === 8
```

Handlers:
- `parseNames(code)` → Set of variable names this cell defines
- `findUses(code, allDefined)` → Set of variable names this cell references
- `execute(code, upstream, cell)` → `{ defines: { name: value }, output? }`

## Serialization

```js
nb.serialize()              // JSON-ready cell array: [{ type, code, collapsed? }, ...]
nb.toTxt('title', settings) // /// format string
```

## API reference

### `createNotebook(options?)`

Returns a notebook instance. Options:

| Option | Type | Description |
|--------|------|-------------|
| `modules` | `Object` | URL → module mapping for `load()` |
| `load` | `async (url) => module` | Fallback loader for unknown URLs |
| `cellTypes` | `Object` | Plugin type handlers |

### Notebook methods

| Method | Returns | Description |
|--------|---------|-------------|
| `addCell(type, code)` | cell object | Add a cell |
| `removeCell(id)` | void | Remove a cell by ID |
| `run()` | `{ scope, cells, poisoned }` | Execute all cells |
| `analyze()` | `[{ id, type, defines, uses }]` | Static dependency graph |
| `loadTxt(content)` | `{ title, settings, moduleUrls }` | Load from /// format |
| `loadHtml(html)` | `{ title, settings, modules }` | Load from saved HTML |
| `serialize()` | `[{ type, code, collapsed? }]` | Serialize cells |
| `toTxt(title?, settings?, moduleUrls?)` | string | Export as /// format |
| `cells` | array | Direct access to cell objects |

## Architecture

```
stdlib-core.js (pure std)  ─┐
dag-core.js (pure analysis) ├─ runtime.js (headless)
engine.js (pure execution)  │
serialize.js (pure I/O)    ─┘
```

All four dependencies have zero DOM imports. The runtime runs in any JS environment with `AsyncFunction` and `TextEncoder` (Node 18+).
