# Plugins

Auditable supports custom cell types beyond the built-in js, md, css, and html. Plugins
register new cell types that integrate with the reactive DAG, the editor, and the cell
type picker.

## Registering a Cell Type

```js
registerCellType("myLang", {
  label: "My Language",
  color: "#e06c75",

  execute: async (code, scope, cell) => {
    const result = evaluate(code);
    return { defines: { answer: result } };
  },

  parseNames: (code) => new Set(["answer"]),
  findUses: (code, allDefined) => new Set(),

  tokenize: (code) => [
    { from: 0, to: 5, type: "keyword" }
  ],
});
```

After registration, the new type appears in the cell type picker and cells of that type
become fully reactive DAG participants.

---

## Handler Interface

| Property | Type | Description |
|----------|------|-------------|
| `label` | `string` | Display name in the type picker |
| `color` | `string` | Hex color for the cell header label |
| `shortcut` | `string` | Single key for cycling through cell types |
| `execute` | `async (code, scope, cell) -> { defines?, output? }` | Run the cell code, return defined variables |
| `parseNames` | `(code) -> Set<string>` | Extract variable names this cell defines |
| `findUses` | `(code, allDefined) -> Set<string>` | Find cross-cell variable references |
| `tokenize` | `(code) -> token[]` | Token stream for syntax highlighting |
| `completions` | `(prefix) -> string[]` | Autocomplete suggestions |
| `syntaxCheck` | `(code) -> boolean` | Fast syntax validation for live error indicators |
| `createEditor` | `(cell, onChange) -> { el, destroy? }` | Custom editor element (optional — defaults to CodeMirror) |
| `editDebounce` | `number` | Debounce delay in ms before re-execution (default: 300) |

All properties except `label` are optional. At minimum, provide `execute` for a
runnable cell type.

!!! tip
    If your handler provides `tokenize` but not `createEditor`, the default CodeMirror
    editor is used with your tokenizer for syntax highlighting.

---

## Execute Function

The `execute` function receives three arguments:

| Argument | Description |
|----------|-------------|
| `code` | The cell's source code as a string |
| `scope` | Object containing upstream variable values (only names from `findUses`) |
| `cell` | The cell object — access `cell._ctx` for display, widgets, and invalidation |

The cell context (`cell._ctx`) is created before each execution and provides the same
builtins available to code cells: `ui`, `std`, `load`, `install`, `display`,
`invalidation`, `worker`, `workerPool`, `notebook`, `vfs`, and more.

Return an object with:

- **`defines`** — object of `{ name: value }` pairs to inject into downstream scope
- **`output`** — optional DOM element or string to render in the output area

```js
execute: async (code, scope, cell) => {
  const ctx = cell._ctx;
  ctx.display("Running...");
  const result = myInterpreter(code, scope);
  return { defines: result.vars, output: result.html };
}
```

---

## DAG Integration

For a plugin cell type to participate in the reactive dependency graph, provide
`parseNames` and `findUses`:

- **`parseNames(code)`** — returns a `Set` of variable names that the cell defines.
  The DAG uses this to know what downstream cells can depend on.

- **`findUses(code, allDefined)`** — returns a `Set` of names from `allDefined` that
  the cell references. The DAG uses this to determine upstream dependencies.

If these are not provided, the cell can still execute but won't define scope variables
or react to upstream changes.

!!! warning
    `parseNames` and `findUses` must be synchronous and fast — they run on every
    keystroke during DAG rebuilds.

---

## Module Registration

Plugins can register importable modules accessible from other cells:

```js
registerExtension("myLib", { someFunction, anotherFunction });

// Other cells can then:
const { someFunction } = await load("myLib");
```

Use `hasExtension(name)` and `getExtension(name)` to query registered extensions at
runtime.

---

## Plugin Registration

Track plugin metadata for the settings panel with `registerPlugin`:

```js
registerPlugin("https://example.com/my-plugin.js", {
  name: "My Plugin",
  description: "A custom cell type for my language",
  types: ["myLang"]
});
```

The URL is used as the plugin identifier for install/uninstall tracking.

---

## Plugin Lifecycle

1. **Before plugin loads:** Cells of the plugin type show as fallback — grayed-out
   label, textarea editor, not executable
2. **On `registerCellType`:** Pending cells activate — the editor replaces the textarea,
   the DAG rebuilds, and cells execute
3. **On plugin uninstall:** Cells revert to fallback state, plugin editors are destroyed,
   the DAG rebuilds without those cells

Uninstall is handled by `_ctUninstallPlugin(url)`, which removes the cell type,
reverts all affected cells, and cleans up the module cache.

!!! info "Reference implementation"
    Adder (the Python dialect) is the reference plugin. See [adder](adder/index.md) for a
    working example, and `ext/adder/src/register.js` for the registration code.

---

## Capability Queries

The cell type system exposes query helpers for checking what a type supports:

| Function | Returns `true` when |
|----------|-------------|
| `_ctIsExecutable(type)` | Cell can be run (has `execute` handler) |
| `_ctDefinesScope(type)` | Cell defines scope variables (has `parseNames`) |
| `_ctHasOutput(type)` | Cell has an output area |
| `_ctHasEditor(type)` | Cell has a CM6 editor (has `createEditor` or `tokenize`) |
| `_ctIsPlugin(type)` | Type is a registered plugin (not built-in) |
| `_ctIsBuiltin(type)` | Type is one of the four built-in types |

---

## Built-in Types

These types are always available and cannot be overridden by plugins:

| Type | Label | Description |
|------|-------|-------------|
| `code` | js | JavaScript — reactive, defines scope variables |
| `md` | md | Markdown — rendered, can use `${expr}` bindings |
| `css` | css | CSS — applied as a `<style>` element |
| `html` | html | HTML — rendered, can define widgets, uses `${expr}` bindings |
