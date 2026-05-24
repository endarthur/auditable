# Plugins

Auditable supports custom cell types and tagged languages beyond the built-in js / md / css / html. Plugins register through a single API — `auditable.registerExtension(manifest)` — and integrate with the reactive DAG, the editor, the cell type picker, the AIR compiler, and the cell context.

## The unified extension API

Everything an extension contributes (cell types, tagged languages, AIR lowerers, cross-language exports, cell-context hooks, plugin metadata) goes through one call:

```js
auditable.registerExtension({
  name: 'mylang',
  version: '0.1.0',
  cellType: { /* ... */ },
  taggedLanguage: { /* ... */ },
  airLowerer: { /* ... */ },
  contextHook: { /* ... */ },
  exports: { /* ... */ },
});
```

The manifest is validated at registration: required `name` + semver `version`, capability declarations imply matching methods, built-in cell type names (`code`, `md`, `css`, `html`) cannot be shadowed.

A small plugin registering a new cell type is just:

```js
auditable.registerExtension({
  name: 'mylang',
  version: '0.1.0',
  description: 'My custom cell language',
  cellType: {
    name: 'mylang',
    label: 'My Language',
    color: '#e06c75',
    capabilities: { executable: true, definesScope: true, hasOutput: true, hasEditor: true },
    execute: async (code, scope, cell) => {
      const result = evaluate(code);
      return { defines: { answer: result } };
    },
    parseNames: (code) => new Set(['answer']),
    findUses: (code, allDefined) => new Set(),
    tokenize: (code) => [ /* ... */ ],
  },
});
```

After registration, the new type appears in the cell type picker and cells of that type become full reactive DAG participants.

---

## Manifest reference

| Top-level key | Type | Purpose |
|---|---|---|
| `name` | `string` | Unique extension name; used as the registry key (required) |
| `version` | `string` | Semver `MAJOR.MINOR.PATCH` (required) |
| `description` | `string` | Surfaced in the settings panel and `listExtensions()` |
| `pluginUrl` | `string` | Source URL for install/uninstall tracking (optional) |
| `cellType` | `object` | Cell-type contribution (see below) |
| `taggedLanguage` | `object` | Single tagged-language contribution |
| `taggedLanguages` | `object[]` | Multiple tagged-language contributions |
| `airLowerer` | `object` | AIR lowerer contribution (for transpile-to-AIR languages) |
| `contextHook` | `object` | Cell-context hook (see below) |
| `exports` | `object` | Named exports accessible via `getExtension(name)` |
| `globals` | `object` | Window globals to set (use sparingly) |
| `onActivate` | `function` | Called once at registration |

### `cellType`

| Key | Type | Description |
|---|---|---|
| `name` | `string` | Cell-type identifier (`'adder'`, `'mylang'`); required, can't shadow built-ins |
| `label` | `string` | Display name in the type picker (defaults to `name`) |
| `color` | `string` | Hex accent for the cell header label |
| `shortcut` | `string` | Single key for cycling through cell types in command mode |
| `editDebounce` | `number` | ms before re-execution after editor change (default 300) |
| `capabilities` | `object` | `{ executable, definesScope, hasOutput, hasEditor, builtin }` — declares contract; required |
| `execute` | `async (code, scope, cell) => { defines?, output? }` | Run the cell; required if `executable: true` |
| `parseNames` | `(code) => Set<string>` | Top-level names this cell defines; required if `definesScope: true` |
| `findUses` | `(code, allDefined) => Set<string>` | Names this cell uses from other cells |
| `tokenize` | `(code) => Token[]` | Tokens for syntax highlighting |
| `completions` | `(prefix) => string[]` | Autocomplete suggestions |
| `syntaxCheck` | `(code) => boolean` | Fast validation for live error indicators |
| `createEditor` | `(cell, onChange) => { el, destroy? }` | Custom editor element (optional — defaults to CodeMirror) |

The `capabilities` object tells the runtime what your cell type does without it having to introspect handlers. Capability queries via `auditable.getCellType(name)` use these declarations directly.

### `taggedLanguage`

For tagged-template languages (`` shader`...` ``, `` sql`...` ``):

| Key | Type | Description |
|---|---|---|
| `name` | `string` | Tag function name |
| `tokenize` | `(code) => Token[]` | Required |
| `completions` | `(prefix) => string[]` | Optional |
| `sigHint` | `(code, pos) => string` | Optional signature hint |
| `indent` | `(code, line) => number` | Optional indent helper |

