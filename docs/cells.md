# Cells & Reactivity

Auditable notebooks are built from **cells** — editable blocks that hold code, prose, styles, or markup. Cells form a reactive dependency graph: when one cell's output changes, all downstream cells automatically re-execute.

## Cell Types

| Cell     | Type   | DAG Role           | Defines         | Uses | Key | Label |
|----------|--------|--------------------|-----------------|------|-----|-------|
| Code     | `code` | reactive r/w       | yes             | yes  | `y` | code  |
| Markdown | `md`   | reactive read-only | no              | yes  | `m` | md    |
| CSS      | `css`  | static side effect | no              | no   | `s` | css   |
| HTML     | `html` | reactive r/w       | yes (widgets)   | yes  | `t` | html  |

!!! tip "Converting between types"

    In **command mode** (click outside the editor area, or press `Escape`), press the corresponding key to convert the selected cell:

    - ++m++ — Markdown
    - ++y++ — Code
    - ++s++ — CSS
    - ++t++ — HTML

    See [Keyboard Shortcuts](keyboard.md) for the full shortcut reference.

---

## Code Cells

Code cells are the primary computational unit. They run JavaScript inside an `AsyncFunction` and can define variables that other cells depend on.

### Defining Variables

`parseNames` extracts top-level variable declarations from cell source. Supported patterns:

```js
// simple declarations
const x = 42;
let name = "auditable";
var count = 0;

// function declarations
function greet(who) { return `hello, ${who}`; }

// destructuring
const { width, height } = dimensions;
const [first, ...rest] = items;

// comma-separated
const a = 1, b = 2, c = 3;
```

!!! warning "Scope boundaries"

    Only **top-level** declarations are extracted. Variables declared inside functions, loops, or blocks are local to that scope and not visible to other cells.

### Using Variables from Other Cells

`findUses` determines which names from other cells a given cell references. If cell A defines `x` and cell B uses `x`, then B depends on A.

```js
// Cell A
const data = [1, 2, 3, 4, 5];
```

```js
// Cell B — automatically depends on Cell A
const total = data.reduce((a, b) => a + b, 0);
```

---

## Markdown Cells

Markdown cells hold prose rendered as HTML. They support standard Markdown syntax (headings, bold, italic, links, code blocks, lists) and **expression interpolation**.

### Expression Interpolation

Use `${expr}` to embed live values from upstream cells:

```markdown
The dataset contains **${data.length}** records
with a mean value of ${std.mean(values).toFixed(2)}.
```

Markdown cells are **reactive read-only** — they react to upstream changes (re-rendering interpolated expressions) but do not define any variables themselves.

!!! note

    Interpolated expressions are patched in place using comment markers. The DOM is not destroyed and rebuilt on each update.

---

## CSS Cells

CSS cells inject global styles into the page. They are **not reactive** — they don't participate in the dependency graph and don't track or define variables.

```css
.chart-container {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1rem;
}

.highlight {
  color: var(--accent);
  font-weight: bold;
}
```

CSS cells are applied as `<style>` elements. They take effect immediately and persist for the lifetime of the notebook session.

---

## HTML Cells

HTML cells combine markup with reactivity. They support two powerful features:

### Expression Interpolation

Like Markdown cells, HTML cells can embed `${expr}` in both text content and attributes:

```html
<div class="status ${active ? 'on' : 'off'}">
  Count: <strong>${count}</strong>
</div>
```

Interpolation uses two-track patching — comment markers for text content and `data-audit-abind` markers for attributes. Only bound nodes are updated; the rest of the DOM is untouched, so interactive elements survive re-renders.

### Widget Defines

HTML cells can **define scope variables** by placing `<audit-*>` widgets with `name` attributes directly in the markup:

```html
<audit-slider name="power" min="0" max="100" value="50"></audit-slider>
<audit-dropdown name="mode" options="fast,balanced,precise"></audit-dropdown>
<audit-checkbox name="verbose" checked></audit-checkbox>
<audit-text-input name="label" value="default"></audit-text-input>
```

Each `name` attribute registers a variable in the reactive scope. Downstream cells that reference `power`, `mode`, `verbose`, or `label` will automatically re-execute when the widget value changes.

!!! info "Widgets in code cells vs. HTML cells"

    In **code cells**, widgets are created via `ui.slider()`, `ui.dropdown()`, etc., keyed by label string. In **HTML cells**, widgets are placed directly in markup with `name` attributes. Both approaches integrate with the reactive DAG. See [Widgets](widgets.md) for full API details.

