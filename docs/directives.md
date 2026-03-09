# Directives

Directives are special comments that control cell behavior. They use the pattern `// %name` — a JavaScript line comment followed by a percent sign and the directive name.

```js
// %manual
// %cellName myLoop
const result = expensiveComputation(data);
```

!!! tip

    Multiple directives can appear in the same cell. Place them at the top of the cell for clarity.

---

## Execution Control

### `// %manual`

Excludes the cell from reactive updates. The cell will **not** re-execute when upstream dependencies change. It only runs when explicitly triggered:

- ++ctrl+enter++ on the cell
- **Run All** from the toolbar

```js
// %manual
// This cell runs an animation loop — we don't want it restarting
// every time an upstream value changes.
function animate() {
  grid = step(grid);
  ui.canvas(render(grid), 400, 400);
  requestAnimationFrame(animate);
}
animate();
```

!!! info "When to use `%manual`"

    Use `// %manual` for imperative apps with mutable state, animation loops, or any cell where automatic re-execution would be disruptive. Combine with widget callbacks (`onInput`, `onChange`) for interactive control without reactive overhead.

### `// %norun`

Prevents the cell from running on reactive upstream changes. Unlike `%manual`, norun cells are also skipped when a dependent triggers them through the DAG. They still run on **Run All** and on **initial load** (since both pass all cell ids as dirty). You can also run a norun cell explicitly with ++ctrl+enter++. Useful for expensive computations you want to trigger only on demand.

```js
// %norun
// Reference implementation — kept for comparison, not executed.
function naiveSolution(data) {
  return data.map(d => bruteForce(d));
}
```

---

## Presentation

### `// %hide`

Hides the cell in **presentation mode**. The cell still executes normally and its outputs are still visible — only the source editor is hidden. Use this to keep setup code out of a clean presentation view.

```js
// %hide
// Data loading and preprocessing — not interesting to show in a presentation.
const raw = await fetch("data.json").then(r => r.json());
const data = raw.filter(d => d.value > 0).map(normalize);
```

### `// %collapsed`

Starts the cell in a collapsed state. The cell executes normally, but the editor is initially folded to save vertical space. Click the cell header to expand it.

```js
// %collapsed
// Utility functions — collapse by default to reduce clutter.
function normalize(d) { return { ...d, value: d.value / d.max }; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
```

### `// %bare`

Indicates that the notebook should be exported as a standalone app **without** the default auditable base styles. Use this when building a fully custom-styled application where the default theme would interfere.

```js
// %bare
// This notebook is a standalone app with its own CSS.
```

---

## Cell Naming & Control Flow

### `// %cellName label`

Assigns a name to a cell. The name appears in the cell header for identification and can be used as a target for `// %goto`.

```js
// %cellName setup
const config = { iterations: 1000, threshold: 0.01 };
```

### `// %goto cellName`

Jumps to a named cell during DAG execution, creating a loop. When the DAG reaches a cell with `// %goto`, execution continues from the target cell instead of proceeding to the next cell in document order.

The directive is parsed from the cell source text before execution — it is not a runtime statement. To make the jump conditional, the cell code can set `__goto = ""` to suppress it:

```js
// %cellName iterate
// %manual
iteration++;
error = computeError(state);
if (error > threshold) {
  state = updateState(state);
}
```

```js
// %goto iterate
// %manual
if (error <= threshold) __goto = "";
```

!!! warning "Loop protection"

    `%goto` has a hard limit of **1000 iterations** to prevent infinite loops. If the limit is reached, execution stops and an error is reported.

---

## Output Customization

### `// %outputId id`

Sets the `id` attribute on the cell's output `<div>`. Useful for targeting the output element with CSS or JavaScript from other cells.

```js
// %outputId main-chart
ui.canvas(renderChart(data), 800, 400);
```

```css
/* In a CSS cell */
#main-chart {
  border: 2px solid var(--accent);
  margin: 1rem auto;
}
```

### `// %outputClass cls`

Adds one or more CSS classes to the cell's output `<div>`. Multiple classes are space-separated.

```js
// %outputClass wide centered
ui.display(buildDashboard(data));
```

```css
/* In a CSS cell */
.wide { max-width: 100%; }
.centered { margin: 0 auto; }
```

---

## Summary

| Directive              | Effect                                      | Execution Impact     |
|------------------------|---------------------------------------------|----------------------|
| `// %manual`           | Skip reactive updates                       | Only Ctrl+Enter / Run All |
| `// %norun`            | Skip on reactive changes                    | Only Ctrl+Enter / Run All |
| `// %hide`             | Hidden in presentation mode                 | None                 |
| `// %collapsed`        | Start cell collapsed                        | None                 |
| `// %bare`             | Export without base styles                   | None                 |
| `// %cellName label`   | Name the cell                               | None                 |
| `// %goto cellName`    | Jump to named cell                          | Redirects DAG flow   |
| `// %outputId id`      | Set output element id                       | None                 |
| `// %outputClass cls`  | Set output element CSS classes              | None                 |
