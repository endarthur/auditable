# Scope Model

Understanding how cells share data is essential for building reactive notebooks
in auditable. This page explains the scope mechanism, its constraints, and
patterns for working with mutable state.

## How Cells Share Data

Each cell runs inside an `AsyncFunction`. Upstream variables are passed as
**function parameters** — effectively by value. This creates a reactive
dataflow where changes propagate automatically through the dependency graph.

```js
// Cell 1
const x = 10
const y = 20

// Cell 2 (automatically receives x and y)
const sum = x + y  // 30
```

### The Pipeline

1. **`parseNames(code)`** extracts top-level variable definitions from cell
   source: `const`, `let`, `var`, destructuring, comma-separated declarations,
   and `function` declarations.

2. **`findUses(code, allDefined)`** determines which names from other cells a
   given cell references.

3. **`buildDAG()`** creates the full dependency graph across all cells,
   including HTML cell widget defines.

4. **`topoSort(dirtyIds)`** performs a BFS from dirty cells to find all
   downstream dependents and returns the execution order.

5. **`runDAG(dirtyIds)`** rebuilds scope from scratch in document order,
   executing each cell with its resolved upstream values.

### What Gets Captured

`parseNames` handles these declaration forms:

```js
const x = 1                        // simple
let y = 2                          // let
var z = 3                          // var
const { a, b } = obj               // object destructuring
const { a: renamed } = obj          // rename destructuring
const [first, second] = arr         // array destructuring
const a = 1, b = 2                  // comma-separated
function myFunc() { ... }           // function declaration
```

!!! warning "Only top-level declarations"
    Variables declared inside blocks (`if`, `for`, functions) are **not**
    captured. Only top-level declarations become part of the cell's defines.

    ```js
    const x = 1          // captured
    if (true) {
      const y = 2        // NOT captured
    }
    function f() {
      const z = 3        // NOT captured
    }
    ```

## Value-Equality Gating

When a cell re-executes, `runDAG` compares its new output values against the
previous ones. If all values are identical (by reference or deep equality for
simple types), downstream cells are **skipped**. This prevents unnecessary
cascade re-execution.

## The Mutable State Problem

Because upstream variables are passed by value as function parameters,
**cross-cell mutable state via reassignment does not work**:

```js
// Cell A
let grid = createGrid()

// Cell B — sees the ORIGINAL grid, not updates from Cell A
grid[0][0] = 1  // modifies a copy of the reference
```

If Cell A later does `grid = nextGeneration(grid)`, Cell B still holds the old
reference from when it was last executed.

### Solutions for Mutable State

#### Pattern 1: Manual Cells with Callbacks

Use `// %manual` to opt out of reactive re-execution. Combine with widget
callbacks for imperative control:

```js
// %manual
const canvas = ui.canvas(400, 400)
const ctx = canvas.getContext('2d')
let state = initState()

ui.slider('speed', 1, 10, 5, { onInput(v) {
  state.speed = v
  draw()
}})

function draw() {
  // update and render using mutable state
}

const interval = setInterval(draw, 16)
invalidation.then(() => clearInterval(interval))
```

#### Pattern 2: Immutable Data Flow

Structure your notebook so each cell produces new values rather than mutating
shared state:

```js
// Cell 1
const data = await fetch('data.json').then(r => r.json())

// Cell 2
const filtered = data.filter(d => d.value > threshold)

// Cell 3
const summary = { mean: std.mean(filtered.map(d => d.value)) }
```

## HTML Cell Widget Scope

HTML cells can define widgets that inject values into scope:

```html
<audit-slider name="power" min="0" max="100" value="50">
<audit-dropdown name="method" options="kriging,idw,nearest">
```

The `name` attribute creates a variable in scope. Downstream code cells can
reference `power` and `method` directly. When the user interacts with a widget,
all dependent cells re-execute automatically.

## The `invalidation` Promise

Every cell receives an `invalidation` promise that resolves just before the
cell re-runs. Use it to clean up side effects:

```js
// Start an animation loop
const canvas = ui.canvas(400, 400)
const ctx = canvas.getContext('2d')

const interval = setInterval(() => {
  ctx.clearRect(0, 0, 400, 400)
  // ... draw frame
}, 16)

// Clean up when cell re-executes
invalidation.then(() => clearInterval(interval))
```

!!! tip "Always clean up"
    Without invalidation cleanup, re-executing a cell that creates intervals,
    event listeners, or WebSocket connections will leak resources. Each
    re-execution would add another listener or interval without removing the
    previous one.

## Cell Builtins

Each cell receives these injected parameters (not propagated via scope):

| Name | Description |
|------|-------------|
| `ui` | Display and widget API: `display`, `print`, `canvas`, `table`, `slider`, `dropdown`, `checkbox`, `textInput` |
| `std` | Standard library (`@std`) |
| `load(url)` | Import ESM module (cached). Virtual modules: `@std`, `@python`, `@python/this`, `@atra/<name>` |
| `install(url)` | Fetch, store, and import a module. Persists across saves |
| `installBinary(url, opts?)` | Fetch and store a binary asset as base64. Returns blob URL |
| `invalidation` | Promise that resolves before cell re-runs |
| `print` | Alias for `ui.display` |