---

## The Reactive DAG

Auditable builds a **directed acyclic graph** (DAG) of cell dependencies:

1. **`parseNames(code)`** extracts which variables each code cell defines.
2. **`parseHtmlDefines(html)`** extracts widget names from HTML cells.
3. **`findUses(code, allDefined)`** determines which defined names each cell references.
4. **`buildDAG()`** assembles the full dependency graph.

When a cell is edited or a widget value changes:

1. **`topoSort(dirtyIds)`** performs a BFS from the dirty cell to find all downstream dependents.
2. Cells are re-executed in **document order** (the order they appear on the page).
3. **Value-equality gating** skips re-execution if a cell's inputs haven't actually changed.
4. **Error isolation** marks variables as "poisoned" when their defining cell errors, preventing silent propagation of bad values.

```
Cell A (defines x) ──→ Cell C (uses x, y) ──→ Cell D (uses z)
Cell B (defines y) ──↗                         ↑
                                Cell C defines z ─┘
```

!!! example "Reactive flow"

    Editing **Cell A** marks it dirty. The DAG finds that **Cell C** depends on `x` (defined by A), so C is queued. Then **Cell D** depends on `z` (defined by C), so D is also queued. Cells execute in document order: A, then C, then D.

---

## The Scope Model

Each cell runs inside an `AsyncFunction`. Upstream variables are passed as **function parameters** — scope is passed by value, not by reference.

```js
// Conceptually, Cell B executes as:
(async function(x, y, ui, std, load, install, invalidation) {
  // cell B's code here
  const z = x + y;
  return { z };
})(valueOfX, valueOfY, ...builtins);
```

!!! warning "Mutable state across cells"

    Because scope is passed by value, **cross-cell mutable state via reassignment does not work**:

    ```js
    // Cell A
    let grid = initialGrid;
    ```

    ```js
    // Cell B — gets its own copy of grid
    grid = nextGrid;  // this does NOT update Cell A's grid
    ```

    For imperative apps with mutable state, use `// %manual` cells with callbacks. See [Directives](directives.md) for all available cell directives.

    ```js
    // %manual
    // This cell only runs on Ctrl+Enter, not on upstream changes.
    // Use callbacks from widgets or requestAnimationFrame for state updates.
    ```

### Cell Builtins

Every cell receives these injected parameters (not propagated through scope):

| Builtin        | Description                                              |
|----------------|----------------------------------------------------------|
| `ui`           | `{ display, print, canvas, table, slider, dropdown, checkbox, textInput }` |
| `std`          | Standard library (`@std`) — csv, sum, mean, linspace, etc. |
| `load(url)`    | Import an ESM module (cached). Supports virtual modules: `@std`, `@python`, `@atra/<name>` |
| `install(url)` | Fetch, store, and import a module (persists across saves) |
| `installBinary(url, opts?)` | Fetch and store a binary asset as base64 |
| `invalidation` | Promise that resolves before cell re-runs (for cleanup)  |
| `print`        | Alias for `ui.display`                                   |

See [Modules](modules.md) for full documentation on `load()`, `install()`, and virtual modules.

---

## Split View

Press **e** in command mode (or click the toolbar button) to toggle split view. This replaces the normal cell-by-cell interface with a two-pane layout:

- **Left pane** — a single CM6 text editor showing the entire notebook in the `///` plain-text format. Full syntax highlighting (JS, CSS, HTML, Markdown), autocomplete, and `///` directive completions.
- **Right pane** — live outputs rendered as you type. Each cell's output appears in document order.

Changes in the text editor are debounced (800ms) and synced back to the notebook. Structural changes (adding/removing cells, changing cell types) trigger a full rebuild; code-only changes do an incremental update and re-run only dirty cells.

Press **Ctrl+Enter** or **Shift+Enter** in the split editor for an immediate sync + run (no debounce delay). Press **Escape** to exit split view and return to the normal notebook interface.

### The `///` format

The split editor uses a plain-text format where `///` lines are directives:

```
/// auditable
/// title: My Notebook

/// code
const x = 42
ui.display(x)

/// md
The value is **${x}**.

/// css
.highlight { color: var(--accent); }

/// code collapsed
// this cell starts collapsed
const y = x * 2
```

Directives: `/// code`, `/// md`, `/// css`, `/// html`. Append `collapsed` to start a cell collapsed. `/// title:` and `/// module:` set notebook metadata. This is also the format used by Export TXT in the save tray.
