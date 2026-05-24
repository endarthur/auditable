# Getting Started

## Two flavors

Auditable ships as two files. Pick whichever fits the work you're starting.

| File | When to use |
|---|---|
| **`auditable.html`** | One notebook. Open it, work, save. Email the file. Best for self-contained reports and standalone documents. |
| **`works.html`** | A workspace shell. Hosts notebooks plus a terminal, docs reader, file preview, and settings in tabs. Best for sustained projects with multiple notebooks and files. See [Auditable Works](works.md). |

Both are single HTML files — no install, no server, no dependencies.

## Download

Get the latest `auditable.html` and `works.html` from the
[GitHub releases page](https://github.com/endarthur/auditable/releases) or directly
from [endarthur.github.io/auditable](https://endarthur.github.io/auditable/auditable.html).

## Opening auditable

Open `auditable.html` in a modern browser (Chrome, Firefox, or Edge). You will see an empty notebook with a toolbar at the top and an insert bar (`+`) below.

No web server is needed — `file://` works fine.

## Your first cell

Click the **+** button to create a code cell. Type:

```js
const x = 42
ui.display(x)
```

Press **Ctrl+Enter** to run. The output area below the cell shows `42`.

## Reactive dependencies

Add a second code cell:

```js
const y = x * 2
ui.display(y)
```

Run it with **Ctrl+Enter**. It displays `84`.

Now go back to the first cell, change `42` to `10`, and run it again. The second cell automatically re-executes and displays `20`. This is the reactive DAG at work —auditable tracks which cells define and use which variables, and re-runs downstream cells when inputs change.

!!! info "How the DAG works"
    `parseNames()` extracts definitions (`const x = ...`), `findUses()` detects references to other cells' variables. `buildDAG()` wires them into a dependency graph. `topoSort()` determines execution order. You don't need to think about any of this —just write code and let the notebook handle the plumbing.

## Markdown with interpolation

Add a markdown cell (click `+`, then press **M** or select Markdown from the cell type menu). Type:

```markdown
The value of x is **${x}**, and y is **${y}**.
```

The rendered output updates reactively whenever `x` or `y` changes. Expressions inside `${...}` are evaluated against the current scope.

## Adding a widget

Create a new code cell:

```js
const n = ui.slider("count", 10, {min: 1, max: 100})
ui.display("n = " + n)
```

Run it. A slider appears in the output. Drag it, and every cell that depends on `n` re-executes automatically.

Available widgets:

| Widget | Signature |
|--------|-----------|
| Slider | `ui.slider(label, default?, {min, max, step, onInput, onChange}?)` |
| Dropdown | `ui.dropdown(label, options, default?, {onInput, onChange}?)` |
| Checkbox | `ui.checkbox(label, default?, {onInput, onChange}?)` |
| Text input | `ui.textInput(label, default?, {onInput, onChange}?)` |

Without callbacks, widgets trigger reactive re-execution. With `onInput` or `onChange`, they call the closure directly —useful for high-frequency updates or imperative control.

## Saving

Press **Ctrl+S** or click the **SAVE** button in the toolbar. The browser downloads an updated `auditable.html` with all your cells, settings, and installed modules embedded. This works on `file://` URLs too —the keyboard shortcut is intercepted before the browser can open its "Save Page As" dialog.

The saved file is fully self-contained. Open it on another machine, send it by email, host it on a static site —it just works.

## Other cell types

Beyond code and markdown, auditable has two more cell types:

**CSS cells** —inject custom styles into the notebook. Useful for theming outputs or building app-like layouts.

```css
.my-chart { border: 1px solid #c89b3c; padding: 1em; }
```

**HTML cells** —write raw HTML with reactive template bindings and inline widgets:

```html
<div>
  <audit-slider name="power" min="0" max="100" value="50"></audit-slider>
  <p>Power is ${power}</p>
</div>
```

The `name` attribute on `<audit-slider>` defines a variable in scope. Downstream code cells can use `power` like any other reactive variable.

## Find & replace

Press **Ctrl+F** to open the find bar, or **Ctrl+H** to open find and replace. The find
bar supports case-sensitive matching and regular expressions (toggle with the **Aa** and
**.\*** buttons). Navigate matches with **Enter** / **Shift+Enter** or the arrow buttons.
Press **Escape** to close.

## Presentation mode

Press **p** in command mode to enter presentation mode — editors become read-only and
cells marked `// %hide` disappear. A floating **exit** button returns to normal editing.
See [Settings](settings.md#presentation-mode) for details.

## Keyboard shortcuts

Auditable uses a modal editing model inspired by Vim. Press **Escape** to enter command mode, **Enter** to edit a cell.

| Shortcut | Mode | Action |
|----------|------|--------|
| **Ctrl+Enter** | edit | Run cell |
| **Shift+Enter** | edit | Run cell and advance |
| **Ctrl+S** | any | Save notebook |
| **Ctrl+Shift+Enter** | any | Toggle autorun |
| **Ctrl+F** | any | Find in notebook |
| **Ctrl+H** | any | Find and replace |
| **j** / **k** | command | Navigate cells |
| **a** / **b** | command | Insert cell above / below |
| **dd** | command | Delete cell |
| **z** | command | Undo delete |
| **c** / **v** / **x** | command | Copy / paste / cut cell |
| **m** / **y** / **s** / **t** | command | Convert to md / code / css / html |
| **h** | command | Collapse / expand cell |
| **p** | command | Presentation mode |
| **e** | command | Split view |

See [Keyboard Shortcuts](keyboard.md) for the full reference.

## Or, try Auditable Works

If you're starting a project rather than a one-off, open `works.html` instead. Works is a tabbed workspace shell that hosts notebooks alongside a terminal, file preview, and other surfaces — see [Auditable Works](works.md).

A typical Works flow:

1. Open `works.html` in a Chromium-based browser (Chrome, Edge, Brave) for the full disk-folder integration; or any modern browser for the IndexedDB-backed default.
2. **File → New workspace…** to start (or **File → Open folder…** to mount a disk directory as your workspace home).
3. **File → New notebook…** creates a new notebook surface in the current project. Edit it the same way as a standalone `auditable.html`.
4. **Tools → Terminal** for a `geas` shell with `pkg` (package manager), `ed`, and the GCU coreutils.
5. **Help → Documentation (F1)** opens the docs surface with Ctrl+K search.

## Next steps

- [Cells](cells.md) — cell types, directives (`%manual`, `%norun`, `%hide`), and execution model
- [UI Builtins](builtins-ui.md) — `ui.*`, `load()`, `install()`, and other injected helpers
- [Standard Library](builtins-stdlib.md) — `std.*` functions for data, math, color, and DOM
- [Widgets](widgets.md) — slider, dropdown, checkbox, text input in code and HTML cells
- [Settings](settings.md) — theme, editor, execution mode, and presentation configuration
- [Export](export.md) — save modes, packed export, app export, and signatures
- [Auditable Works](works.md) — the workspace shell, surfaces, and how the docs surface works