### `airLowerer`

For languages compiled to AIR (the internal SSA IR — adder, soft, future custom languages):

```js
airLowerer: {
  language: 'mylang',
  fn: lowerMylangToAir,   // (ast, ctx) => AIR module
}
```

Registered with AIR via `window._airRegisterLowerer` at extension activation.

### `contextHook`

Lifecycle callbacks that fire before/after cell execution:

```js
contextHook: {
  setup: (ctx, cell) => { /* ... */ },
  before: (scope, cell) => { /* ... */ },
  after: (scope, cell, output) => { /* ... */ },
}
```

Useful for languages that need per-cell setup (e.g. adder needs to track the active cell context for `display()` to work).

---

## Lookup API

Read-side counterparts to `registerExtension`:

| Function | Returns |
|---|---|
| `auditable.getExtension(name)` | The manifest for a registered extension |
| `auditable.listExtensions()` | All registered manifests (includes built-ins) |
| `auditable.getCellType(name)` | The cell-type contribution for `name`, or undefined |
| `auditable.getTaggedLanguage(name)` | The tagged-language contribution for `name`, or undefined |
| `auditable.getExports(name)` | The `exports` object for an extension |
| `auditable.hasExports(name)` | `true` if extension has named exports |

Built-in cell types (`code`, `md`, `css`, `html`) are auto-registered as manifests with `capabilities.builtin = true` — they appear in `listExtensions()` just like third-party extensions.

---

## Execute function

The `execute` function receives three arguments:

| Argument | Description |
|---|---|
| `code` | The cell's source code |
| `scope` | Object containing upstream variable values (only names from `findUses`) |
| `cell` | The cell object — access `cell._ctx` for display, widgets, invalidation, load, install, etc. |

`cell._ctx` is the per-cell context created before each execution — same builtins available to code cells: `ui`, `std`, `load`, `install`, `display`, `invalidation`, `worker`, `workerPool`, `notebook`, `vfs`, etc.

Return:

- `defines` — `{ name: value }` map of variables to inject into downstream scope
- `output` — DOM element or string to render in the output area (optional; cells can also call `ctx.display(...)` directly)

```js
execute: async (code, scope, cell) => {
  const ctx = cell._ctx;
  ctx.display('Running…');
  const result = await myInterpreter(code, scope);
  return { defines: result.vars, output: result.html };
}
```

---

## DAG integration

For a cell type to participate in the reactive dependency graph:

- **`parseNames(code)`** — return a `Set` of variable names the cell defines. The DAG uses this to know what downstream cells can depend on.
- **`findUses(code, allDefined)`** — return a `Set` of names from `allDefined` the cell references. The DAG uses this to determine upstream dependencies.

Both must be synchronous and fast — they run on every keystroke during DAG rebuilds. If you don't provide them, the cell can still execute but won't define scope variables or react to upstream changes (set `capabilities.definesScope: false` to make the declaration honest).

---

## Plugin lifecycle

1. **Before plugin loads:** cells of the plugin type render as fallback — grayed-out label, textarea editor, not executable.
2. **On `registerExtension`:** pending cells activate — the editor replaces the textarea, the DAG rebuilds, cells execute.
3. **On uninstall:** cells revert to fallback state, plugin editors destroy, the DAG rebuilds without those cells.

Plugins uninstalled via `_ctUninstallPlugin(url)` remove the cell type, revert all affected cells, and clean up the module cache.

!!! info "Reference implementations"
    - [adder](adder/index.md) — Python dialect. Reference for cell types + AIR lowerers + context hooks. See `ext/adder/src/register.js`.
    - [@gcu/soft](https://github.com/endarthur/auditable/tree/main/ext/soft) — English-keyword language. Reference for simpler cell types.
    - [@gcu/sql](https://www.npmjs.com/package/@gcu/sql) — tagged-template only (no cell type). Reference for `taggedLanguage` contributions.

---

## Built-in cell types

These are always available; they register themselves at startup with `capabilities.builtin = true`:

| Type | Label | Description |
|---|---|---|
| `code` | js | JavaScript — reactive, defines scope variables |
| `md` | md | Markdown — rendered, can use `${expr}` bindings |
| `css` | css | CSS — applied as a `<style>` element |
| `html` | html | HTML — rendered, can define widgets, uses `${expr}` bindings |
