# Auditable Extension Specification

**The contract every `@gcu/*` extension implements.**

This document is the source of truth for what an Auditable / Works extension is, how it registers, what surfaces it can contribute to, how it packages, and how it ships — whether built in-tree under `ext/` or developed entirely outside this monorepo.

Status: **pre-1.0**. The manifest API is stable enough that ~20 in-tree extensions ride on it; the version field is enforced as semver; capability axes are well-defined. But the project is pre-1.0 and breaking changes ship without deprecation windows. Anchor your extension to a specific auditable build until 1.0.

Audience: anyone writing an extension. In-tree authors get to add files to `ext/<name>/`; out-of-tree authors get to publish a package and have users `install()` it from a CDN URL. The contract is the same either way.

---

## 0. Cold-start for AI sessions (read this first)

If you're a Claude Code session in another repo and a user has just asked "make this an auditable-compatible extension," here's the orientation:

**What you're building.** A plain ES module that registers itself with the host via `window.auditable?.registerExtension(manifest)` at module evaluation time. The manifest declares zero or more contributions (cell type, tagged language, AIR lowerer, cross-language adapter exports, cell-context hook, MCP tool, Works surface, context-menu action). The host wires the contributions; your module is the body.

**Reading order:**

1. **§1** — what an extension is in five paragraphs (the six contribution surfaces).
2. **§10** — *Hello world.* The smallest legal extension is ~40 lines: a `package.json`, an `index.js` registering a tagged template, and that's it. Copy-and-modify is the right starting move.
3. **§2 + §3** — the manifest contract + the six capability slots. Read whichever §3.x your extension actually uses; skip the rest.
4. **§4** — only if you're wrapping a JS-native engine in a Python-shape (numpy → natra, sklearn → learn, …). The convention is `manifest.exports: { <name>: namespaceObject }`.
5. **§6** — only if you're packaging as `.gcupkg` for sideloading. Out-of-tree extensions that publish via npm / unpkg / a raw URL don't need this.
6. **§11** — documentation conventions (README/SPEC structure + the first-paragraph rule + anti-patterns) when you're writing the user-facing docs.

**Reference implementations to read from:**

- **`ext/example-quip/`** is the documentation-aligned reference. One toy extension that exercises every capability slot this spec defines (cell type, tagged language, Python adapter via `exports`, global, Works surface, context-menu action, `.gcupkg` packaging). Not bundled into `works.html` / `works-all.html` — it's a standalone `.gcupkg` you install to exercise. Read its source as a working answer to "how do I do X in an extension?", or fork the directory as your starting template (the README walks the fork checklist).
- In-tree adapters: the cross-language family (`ext/learn/`, `ext/natra/`, `ext/sadpan/`, `ext/scitra/`, `ext/plot/`, `ext/line/`) all follow the same Python-shape wrapper pattern from §4.
- Tagged-language only: `ext/sql/`, `ext/shader/`, `ext/atra/`.
- Full cell type with AIR lowering: `ext/adder/`, `ext/soft/`.

Out-of-tree, a complete `.gcupkg` (§6.1) needs only `package.json`, `index.js`, an optional `adder.js`, `LICENSE`, `.gcupkg-meta.json`, and whatever assets your extension wants. `ext/example-quip/pack.js` is a 200-line packer you can copy.

**Things that bite, summarized:**

- **Versioning.** The host validates `manifest.version` as strict semver (`/^\d+\.\d+\.\d+(?:[-+].*)?$/`). `0.1.0` works; `0.1` doesn't.
- **`requires` semver subset.** Only `1.2.3`, `>=1.2.3`, `>1.2.3`, `^1.2.3`, `~1.2.3`, `0.x`, `*` are recognized — no `||` disjunctions, no AND-combinations.
- **Adapter load order.** If your extension ships both an engine (`index.js`) and an adapter (`adder.js`), the adapter must run AFTER the engine. The convention is `_importCache["@gcu/<name>"]` lookup at the top of `adder.js` — fail loud if the engine isn't loaded, do NOT duck-type fallback (rename-fragile).
- **Pre-1.0.** Manifest API is mostly stable but internal capability shapes (`cellType.parseNames`, `_py.add` specializations, …) can shift. Pin to a specific auditable build / commit.
- **Save loudly, fail loud.** `onActivate` errors get caught + logged but don't propagate to the user. Use `console.error` to make registration failures debuggable, and exit early if a dependency is missing.

When in doubt, scan §3.x for the contribution type you need and grep the canonical extensions for matching patterns: `ext/adder/`, `ext/learn/`, `ext/natra/`, `ext/spinifex/`, `ext/sql/` cover most idioms.

---

## 1. What an extension is

An extension is **one ES module** that runs in the page, declares one manifest, and contributes to zero or more of six surfaces:

| Surface | What you contribute | Where it lands |
|---|---|---|
| Cell type | A new kind of notebook cell (executable or not) | DAG + editor + execution pipeline |
| Tagged language | Highlighting + completions + tokenizer for a `` ` `` template tag | Editor (cm6) and tagged blocks |
| Cell-context hook | Augments every cell's `ctx` (the thing that becomes `ui`, `std`, …) | `cell-context.js` injection sites |
| AIR lowerer | Translates a language's AST to AIR for V8-hinted JS emission | `@gcu/air` compile pipeline |
| Exports | Named JS objects callable from cells (`load("@gcu/foo")` / cross-language adapters) | `window._auditableExtensions` |
| Globals | Plain `window.*` bindings | `window` |

You contribute as little or as much as you need. `@gcu/sql` is just a tagged language (`sql\`SELECT * …\``). `@gcu/adder` is a cell type + tagged language + AIR lowerer + cross-language adapters all in one. `@gcu/natra` exports a numpy-shaped object and registers an adder cell-context hook (the arena lifecycle). All of these are handled by the same manifest contract — there's no "extension type." There are only capabilities.

What an extension is **not**:

- It is **not a plugin loader** — there's no `getExports("foo")` API for extensions to discover one another. Cross-extension communication happens through the exports surface (`load()` or dotted-import resolution) and through global bus mechanisms (`window.auditable.hooks`, A-Bus for Works surfaces).
- It is **not sandboxed** — your code runs with full access to `window`, the cell scope, the VFS, everything. Auditable is open-source code written in front of the user; the trust model is "the user pressed install on this URL."
- It is **not bundled by auditable** — you ship your own `index.js` and own your build. The host just `import`s it.

---

## 2. The manifest contract

You register exactly once, at module evaluation time, by calling the platform's `registerExtension(manifest)`:

```js
const register = window.auditable?.registerExtension;
if (register) {
  register({
    name: '@gcu/example',
    version: '0.1.0',
    description: 'one-sentence summary that shows up in the plugins panel',
    // contributions follow…
  });
}
```

Skip the call gracefully when `window.auditable` is undefined — you may be loaded by a node test harness, a bundler probe, or a non-Auditable page. Don't throw.

### 2.1 Required fields

```ts
{
  name:    string,                          // unique; conventionally @gcu/<slug>
  version: string,                          // strict semver: /^\d+\.\d+\.\d+(?:[-+].*)?$/
}
```

Validation is enforced at registration; invalid versions throw immediately.

### 2.2 Optional fields

```ts
{
  description?:  string,                    // one-line plugin-panel summary
  pluginUrl?:    string,                    // import URL (set by install()), used as the registry key
  requires?:     { [name]: string },        // §2.4 — cross-extension dependencies
  onActivate?:   () => void,                // called once after successful register
  onDeactivate?: () => void,                // called by uninstall

  // ── Capabilities (each is independently optional) ──
  cellType?:        CellType,               // §3.1
  taggedLanguage?:  TaggedLanguage,         // §3.2
  taggedLanguages?: TaggedLanguage[],       //   (multi form — for ext shipping >1 tag)
  contextHook?:     { setup: ContextHookFn }, // §3.3
  airLowerer?:      { language, fn },       // §3.4
  exports?:         { [name]: any },        // §3.5
  globals?:         { [name]: any },        // §3.6
}
```

### 2.3 What registration does

In order, when validation passes:

1. Checks `requires` against already-registered manifests (§2.4); throws if any dep is missing or out-of-range.
2. Replaces any previous manifest with the same `name` (warns to console).
3. Wires the cell type into `window._cellTypes` (skipping built-ins).
4. Wires every tagged language into `window._taggedLanguages`.
5. Calls `window._airRegisterLowerer(language, fn)` if an AIR lowerer is present.
6. Merges every entry of `exports` into `window._auditableExtensions`.
7. Merges every entry of `globals` into `window`.
8. Appends `contextHook` to `window._cellContextHooks`.
9. Records `description` + `pluginUrl` in `window._auditablePlugins`.
10. Fires `onActivate()`.

The underlying registries (`_cellTypes`, `_taggedLanguages`, `_auditableExtensions`, `_cellContextHooks`, `_auditablePlugins`) are kept as the storage layer — hot-path consumers in `src/js/` still read from them directly. The manifest API is the **canonical write path**. Reads should prefer the lookup helpers (`getExtension(name)`, `listExtensions()`, `getCellType(name)`, `getTaggedLanguage(name)`, `getExports(name)`, `hasExports(name)`) on `window.auditable.*`.

### 2.4 Cross-extension dependencies (`manifest.requires`)

An extension may depend on another being registered first. The `requires` field declares those dependencies:

```js
register({
  name:    '@gcu/natra',
  version: '0.1.0',
  requires: {
    '@gcu/adder': '>=1.0.0',          // arena hook lives in adder
  },
  // …
});
```

Each entry maps an extension `name` to a **semver range**. The host validates at registration:

- If a required name has no registered manifest → **throws**.
- If the registered version doesn't satisfy the range → **throws**.
- If `requires` is missing or empty → no check.

**Supported range syntax** (intentionally a small subset of node-semver):

| Range | Meaning |
|---|---|
| `1.2.3` | Exactly this version |
| `>=1.2.3` | This version or higher |
| `>1.2.3` | Strictly higher |
| `^1.2.3` | Compatible with — `>=1.2.3 <2.0.0` (locked major) |
| `~1.2.3` | Approximately — `>=1.2.3 <1.3.0` (locked minor) |
| `*` | Any version |

Disjunctions (`||`) and AND-combinations are deliberately not supported. If you find yourself needing them, your extension is too coupled to its deps — refactor.

**Failure mode is fail-fast.** A missing or wrong-version dep produces a thrown error at register time, surfaced via the standard plugin-panel error UI. Silent missing-dep behavior is what makes plugin ecosystems hard to debug; we don't ship it.

**Loading order is your problem, not the host's.** The host validates that dependencies have *already registered* — it does not auto-load them. In-tree, control order via `main.js` import order or `SHARED_LIBS` position in `build.js`. Out-of-tree, the user installs deps first. A `.gcupkg` (§6.1) declares the same range set in its `requires` metadata so install tooling can warn early.

For optional features ("works better if X is also installed"), do **not** put X in `requires` — check `window.auditable?.getExtension('X')` at runtime instead and degrade gracefully. `requires` is for hard dependencies your registration cannot complete without.

### 2.5 The two-entry-point model: `index.js` vs `works.js`

Auditable runs in two distinct JavaScript contexts, and capabilities split cleanly between them:

| Context | Where it runs | What lives there |
|---|---|---|
| **Notebook** | Inside the notebook iframe (or the page in standalone) | Cell types, tagged languages, AIR lowerers, Python adapters via `exports`, cell-context hooks, globals |
| **Shell** | The Works shell window (or N/A in standalone) | Surfaces (Works tabs), context-menu actions on tree nodes, MCP tools |

Each context loads its **own** entry point and calls **its own** `window.auditable.registerExtension(...)`. There's no bridging between them, no cross-frame coordination for registration:

```
my-extension.gcupkg
├── package.json
├── .gcupkg-meta.json
├── index.js          ← runs in NOTEBOOK context — cellType, taggedLanguage, exports, …
├── works.js          ← runs in SHELL context    — surfaces, contextMenu, …
├── adder.js          ← optional Python-shape adapter (notebook context, loaded as <name>/adder)
└── viewer.html       ← surface asset, referenced by works.js
```

**Loading:**

- `works.js` evaluates in the shell **at install time** (and at Works boot for every previously-installed extension). The shell's `window.auditable.registerExtension` handles the shell-relevant slice — surfaces are routed to the surface registry, contextMenu items to the tree right-click registry. Result: drop a `.gcupkg`, the surfaces and context-menu items appear immediately. No notebook needs to be open.
- `index.js` evaluates in the notebook iframe **when a cell needs it** — via `load("@gcu/<pkg>")`, `from <X> import` auto-discovery in adder cells, or the `LANGUAGE_PACKS` map (for canonical adder/soft cell types). Result: cell-type registration happens lazily, on first use, in the context that actually runs cells.

Each context's `registerExtension` enforces its slice. If you call `register({ surfaces: [...] })` from `index.js` (notebook context), the call is rejected with a console warning telling you to move it to `works.js`. Same shape symmetrically: `register({ cellType: {...} })` from `works.js` warns "put this in index.js."

**Why two files** instead of one manifest that gets routed: the two contexts have different module graphs, different windows, and different lifecycles. A single entry point that ran in either context (or worse, ran in one context and posted to the other) tied surfaces' visibility to whether a notebook had touched the extension. Two files = each runs where it belongs, no coordination, no race conditions, no surprise that surfaces don't appear until somebody runs a cell.

**You can skip either file.** An extension that only contributes cell types has no `works.js`. An extension that only adds a Works surface has no `index.js`. Most extensions will have one or the other; only language packs with both runtime semantics and Works UI need both.

---

## 3. The six capability surfaces in detail

### 3.1 Cell types (`manifest.cellType`)

A cell type is a row in the notebook. The DAG calls into your `execute()` and `parseNames()`; the editor calls into your `createEditor()` and `completions()`; the toolbar uses `label`, `color`, `shortcut`.

```ts
cellType: {
  name:          string,        // unique among cell types ('code', 'md', 'css', 'html' are reserved)
  label?:        string,        // toolbar label; defaults to name
  color?:        string,        // CSS color token (semantic, e.g. var(--au-action))
  shortcut?:     string,        // single keyboard letter
  editDebounce?: number,        // ms debounce on autorun after edit (default ~250)

  capabilities: {
    executable:    boolean,     // can run during DAG execution
    definesScope:  boolean,     // contributes names to downstream cells
    hasOutput:     boolean,     // has an output element
    hasEditor:     boolean,     // has a CM6 source editor
    builtin?:      boolean,     // reserved for code/md/css/html; extensions must NOT set this
  },

  // Required when capabilities.executable === true
  execute?(cell, scope, ctx): Promise<void> | void,
  // Required when capabilities.definesScope === true
  parseNames?(code): string[] | Set<string>,
  // Optional but typical
  findUses?(code, allDefined, selfDefined?): string[] | Set<string>,
  createEditor?(cell, onChange): { el: HTMLElement, destroy?(): void },
  tokenize?(code): Token[],
  completions?(code, cursor): Completion[],
  syntaxCheck?(code): boolean,
  indent?(line, before): string,
  indentUnit?: string,
}
```

The four built-in types (`code`, `md`, `css`, `html`) self-register with `capabilities.builtin = true` and are dispatched by hardcoded paths in `exec.js` — they exist in `_cellTypes` only for uniform queries. Third-party types are dispatched through their manifest functions.

**Validation:**
- `cellType.name` cannot be one of `code`/`md`/`css`/`html` (cannot shadow built-ins).
- `executable: true` + no `execute()` → throws.
- `definesScope: true` + no `parseNames()` → throws.

**Reference implementations:** `ext/adder/src/register.js`, `ext/soft/src/register.js`.

### 3.2 Tagged languages (`manifest.taggedLanguage` or `manifest.taggedLanguages`)

A tagged language is a tag-template language available inside any code cell:

```js
const q = sql`SELECT * FROM things WHERE id = ${id}`;
const program = atra`func add(a: i32, b: i32) -> i32 { a + b }`;
```

Editor highlighting, completions, and signature hints route through your `tokenize()`, `completions()`, `sigHint()`.

```ts
taggedLanguage: {
  name:        string,                       // the tag identifier (e.g. 'sql', 'atra', 'glsl')
  tokenize(code): Token[],                   // required
  completions?(code, cursor): Completion[], // optional
  sigHint?(name, pos): SigHint,             // optional
  indent?(line, before): string,            // optional
}
```

A single extension may ship multiple tagged languages — use the `taggedLanguages: TaggedLanguage[]` array form.

**Reference implementations:** `ext/sql/index.js`, `ext/shader/index.js`, `ext/atra/index.js`.

### 3.3 Cell-context hooks (`manifest.contextHook`)

A cell-context hook augments the per-cell `ctx` object before execution. The `ctx` is what gets injected into a cell as the `std`, `ui`, `notebook`, etc. namespaces.

```ts
contextHook: {
  setup(cell, ctx): void | (() => void),     // optional teardown callback
}
```

Use this when your extension needs a per-cell lifecycle — for instance, opening a per-cell logger, a per-cell canvas pool, a per-cell event subscription.

**Note — adder-specific hook:** `@gcu/natra` does NOT use this slot. It uses `window._adderCellHooks` — an adder-internal arena lifecycle hook with a `{ before(scope, cell), after(arena, defines, scope) }` shape, because natra arenas are an adder-specific runtime concern (the JS host has no GC pressure to manage). The `contextHook` manifest slot is for *generic* cell-context augmentation that any cell type may consume.

### 3.4 AIR lowerers (`manifest.airLowerer`)

If your extension is a compile-to-AIR language (a Python-like, an English-keyword DSL, a small numeric DSL), register a lowerer:

```ts
airLowerer: {
  language: string,            // tag the host uses ('adder', 'soft', 'js' built-in, …)
  fn(ast, parser, allDefined): AirModule,
}
```

The lowerer takes your language AST and returns an AIR module (SSA IR with op codes — see `ext/air/SPEC.md` for the IR shape). AIR's emit-js pass then produces V8-hinted JS for execution. Fallback semantics are mandatory: if your lowerer throws `AirLowerError`, AIR returns null and the runtime falls back to your interpreter or tree-walker.

The full lowering surface — `BaseLowerCtx`, `captureOps`, `emitPhiSelect`, `lowerIfRegion`, `lowerLoopRegion`, the specialization registry — is documented in `ext/air/SPEC.md`. Your `fn` is expected to extend `BaseLowerCtx` and call its helpers.

**Specialization registration is separate from lowerer registration.** Runtime-helper specializations (`_py.add → +` when both operands are typed numbers) are registered via `registerSpecializations(namespace, table)`. Each language owns its own namespace (`_py` for adder, `_soft` for soft, etc.). See `ext/adder/src/air-lower.js:75–84` for the dual-path (Node + browser) registration pattern.

**Reference implementations:** `ext/adder/src/air-lower.js`, `ext/soft/src/air-lower.js`.

### 3.5 Exports (`manifest.exports`)

Exports are how cross-language adapters surface Python-shaped (or any-shaped) namespaces to other extensions.

```ts
exports: {
  [name]: any,                  // each key → window._auditableExtensions[key]
}
```

Once exported, downstream consumers (e.g. adder cells) can resolve dotted imports against the registry. The adder `_resolveModule` walks dotted paths through `_auditableExtensions`, so:

```python
from learn.tree import DecisionTreeClassifier
```

resolves by: `_auditableExtensions['learn'] → .tree → .DecisionTreeClassifier`. Your extension exports `{ learn: _module }` and the import surface is automatic.

This is the foundation of the **cross-language adapter pattern** — see §4.

**Reference implementations:** `ext/natra/adder.js:730–740`, `ext/learn/adder.js:84–96`, `ext/line/adder.js:428–`, `ext/sadpan/src/api.js:1073–`, `ext/plot/src/api.js:276–`, `ext/scitra/adder.js:54–`.

### 3.6 Globals (`manifest.globals`)

A backdoor for cases where you really do need a `window.foo` (debugging surface, HTML event handler, legacy DOM integration). Avoid unless you have a specific reason; cells should consume named imports via `load()` and `_auditableExtensions`, not globals.

### 3.7 MCP tools (status: not yet manifested)

Auditable ships an MCP (Model Context Protocol) bridge — `webmcp_bridge.js` + `src/js/shim.js` + `src/js/mcp-adapter.js` — that lets a client (Claude Code, …) read cells, run cells, edit sources, etc. Tools are registered via the polyfilled `navigator.modelContext.registerTool({ … })`.

**Today, this is not surfaced through the manifest.** An extension that wants to register MCP tools (e.g. `@gcu/spinifex` exposing a `mapSnapshot` tool, `@gcu/learn` exposing a `predictBatch` tool) does so by calling `navigator.modelContext.registerTool(…)` directly in `onActivate`:

```js
register({
  name: '@gcu/example',
  version: '0.1.0',
  onActivate() {
    if (navigator.modelContext) {
      navigator.modelContext.registerTool({
        name: 'example:compute',
        description: '…',
        inputSchema: { /* JSON Schema */ },
        execute(args) { /* … */ },
      });
    }
  },
});
```

This works, but skips:

- Re-registration on `crypto:unlocked` (the host clears tools when the notebook re-locks and needs to re-add them on unlock).
- Access-control gating consistent with the `// %mcp` cell directives.
- Audit-log integration (tool calls land in `_mcpAuditLog`).

**Planned: `manifest.mcpTools`.** A future field — `mcpTools: [{ name, description, inputSchema, execute, requiresUnlock?, audit? }]` — will let the host take over re-registration, gating, and audit logging. Open issue, not yet implemented; this section will get rewritten when it lands.

For now: if your extension wants MCP tools, register them imperatively in `onActivate` and subscribe to `crypto:unlocked` via `window.auditable.hooks.on('crypto:unlocked', …)` to re-register. See `src/js/mcp-adapter.js:349–375` for the manifest-driven re-registration pattern used by the host's own tools.

### 3.8 Surfaces, context menus, and path routing (shell context — `works.js`)

These three capabilities all live in the **shell context** and are registered from `works.js`, NOT `index.js` (see §2.5). Standalone auditable has no shell, so these capabilities are silently ignored there; Works is where they take effect.

`works.js` evaluates in the Works shell window at **install time** and at **Works boot** (once per installed extension). Surfaces and context-menu items appear in the UI immediately — no notebook needs to be open, no cell needs to run, no extension JS needs to be loaded inside a notebook iframe. The shell's own `window.auditable.registerExtension` handles the registration directly.

#### 3.8.1 Surface contributions (`manifest.surfaces`)

Each surface is an HTML file inside the gcupkg that opens as an iframe under Works's rails layout. The surface itself talks to the workspace over A-Bus (same `Surface` contract every in-tree surface uses, see `works/SURFACES.md`).

A minimal `works.js` for a viewer:

```js
// works.js — runs in the Works shell, calls the shell's registerExtension.
window.auditable.registerExtension({
  name: '@example/data-grid',
  version: '0.1.0',
  surfaces: [{
    kind:        'data-grid',          // unique kind name; collides → registration throws
    label:       'Data Grid',          // shown in the kind picker / new-surface menu (defaults to kind)
    icon:        '⊞',                  // single character; defaults to '■'
    file:        'surface.html',       // path inside the gcupkg (relative; see §3.8.4)
    extensions:  ['.parquet', '.arrow'], // fast-path file routing
    detect:      async (path, peek) => /* content-based routing (optional) — see §3.8.3 */,
    openAction:  true,                 // auto-inject "Open in <label>" context-menu item
    requires:    ['abus', 'menu'],     // shared libs to inline at spawn time; defaults to ['abus']
  }],
});
```

**Field rules:**

- `kind`: unique across the whole workspace. Two extensions both contributing `kind: 'image-viewer'` is a registration error. Recommend `<package-slug>-<purpose>` (`@gcu/spinifex` → `spinifex-map`) to namespace yourself.
- `file`: a path within the gcupkg, e.g. `surface.html` or `surfaces/grid.html`. The installer copies the whole gcupkg to `/lib/<pkg>/`; the surface lands at `/lib/<pkg>/<file>`. The shell reads from there on each spawn (no separate bundling pass).
- `extensions`: lowercase, dot-prefixed. Matched first by `kindForPath` before any `detect()` fallback (cheap; no I/O).
- `detect`: optional callback for content-based routing. Receives `(path, peek)`; returns `true` if this surface should claim the path. See §3.8.3.
- `openAction`: `true` is sugar for a context-menu entry that spawns this surface on the matched file. Equivalent to declaring it manually under `contextMenu`; the host injects the item with label `'Open in <kind.label>'`.
- `requires`: shared-lib names the surface's `<script type="module">` block imports via bare specifiers (`@gcu/abus`, `@gcu/menu`, `@gcu/cm6`, …). Host inlines these at spawn time (see §3.8.5). `'abus'` is always implicit — every surface needs the A-Bus client to talk to `works:`.

#### 3.8.2 Context menus (`manifest.contextMenu`)

Custom right-click actions on tree nodes. Same shell context as §3.8.1, declared in the same `works.js`. Composable with surfaces: an extension that just adds a "Compute statistics" dialog without shipping a surface uses only `contextMenu`. An extension that ships a surface AND wants extra non-open actions uses both.

```js
// works.js (continued)
window.auditable.registerExtension({
  name: '@example/data-grid',
  version: '0.1.0',
  contextMenu: [{
    label:    'Show schema',
    scope:    'file',                            // 'file' | 'folder' | 'project'
    filter:   (path) => /\.(parquet|arrow)$/.test(path),
    action:   async (path, ctx) => {             // ctx exposes the works A-Bus client + dialog helpers
      const head = await ctx.peek(path, 256);
      ctx.dialog.alert('Schema', describeSchema(head));
    },
    icon:     '📋',                              // optional; not shown in current menu styling
    section:  'inspect',                         // optional grouping hint; reserved for menu redesign
  }],
});
```

**Field rules:**

- `scope`: which tree node types fire this action. `'file'` for loose files, `'folder'` for plain directories, `'project'` for `/projects/<name>/` directories with a `project.json`. To match multiple, list the action twice; intentional duplication is OK.
- `filter`: predicate `(path) => boolean`. Runs once per right-click; cheap. Returning `false` hides the item. If absent, the action applies to every node in scope. Lives in `works.js`, runs in shell context — no cross-frame call.
- `action`: `(path, ctx) => Promise<void>`. Runs in the shell's JS context (same as `filter`). The `ctx` object exposes a curated surface (initial: `ctx.bus` for A-Bus calls, `ctx.dialog` for `@gcu/dialog` prompts/alerts, `ctx.peek(path, n)` for byte reads, `ctx.spawnSurface(kind, opts)` for opening surfaces, `ctx.setStatus(text)` for the status bar). The shape grows by addition only.

Auto-injection via `openAction: true` on a surface is exactly equivalent to:

```js
{
  label:  `Open in ${surface.label}`,
  scope:  'file',
  filter: (path) => surface.extensions.some(ext => path.toLowerCase().endsWith(ext))
                 || (surface.detect && surface.detect(path, ctx.peek.bind(ctx, path))),
  action: (path) => ctx.spawnSurface(surface.kind, { path }),
}
```

#### 3.8.3 Path-to-kind resolution

When the user double-clicks a file in the tree, the shell asks `kindForPath(path)`. Resolution order:

1. **Extension match** — every registered surface's `extensions` list, checked against `path.toLowerCase()`. First match wins. O(N) over the kind set; cheap.
2. **Extensionless-name match** — for files like `LICENSE`, `README` (no extension); same as today's `extensionlessNames`.
3. **`detect()` callbacks** — every surface with a `detect` callback is asked in registration order. First truthy result wins. Async; bounded by a `peek` budget (see below).
4. **Fallback** — text surface for "text-like" content (heuristic on bytes: mostly printable ASCII / valid UTF-8), otherwise the preview surface.

The `peek` function passed to `detect` reads the first N bytes from `path` (via the workspace VFS), cached for the duration of a single resolution pass. So two `detect` callbacks both asking `peek(path, 16)` perform one read total. Recommended N: ≤ 256 bytes — kind detection is a magic-byte concern, not a full-file parse.

```js
detect: async (path, peek) => {
  const head = await peek(8);                 // Uint8Array of first 8 bytes
  return head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31;  // 'PAR1'
}
```

The detect-pass budget is `~1 MB total` across all surfaces in one resolution; if a callback requests beyond that, the host caps and logs. Detect callbacks that need a full-file read should ship as a `contextMenu` action instead.

#### 3.8.4 Where surface files live in the gcupkg

```
@example/data-grid@0.1.0.gcupkg
├── package.json
├── index.js                  ← notebook entry: cell types, exports, …
├── works.js                  ← shell entry:    surfaces + contextMenu registrations
├── adder.js                  ← optional Python adapter
├── surface.html              ← single-surface case (referenced by works.js)
└── surfaces/                 ← multi-surface case (works.js declares file path per kind)
    ├── grid.html
    └── schema-viewer.html
```

After install, the installer writes the whole gcupkg verbatim to `/lib/<pkg>/`. Surface HTML files end up at `/lib/<pkg>/surface.html` etc. The host's spawn step reads from there each time the surface opens (no per-instance caching of the HTML beyond the blob URL — re-opening picks up an edited file).

#### 3.8.5 Shared-lib inlining (the existing mechanism)

Extension surfaces use the same shared-lib inlining as in-tree surfaces. The `requires: ['abus', 'menu']` list tells the host which `@gcu/<name>` bare specifiers in the surface's `import` statements should be replaced with their inlined source. The shell's `_inlineLibsIntoSurface` runs against the extension surface's HTML before iframe creation — same code path as `text.html`, `preview.html`, etc.

Standard lib aliases (`abus`, `vfs`, `menu`, `dialog`, `cm6`, …) are pre-bundled in works.html. Extension surfaces requesting an alias that isn't in the host build fail to spawn with a clear error — the user gets a status-bar message.

Surfaces that need libraries beyond what the host ships should vendor them inside the gcupkg and import via relative paths (no bare specifier).

#### 3.8.6 The surface-author contract — what your `surface.html` must do

Every Works surface receives a single `'abus:welcome'` postMessage with `{ port, tab, home }` and is responsible for everything from there. The host doesn't help further. The canonical handler shape — copy this as your starting template:

```js
window.addEventListener('message', async (ev) => {
  if (ev.source !== window.parent || ev.data?.type !== 'abus:welcome') return;
  const { port, tab } = ev.data;

  // 1. Connect the A-Bus client.
  let bus;
  try {
    bus = await connect(port, { client: 'my-surface' });
    installThemeSubscription(bus);   // see §3.8.7
  } catch (e) {
    console.error('[my-surface] connect failed:', e);
    return;
  }

  // 2. Expose the §5.2 Surface contract — required.
  bus.expose('/', {
    Surface: {
      methods: {
        Flush:     async () => { /* persist any pending dirty state */ },
        CanClose:  () => true,         // or false to block close
        Relocated: (_path) => { /* react if Works moves the project root */ },
      },
      signals: ['DirtyChanged', 'TitleChanged', 'Ready'],
    },
  });

  // 3. If your surface opens a file, read it via the works VFS.
  const path = tab?.path;
  if (path) {
    let source;
    try {
      source = await bus.call(
        { to: 'works', path: '/', interface: 'VFS', member: 'Read' },
        [path, 'utf8']   // or [path] for raw bytes (returns Uint8Array)
      );
    } catch (e) {
      // Show the error in your surface's UI. Don't throw — still emit Ready.
    }
    if (source !== undefined) renderYourContent(source);
    bus.signal({ path: '/', interface: 'Surface', member: 'TitleChanged' },
      [path.split('/').pop()]);
  }

  // 4. Always emit Ready, even on error — the host uses this to settle
  //    the tab's loading state. Skipping it leaves the tab stuck.
  bus.signal({ path: '/', interface: 'Surface', member: 'Ready' }, []);
});
```

**What each step does, and what breaks if you skip it:**

| Step | Skipping breaks |
|---|---|
| 1. Connect bus | Surface can't talk to the workspace at all — VFS reads, settings, all dead. |
| 2. Expose Surface contract | Host can't ask the surface to save / close cleanly; tab lifecycle desyncs. |
| 3. Read `tab.path` | Surface boots but doesn't know what file to show. The viewer stays empty. Common bug — easy to miss because the welcome message still works. |
| 4. Emit `Ready` | Tab's spinner / loading state never resolves; user thinks the surface is hung. |

**On `tab.path` semantics**: the host always supplies `tab` in the welcome payload, but `tab.path` is `null` when the surface was spawned without a file (e.g. Tools → Open A-Bus Inspector). Handle the `!path` case explicitly — render empty state, file-picker UI, whatever's appropriate. Don't assume.

**On VFS reads**: the `'utf8'` encoding flag decodes to a string. Omit it for binary content (returns `Uint8Array`). Errors propagate as rejected promises — wrap in try/catch and render the error in your UI rather than letting the iframe stay blank.

**Surface signals you can emit** (all path-scoped on `'/'`, interface `Surface`):

| Signal | Args | When |
|---|---|---|
| `TitleChanged` | `[newTitle]` | Tab title should update (filename, doc title, …). |
| `DirtyChanged` | `[isDirty]` | Set the tab's dirty indicator on/off. |
| `Ready` | `[]` | Surface has finished initial render. **Emit exactly once.** |

**Reference implementations** in the auditable repo, in increasing complexity:

- `ext/example-quip/surface.html` — read-only viewer, parses + renders a `.quip` file (~200 LOC).
- `works/surfaces/preview.html` — read-only viewer with multiple file-type rendering (image / CSV / markdown / archive).
- `works/surfaces/text.html` — read-write CM6 editor with Flush wired to VFS.Write, DirtyChanged on edit.

#### 3.8.7 Styling and theme integration

Surface iframes have their own opaque-origin documents — none of the shell's CSS or the workspace's theme settings cross the boundary automatically. The host bridges via two placeholder substitutions the extension surface's HTML opts into:

```html
<style>
  /* @theme-tokens */          <!-- substituted with the --sw-* / --au-* / --ui-* token cascade -->
  body { color: var(--au-fg); background: var(--au-surface); }
  .panel { border: 1px solid var(--au-border); }
</style>
…
<script type="module">
import { connect } from '@gcu/abus';
/* @theme-init */              // substituted with the installThemeSubscription bootstrap

window.addEventListener('message', async (ev) => {
  const bus = await connect(ev.data.port, { client: 'data-grid-surface' });
  installThemeSubscription(bus);   // sets <html data-theme> + subscribes to Shell.SettingsChanged
  // …
});
</script>
```

The host runs both substitutions on the extension surface's HTML **at spawn time** — same machinery in-tree surfaces use at build time (`injectSharedTheme` from `build.js`). The iframe boots with the workspace's tokens already in scope (no flash of unstyled content).

**Token cascade** (canonical, see `ext/switchboard/SPEC.md`):

| Layer | Tokens | What |
|---|---|---|
| 1. Switchboard swatches | `--sw-orange`, `--sw-bg-raised`, `--sw-text`, … | Raw palette. Light defaults at `:root`, dark overrides at `[data-theme="dark"]`. |
| 2. Auditable semantic | `--au-fg`, `--au-action`, `--au-surface`, `--au-border`, … | Role tokens (orange=action, teal=info, green=go, …). Map to layer 1. **Surfaces should use these.** |
| 3. Component-internal | `--ui-bg-raised`, `--ui-fg-muted`, … | Read by `@gcu/menu` + `@gcu/dialog`. Map to layer 2. |

Rules:

- Reference `--au-*` tokens in your CSS, not raw `--sw-*` swatches — semantic tokens are what flip cleanly across light/dark/system themes.
- Component CSS (menu, dialog) auto-injects when `requires` includes the lib (see §3.8.5). The `--ui-*` aliases land via `@theme-tokens`, so component popups inherit the workspace theme automatically.
- The user's `/home/nb/theme.css` overrides land in the SHELL but do NOT cross into surface iframes. If a workspace customization needs to reach into extension surfaces, route it through `Shell.SettingsChanged`.

**Live updates** — `installThemeSubscription(bus)` does two things:

1. Sets `<html data-theme>` to the workspace's current setting from `Settings.Get`.
2. Subscribes to `Shell.SettingsChanged` so a theme flip in workspace settings reaches the surface without reload.

Surfaces that need to react to OTHER settings (font size, custom prefs) subscribe to the same signal — the payload is the full settings object. Mirror what `works/surfaces/text.html` does for `textEditor.wrap` / `textEditor.showLineNumbers`.

**Scrollbar styling** — the conventional GCU thin scrollbar pattern is one paste away; recommend including it in any surface with scrollable content:

```css
* {
  scrollbar-width: thin;
  scrollbar-color: var(--au-border) transparent;
}
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--au-border); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: var(--au-fg-soft); }
*::-webkit-scrollbar-corner { background: transparent; }
```

A future common-CSS shared module could ship this as a `/* @gcu-base */` placeholder; for v1, just copy the block.

**First-paint correctness** — every surface's `<html>` should set `data-theme="dark"` (or `"light"`) explicitly:

```html
<html lang="en" data-theme="dark">
```

This pins the theme for the FIRST PAINT before A-Bus delivers the workspace's actual setting. `installThemeSubscription` overrides it with the real value once it knows; the brief default→real transition is invisible if you picked the right initial value for your typical user (dark for the standard GCU look).

#### 3.8.8 Lifecycle

- **Install** — `installGcupkg` writes the archive contents to `/lib/<pkg>/` (engine `source`, `adder/source`, `package.json`, `LICENSE`, plus any custom top-level files: `works.js`, `surface.html`, asset trees, …). Immediately afterwards, the shell's loader evaluates `/lib/<pkg>/works.js` in the shell context if it exists. The script's `window.auditable.registerExtension({...})` call runs synchronously — surfaces, context-menu items, and any future shell-context capabilities are live the moment the install finishes. No notebook needs to be open.
- **Boot** — when Works boots and the workspace VFS is ready, the shell's loader walks `/lib/<scope>/<pkg>/` and `/lib/local/<pkg>/` looking for `works.js`. Each one evaluates in shell context, in installation order. Same registration path as install — the user sees the same UI state every reload.
- **Replace** — re-installing at a new version triggers `installGcupkg`'s clean-replace step that wipes `/lib/<pkg>/`, then writes the new contents. The shell's loader evaluates the new `works.js`; `registerExtension` sees the name is already registered, calls the existing unregister hooks (revokes blob URL, drops kind, removes openAction items), and re-registers with the new declaration. No tab reload required — open tabs of an unrelated surface kind survive untouched.
- **Uninstall** — `pkg remove <name>` in geas drops `/lib/<pkg>/`. The current session's surfaces stay alive (they hold the blob URL); on next reload the surface kind is gone because `works.js` is no longer there to evaluate. A future VFS-watcher could fire unregister hooks live; for v1 "takes effect on next reload" is acceptable.

The notebook-context entry (`index.js`) follows its own separate lifecycle (§2.5 + §4.5) — loaded lazily by the notebook iframe when a cell needs it. Shell-context and notebook-context lifecycles don't interact.

#### 3.8.9 Security

Surface iframes run in their own opaque-origin context (per-blob origin under `file://`). They can only act through A-Bus calls to `works:` — there's no direct DOM access to the shell, no cross-surface DOM access, no `localStorage` shared with the workspace. The fence is the same as for in-tree surfaces; extension surfaces inherit it for free.

Trust model: same as npm — installing a gcupkg means trusting it. The extension's surface CAN call any A-Bus method `works:` exposes (VFS reads, settings reads/writes, spawn surfaces). Future capability-gating (§9 open question) could restrict this; for v1 the model is "install = full trust."

#### 3.8.10 What's NOT in v1

Deliberately out of scope; raise as follow-ups if they bite:

- **Per-kind namespacing of context-menu items.** Items appear in a flat list under their parent type's section. No per-extension submenu grouping until a single workspace has enough extensions for it to matter (current cap: ~5 before the menu gets unwieldy).
- **Worker-backed surfaces.** The host doesn't help an extension surface spawn its own Web Worker. The surface does that itself if it wants.
- **Cross-surface DOM bridges.** Surfaces communicate only via A-Bus; no shared in-memory state across iframe boundaries.
- **MIME type tables.** No central `mime → kind` map. Use `extensions` + `detect()`; mimics work fine.
- **Surface preview / picker UI.** Beyond "right-click → Open in <kind>", there's no kind picker for ambiguous files. Could land later — `kindForPath` could return a list of matches and the shell offers a chooser.
- **Per-workspace capability gating.** A `works.js` runs with full shell access — every A-Bus method `works:` exposes is reachable. v1 trust model is "install = full trust." Future capability flags in `.gcupkg-meta.json` could let the user grant or deny categories (VFS-read, VFS-write, mounts, spawn-surface) at install time.

#### 3.8.11 The host-side guide

`works/SURFACES.md` documents the surface-author contract (the §5.2 lifecycle, the A-Bus services available, the welcome-port pattern). Extension surfaces follow the same contract as in-tree surfaces — that file is the single source for HOW to write one. This section covers WHAT an extension declares in its manifest to be picked up by the host.

#### 3.8.12 Notebook-scriptable interfaces (`public: true`)  *(status: shipped)*

A surface can opt one or more of its A-Bus interfaces in as **notebook-scriptable**, so notebook cells can call its methods and subscribe its signals **without the raw-bus consent prompt**. This is the friction-free path for surfaces that *want* to be driven from a notebook — a 3-D viewer, a map, a sheet — without the user re-approving access each session.

**How a surface declares a public interface.** After claiming a stable well-known name and exposing its interfaces, the surface tells the shell which are notebook-public by calling the `works` service:

```js
const bus = await connect(port, { client: 'dee' });
bus.expose('/', {
  // public: true is the auditable, forward-compatible marker (a future shell
  // version will harvest it automatically); the explicit call below is what
  // the shell tracks today.
  Scene: { public: true, methods: { addBlock, clear, … }, signals: ['Changed'] },
});
await bus.claim('dee');
await bus.call({ to: 'works', path: '/', interface: 'Shell', member: 'DeclareNotebookPublic' },
               ['dee', ['Scene']]);
```

`Shell.DeclareNotebookPublic(name, interfaces)` is idempotent and emits `Shell.NotebookPublicChanged` so any open notebook's cached public-set refreshes live; `Shell.UndeclareNotebookPublic(name)` removes it. The companion static declaration in the manifest keeps the grant **auditable** (visible without running the surface, like `%mcp` directives) and is the field the future auto-harvest reads:

```js
{
  name: '@gcu/dee',
  surfaces: [{ kind: 'dee', /* …§3.8.1 fields… */ notebookPublic: ['Scene'] }],
}
```

What it grants notebooks (full design + the consumer-side API in `spec_inbox/notebook-abus-access-spec.md`):

- `await notebook.call('dee', 'Scene', 'addBlock', [...])` — call **public** interfaces; calling a non-public interface throws, hinting at `notebook.requestBus()`.
- `notebook.tag.subscribe('Scene.Changed', fn)` — subscribe a public interface's signals (the `public` flag covers **both** call and subscribe).

Enforcement is **builtin-advisory, not a sandbox.** A notebook already has direct VFS access (`notebook.fs`) and, with the consented raw bus, can reach anything — so the public set isn't armor. It keeps the *no-prompt* path honest (notebooks freely drive only what a surface said may be driven) and signals intent. The three tiers — always-on topics (`notebook.tag`), declared-public call/subscribe (`notebook.call`), and consented raw bus (`notebook.requestBus`, gated on a `// %abus` directive + a one-time prompt, revocable in Works Settings) — are all shipped; this section is the surface-author half: *how your surface says "notebooks may drive this."*

Topic convention: cell-originated topics are recommended (not required) to live under a `user.*` interface to avoid colliding with system signals; a surface's declared-public interface is exempt — its own name is the namespace.

---

## 4. Cross-language adapters

The natra / sadpan / scitra / plot / learn / line family is **the same pattern repeated** — each library wraps an underlying JS-native engine with a Python-shaped surface and registers it through `manifest.exports`. Together with `@gcu/ipynb`'s import-substitution table they make round-trip `.ipynb` portability possible: `import numpy as np` in a notebook landing inside auditable is rewritten to `import natra as np`, and `natra` is what the `exports` registered.

### 4.1 Anatomy of an adapter

The convention is to have **one file per host language** under your extension root:

```
ext/<name>/
  index.js              — pure JS surface (the underlying engine)
  adder.js              — Python-shaped wrapper, registers via exports
  src/                  — sources
```

`adder.js` (sometimes inlined into `index.js`) is the adapter. It:

1. Imports / receives the underlying JS engine.
2. Constructs a Python-shaped namespace object (`{ array, zeros, ones, mean, …, tree: { … }, linalg: { … } }`).
3. Registers it as `exports: { <name>: _module }`.

The exact pattern from `ext/learn/adder.js`:

```js
if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/learn',
      version: '0.1.0',
      description: 'sklearn-compatible classical ML for adder cells',
      exports: { learn: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['learn'] = _module;
  }
}
```

The `else` branch is a defensive fallback for early-init paths where `window.auditable` is not yet bound. It bypasses validation, but the underlying registry is the same — production paths always take the manifest branch.

### 4.2 The substitution table

Round-trip with the upstream Python ecosystem happens via `@gcu/ipynb`'s substitution table:

| Upstream import | Substituted to | Adapter ext |
|---|---|---|
| `numpy` | `natra` | `@gcu/natra` |
| `pandas` | `sadpan` | `@gcu/sadpan` |
| `scipy` | `scitra` | `@gcu/scitra` |
| `sklearn` | `learn` | `@gcu/learn` |
| `matplotlib.pyplot` | `plt` (auto-injected `plt.style.use('default')` for ipynb-imported notebooks) | `@gcu/plot` |

Substitutions go both ways — exported `.ipynb` files get the JS-native imports rewritten back to upstream names so they open cleanly in JupyterLab. This is **translation, not emulation** — adapters share *source syntax* with their upstream, but they're JS-native at the value layer, and they only implement what gets exercised. The substitution table is the user-facing portability bridge; the manifest `exports` is the runtime hookup.

To add a new adapter:

1. Decide your namespace (`@gcu/<name>`) and import name (`<name>`).
2. Build your JS-native engine.
3. Build a thin Python-shaped wrapper.
4. Register `exports: { <name>: wrapper }` via the manifest.
5. (Optional) Submit a substitution entry to `@gcu/ipynb`'s `substitutions.js` if you want round-trip with an upstream Python library.

No further integration is needed. Adder's import resolver does the rest.

### 4.3 Rich display — `_repr_html_`, `__repr__`, `__str__`

Adder + the runtime honor the **IPython / Jupyter display protocol** so adapter return values can render as HTML in the cell output without any per-cell ceremony. Two methods, both optional:

- **`_repr_html_()` → string of HTML.** When `ui.display(obj)` (`src/js/cell-builtins/ui.js`) is called on an object, or when an adder cell's *last expression* is an object (auto-display path in `ext/adder/src/cell.js`), the runtime checks `typeof obj._repr_html_ === 'function'` and inserts the returned HTML into the output element. Same shape Jupyter uses — copy-paste from any existing IPython library will Just Work.
- **`__repr__()` / `__str__()` → string.** Adder's `pyRepr()` (`ext/adder/src/builtins.js`) prefers these over JSON.stringify when present, giving Python objects a sensible printable form. Implement both if you also want `print(obj)` and `str(obj)` to return the same text.

The runtime checks for `_repr_html_` first; falls back to `__repr__` / `__str__`; falls back to JSON.stringify / String() last. JS-native objects, adder objects, and the same object exposed from both contexts all run the same path.

**Where it's already used in-tree:**

| Class | File | What `_repr_html_` produces |
|---|---|---|
| `sadpan.DataFrame` | `ext/sadpan/src/api.js:219` | Styled HTML table with the first 10 rows + summary |
| `sadpan.Series` | `ext/sadpan/src/series.js:115` | HTML table preview |
| `notebook.shell` result | `src/js/cell-builtins/shell.js:104` | Terminal-styled output panel |

**Adapter-author convention.** If your engine exposes an object whose notebook-display would benefit from a rich form (a workflow tree, an estimator's fit summary, a domain map, …), add `_repr_html_` to the class. Both JS cells (`ui.display(obj)`) and adder cells (bare `obj` as last expression) pick it up automatically — no per-language opt-in. Add `__repr__` / `__str__` alongside if the Python convention matters for your consumers (`print(obj)`, `str(obj)`, `repr(obj)`).

Minimal example:

```js
class Estimator {
  constructor(coef) { this.coef = coef; }
  _repr_html_() {
    return `<table><tr><th>coef</th><td>${this.coef.join(', ')}</td></tr></table>`;
  }
  __repr__() { return `Estimator(coef=[${this.coef.join(', ')}])`; }
  __str__() { return this.__repr__(); }
}
```

### 4.4 What adapters do *not* do

- Adapters do not bridge to native code. If a JS-native engine doesn't exist for the upstream library, the adapter doesn't exist either; we don't ship a "WASM-wrapped scipy."
- Adapters do not extend through monkey-patching. `np.array` is a property of `natra`, not assigned at runtime.
- Adapters do not own the runtime — adder's interpreter owns it. The adapter is just a callable wrapper.

### 4.5 Runtime auto-load (no preamble required)

Auditable's runtime auto-loads two classes of installed modules so notebooks that use them don't need any JS preamble cell — the canonical shape of an adder notebook is just `/// adder` cells with idiomatic Python at the top.

**Language packs** — when `runDAG` finds a fallback cell whose `cell.type` matches the host's known language-pack table (`adder` / `mpy` → `@gcu/adder`; `soft` → `@gcu/soft`), the matching pack is loaded from `_installedModules` before `buildDAG` runs. The cell upgrades out of fallback the moment `registerExtension` fires, so `parseNames` / `findUses` bind correctly in the same execution pass that triggered the load. The mapping is in `src/js/exec.js`'s `LANGUAGE_PACKS` constant.

**Adapter bridges** — for every `/// adder` (or `/// mpy`) cell, `runDAG` regex-scans the source for `^from <name> import` statements. For each `<name>` that's not already in `window._auditableExtensions`, the runtime looks for an installed module whose key matches `*/<name>/adder` (preferring `@gcu/` over other scopes) and loads it. The adapter's `registerExtension({ exports: { <name>: _module } })` publishes the namespace before the cell parses, so `from natra import zeros` or `from learn.tree import DecisionTreeClassifier` just works.

Both auto-loads are **install-only** — they never reach to a network for a missing module. The user has to `install("...")` once (or open a workspace that already has `/lib/<pkg>/` populated). After that, the auto-load is silent.

**Canonical adder-notebook shape:**

```
/// auditable
/// title: my notebook

/// md
# my notebook

/// adder
from natra import zeros
from learn.tree import DecisionTreeClassifier

X = zeros((10, 3))
clf = DecisionTreeClassifier()
print(clf)
```

No `await load("@gcu/adder")`, no `await load("@gcu/natra/adder")`, no `const natra = ...` preamble. The `/// adder` cell type triggers the language-pack load; the `from … import` statements trigger the adapter bridge loads. Everything resolves before the cell runs.

**What still needs an explicit `load()`:**

- JS cells that want the engine's raw JS surface (`const natra = await load("@gcu/natra")`). The Python-shape wrapper is for adder cells; the JS engine is its own thing.
- Notebooks using a NON-canonical adapter layout (an extension that publishes `_auditableExtensions['foo']` but lives at a key other than `*/foo/adder`).

**Caveats / known v1 limits:**

- The scan parses regex, not the adder AST. Multi-line imports (`from natra import (\n  zeros,\n  ones,\n)`) and `import X as Y` are recognized (the `from X` part still matches); deeply-nested or commented-out forms are best-effort.
- Tagged-template usage (`` adder`from natra import …` ``) inside a JS code cell is **not** scanned — only declared `/// adder` cells are. Tagged-template adder users need an explicit `await load("@gcu/<pkg>/adder")` in the same cell. Could be lifted later by extending the scan to JS code-cell sources.
- Soft cells use `use X.Y as N` syntax instead of `from X import`; adapter auto-discovery doesn't currently apply to soft. The language-pack auto-load (which loads `@gcu/soft` for soft cells) is unaffected.

---

## 5. Package layout and build conventions

Auditable extensions are **plain ES modules**. There is no required build system, no required bundler, no required directory layout. The conventions below are what the in-tree extensions follow because they work cleanly with the rest of the toolchain.

### 5.1 Layout

```
ext/<name>/                   — or wherever you keep it outside the monorepo
  src/                        — sources (one ES module per file, freely import each other)
    main.js                   — entry; build.js reads its imports as the concat order
    api.js                    — public surface
    …
  vendor/                     — vendored libraries (if any), with their LICENSE
  index.js                    — BUILD OUTPUT (concat of src/)
  build.js                    — concat script (see §5.2)
  package.json                — see §5.3
  README.md
  SPEC.md                     — optional; recommended for non-trivial extensions
  LICENSE
```

If your extension is small enough to be a single file, skip `src/` and `build.js` — ship one `index.js`.

### 5.2 Build script (recommended pattern)

The in-tree extensions use a uniform concat build that strips `import`/`export` and produces a single-scope `index.js`:

```js
// ext/<name>/build.js (canonical pattern)
import fs from 'fs';
import path from 'path';

const files = ['types.js', 'core.js', 'api.js'];  // concat order
const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(`src/${file}`, 'utf8');
  src = src.replace(/^import\s.*$/gm, '');
  src = src.replace(/^export\s+(function|const|let|class|async function)\s/gm, '$1 ');
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  chunks.push(`// -- ${file} --\n${src}`);
}
fs.writeFileSync('index.js', chunks.join('\n\n') + '\n\nexport { /* … */ };');
```

References: `ext/adder/build.js`, `ext/plot/build.js`, `ext/licenses/build.js`.

Why concat over rollup: the host inserts your module into a registry via an import map; rollup's runtime helpers are dead weight at that point. Concat is also debugger-friendly — line numbers in `index.js` are preserved from the source files.

### 5.3 `package.json`

A minimal manifest for npm-publishability and `pkg` integration:

```json
{
  "name": "@gcu/example",
  "version": "0.1.0",
  "description": "...",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/<repo>.git"
  }
}
```

For pkg / @gcu/licenses integration, the `license` field is non-optional in practice — `aggregateLicenses` falls back to fingerprint inference (see `ext/licenses/src/infer.js`), but the explicit SPDX id is faster and more reliable.

### 5.4 Host build integration (in-tree only)

When your extension lives under `ext/<name>/` in this monorepo:

- `build.js` (root) discovers `ext/<name>/index.js` automatically for the `works-all` target.
- For `auditable.html` and `works.html`, add your extension explicitly to the `SHARED_LIBS` table in `build.js` (around line 120) with `['<name>', 'ext/<name>/index.js']`.
- Add a line to the **Build checklist** section in `CLAUDE.md` so future-you remembers to rebuild after touching `src/`.

When your extension lives outside the monorepo, the user installs it via `install("https://…/index.js")` or via `pkg install <package>` (which fetches and stores under `/lib/<source>/<pkg>@<ver>/`).

---

## 6. Distribution

Today an extension ships as either:

- An `index.js` URL the user `install()`s (one-shot, no metadata, license fetched separately by @gcu/licenses).
- A `pkg`-managed package (npm / jsr / gh / @gcu/local) — installed via the `pkg` CLI, stored under `/lib/<source>/<pkg>@<ver>/` with its `package.json` + LICENSE alongside.
- A build-time bundled entry in the `auditable.html` / `works.html` registry.

That works, but it leaves users to find the URL and the host to fetch metadata. For a more "drop this on your desktop and it installs" experience, the proposed `.gcupkg` format below offers a single-file bundle with everything the runtime needs.

### 6.1 The `.gcupkg` format

**Status: shipped 2026-05-25.** Reader + installer at `src/js/gcupkg.js`; `pkg install <file.gcupkg>` in geas; Works tree drop-zone in `works/js/file-ops.js`. Packer is currently out-of-tree (a few hundred lines that walks an extension repo, validates the `package.json` shape, computes the integrity hash, and zips the artifacts) — `pkg build` will fold this into the in-tree CLI; see §6.1's implementation-status table.

A `.gcupkg` is a **`.zip` archive** with a defined internal layout:

```
example@0.1.0.gcupkg                   ← archive filename: <name>@<version>.gcupkg
├── package.json                       ← required; same shape as §5.3
├── index.js                           ← optional*; NOTEBOOK entry — cell types, taggedLanguages, exports, …
├── works.js                           ← optional*; SHELL entry — surfaces, contextMenu, MCP tools
├── adder.js                           ← optional; Python-shape adapter (§4) — auto-loadable as `<name>/adder`
├── soft.js                            ← optional; Soft-shape adapter (same convention)
├── surface.html                       ← optional; surface asset referenced by works.js (or surfaces/*.html for multiple)
├── LICENSE                            ← required; raw license text (any commonly-named file)
├── README.md                          ← optional; rendered in the plugin-panel detail view
├── SPEC.md                            ← optional; rendered next to README in plugin-panel
├── docs/                              ← optional; markdown surfaced via the docs surface (§6.2)
│   ├── index.md                       ← entry page if present
│   └── *.md                           ← additional pages, flat
├── examples/                          ← optional; .txt cell-defs surfaced via Help → Open example (§6.3)
│   ├── *.txt                          ← cell-def files (FORMAT.md style)
│   └── manifest.json                  ← optional, names + descriptions for the picker
├── vendor-licenses/                   ← optional; LICENSE files for vendored deps
└── .gcupkg-meta.json                  ← required; bundle metadata (see below)
```

*at least one of `index.js` / `works.js` is required — an extension that contributes nothing in either context isn't an extension. Most ship one or the other; only language packs with both runtime semantics and Works UI need both.

Secondary entry points (`adder.js`, future `soft.js`) live at the archive root alongside `index.js` and are declared in `package.json` `exports` map. The installer hydrates them into `_installedModules` under the `<name>/adder` (resp. `<name>/soft`) key so `load("<name>/adder")` from a cell resolves directly without a network fetch. Any other top-level file (e.g. `surface.html`, `icons/icon.svg`, custom asset trees) is mirrored under `/lib/<pkg>/` verbatim — the installer doesn't need to know about each asset by name.

`works.js` is evaluated by the Works shell at install time and at every Works boot; see §3.8.8 for the full lifecycle.

The `.gcupkg-meta.json` is what makes it a "wheel" rather than a generic zip — it commits to a schema:

```json
{
  "gcupkgVersion": 1,
  "name": "@gcu/example",
  "version": "0.1.0",
  "spdx": "MIT",
  "homepage": "https://...",
  "requires": {
    "auditable": ">=0.0.0",
    "@gcu/air": ">=0.3.0",
    "@gcu/adder": "^1.0.0"
  },
  "contributes": ["taggedLanguage", "exports"],
  "bundles": {
    "docs": true,
    "examples": 4,
    "vendorLicenses": 2
  },
  "size": { "index.js": 12345, "adder.js": 4678 },
  "integrity": "sha256-…",
  "integrityCovers": ["adder.js", "index.js"]
}
```

`requires` mirrors the manifest field of the same name (§2.4) plus an optional `auditable` entry for host-version pinning. `bundles` is a summary the host uses to decide which surfaces to wire up post-install (skip docs-surface registration if `docs: false`, etc.) — it's a *hint*, the real source of truth is the archive contents.

**Integrity field semantics** (added 2026-05-25 after the first real-world packer landed):

- `integrity` is a SHA-256 hash, base64-encoded, with `sha256-` prefix (SRI format).
- `integrityCovers` is an array of filenames the hash covers. **Required for new packers.** The recommended cover set is `index.js` + every secondary entry point listed in `package.json` `exports` map (so: `["adder.js", "index.js"]` for a typical extension with an adder bridge).
- Hash recipe: sort `integrityCovers` lexicographically, then for each filename concat: `<filename>` + `\0` + `<file bytes>` + `\0`. Compute SHA-256 of the resulting buffer.
- **Legacy compatibility**: if `integrityCovers` is absent, the reader assumes the hash covers `index.js` only (the first-generation packer shape, before the spec made the cover set explicit). Verification still works but the consumer logs a note encouraging the producer to upgrade.

Why bundle:

- **One install action.** Drag a `.gcupkg` onto Works → extracted to `/lib/local/<name>@<ver>/`, registered, ready. No URL, no `pkg install`, no separate LICENSE fetch.
- **Self-contained metadata.** SPDX, version, homepage, integrity hash — all in the same archive, no second fetch for the licenses tab.
- **Capability declarations.** `contributes: [...]` lets the host audit what a package will register *before* importing it.
- **Reproducible install.** SHA-256 in the meta is verifiable; users can compare against a publisher's hash.
- **Native @gcu/archive support.** We already ship a ZIP reader/writer in `@gcu/archive`; a `.gcupkg` install is a 50-line operation.

Why **not** bundle (the deliberate gaps versus Python wheels):

- **No platform / ABI tags.** Auditable is one platform (the browser). No `cp39-linux_x86_64` filename nonsense.
- **No build isolation.** You build the `.gcupkg` once, you ship it; there's no `pip wheel`-style on-install rebuild step. The format is artifact distribution, not source distribution.
- **No native compilation.** If you need Wasm, ship the `.wasm` inside the gcupkg as a `vendor/` asset; that's it. There's no pre/post-install hooks.
- **No dependency resolution at install time.** `requires` is a declaration the host can warn about; it does not auto-fetch dependencies. The user is expected to install dependencies as `.gcupkg`s themselves or via `pkg install`.

The format is intentionally small. Pythonic wheels accumulated a lot of complexity because pip resolves trees, builds from sdists, handles ABI matching, runs install scripts. None of that applies to "drop an ES module into the browser's import map" — so the `.gcupkg` is just "the smallest thing that lets the host know what it has before running it."

**Implementation status:**

| Piece | Status |
|---|---|
| Format reader + installer (`src/js/gcupkg.js`) | shipped 2026-05-25 |
| `pkg install <file.gcupkg>` in geas | shipped 2026-05-25 |
| Works tree drop-zone for `.gcupkg` files | shipped 2026-05-25 |
| `install("file.gcupkg")` cell shorthand | shipped 2026-05-25 — uses stdlib's native-DecompressionStream `unzipArchive`, no `@gcu/archive` dependency (~3.5 KB add to auditable.html) |
| `pkg build` subcommand for producing `.gcupkg` from a workspace package | deferred — out-of-tree packers (a few hundred lines that walks a repo, validates `package.json`, computes the integrity hash, and zips the artifacts) work; in-tree builder is a quality-of-life follow-up |

### 6.2 The `.gcudat` data-pack format  *(status: shipped — books kind)*

`.gcudat` is the **inert-data** counterpart to the executable `.gcupkg`:

> **`.gcupkg` = a package that runs. `.gcudat` = data that's only read.**

That split *is* the trust boundary — the installer **never executes anything**
from a `.gcudat` (no `index.js`, no `works.js`, no eval), so a data pack is safe
to auto-install at lower trust than a code package. Used for prepared content:
reader books, doc bundles, MDN snapshots, datasets, fixtures — anything that's
pure data.

**A `.gcudat` is `{ manifest + a file tree }`, container-agnostic.** The
discriminator is the manifest, *not* the extension or container — a `.tgz`, a
`.zip`, or a bare directory carrying the manifest are all valid `.gcudat`s. The
`.gcudat` extension is just the discoverability affordance; detection sniffs for
the manifest.

**Manifest — `gcudat.json` at the pack root:**

```json
{
  "gcudat": 1,                 // version key — its presence = "this is a gcudat"
  "kind": "books",             // the router: books | docs | mdn | dataset | …
  "name": "ods",
  "title": "Open Data Structures",
  "license": "CC BY 2.5",
  "attribution": "Pat Morin",
  "index": "book.json"         // kind-specific entry pointer
}
```

**`kind` is open-ended.** A generic installer reads the manifest, validates the
version key, and dispatches to a registered **kind-handler** that only writes
files to the VFS. `books` → `/home/.books/library/<name>/` (then opens in the
reader); a future `dataset` → `/var/data/…`; etc. New kinds are a new handler,
not a new format.

| Piece | Where | Status |
|---|---|---|
| Producer (book dir → `.gcudat`) | `gcu-library/tools/build-gcudat.mjs` | shipped |
| Consumer (install, kind-routing, no eval) | `works/js/gcudat-install.js` | shipped |
| Container readers (`.tgz` / `.zip` by magic byte) | `@gcu/archive` (`gunzipBytes`/`listTar`/`listZip`) | shipped |
| Entry points | drop a `.gcudat` on the window · File → Install data pack… · `WKS.installGcudat(bytes)` | shipped |

Heavy prepared content lives in the separate **`gcu-library`** repo (books +
conversion tooling), distributed as `.gcudat`s — it does not bloat the auditable
repo. (Authoring `.gcudat`/`.gcupkg` from within Works/geas is a roadmap item;
geas already has the VFS + `@gcu/archive` primitives for it.)

### 6.3 Bundled documentation

When a `.gcupkg` contains a `docs/` directory, the host wires each `.md` file into the Works docs surface (`works/surfaces/docs.html`) under a per-extension section. The convention:

- `docs/index.md` is the entry page (the link in the docs surface sidebar lands here).
- Other `*.md` files are siblings in the sidebar, alphabetically ordered.
- Markdown is rendered with the same renderer the host uses for its own docs (admonitions, code-fence syntax highlighting, anchor links).
- A docs-only extension is legal — `index.js` can be a no-op manifest declaration. Useful for shipping reference packs that don't add code.

The README and SPEC at the gcupkg root are treated differently — they're shown inline in the **plugin-panel detail view** (the popup that opens when the user clicks an installed extension), not in the docs surface. README is the "what is this" text; the docs/ directory is the "how do I use it" reference.

On install, the host writes `docs/` into the VFS at:

```
/usr/share/docs/<extension-name>/
  index.md
  *.md
```

— available to the docs surface, to `cat` in geas, and to any other surface that wants to render extension docs. Uninstall removes the directory.

### 6.4 Bundled examples

When a `.gcupkg` contains an `examples/` directory, the host installs each `.txt` cell-def into the workspace's example pool, where it shows up in **Help → Open example…** alongside the host's built-in examples.

Each `.txt` follows the `examples/defs/FORMAT.md` spec (one `///`-delimited cell-def per file). An optional `examples/manifest.json` lets the extension control the picker entries:

```json
{
  "examples": [
    {
      "file": "kriging-basics.txt",
      "title": "Kriging basics",
      "category": "gslib",
      "description": "OK + SK on a small block model"
    },
    {
      "file": "variogram-fit.txt",
      "title": "Variogram fitting"
    }
  ]
}
```

Without the manifest, the host falls back to filename-derived titles and a `<extension-name>` category. With the manifest, the extension controls categorization and display order.

On install, examples land at:

```
/usr/share/examples/<extension-name>/
  *.txt
  manifest.json
```

— the same pool the built-in examples write to (see `gen_examples.js`), so the existing picker (`works/js/menubar.js openExamplePicker`) discovers them with no special-casing. Uninstall removes the directory.

Bundled examples are the **fastest way to teach a new user what your extension does** — better than docs, because they run. An extension that ships 3-5 working examples will see substantially more activation than one that ships only API reference.

---

## 7. Versioning and stability

**The platform is pre-1.0.** Concretely:

- Anything in `src/js/` that an extension touches (`registerExtension`, `_cellTypes`, `_taggedLanguages`, `_auditableExtensions`, `_airRegisterLowerer`, `window.auditable.hooks`, cell-context shape, builtin signatures) may change between minor versions without a deprecation window.
- AIR's IR shape (op codes, schema, validator) may grow new ops freely. Existing op semantics will not change once shipped.
- `package.json` shape is npm-standard and stable.
- The cross-language adapter convention (`exports: { <name>: module }`) is intentionally narrow — it's a directory lookup, hard to break.

**What we do not break, ever:**

- `name` / `version` as required manifest fields.
- The fact that an extension is a plain ES module.
- The fact that `registerExtension` is the entry point.

**What we may break before 1.0:**

- Field names inside capability objects (`cellType.parseNames` could become `cellType.parse_names`, etc. — though we have no plans).
- The shape of `ctx` injected into cells.
- Specific specialization-table keys (`_py`/`_soft` namespaces).
- The AIR lowerer return shape (currently a structured IR — could grow new required fields).
- The `requires` semver subset (could grow to include `||` or AND-combinations if real demand surfaces).

For an out-of-tree extension, pin to a specific auditable build (commit hash or release tag) and test against that build. We will publish a 1.0 stability declaration when the platform stabilizes; until then, every minor release is potentially breaking.

If your extension targets multiple auditable versions, the conventional pattern is to feature-detect rather than version-check:

```js
const register = window.auditable?.registerExtension;
if (!register) return;            // not in auditable, or pre-manifest-API build

const hooks = window.auditable?.hooks;
if (hooks) hooks.on('dag:complete', …);   // optional event subscription
```

---

## 8. Testing

For in-tree extensions, follow the pattern in `test/<name>.test.mjs`:

- Use Node's built-in test runner (`node --test`).
- Pure-logic tests run against `ext/<name>/src/api.js` (or `main.js`) directly — no DOM shim needed for non-DOM code.
- DOM-touching tests shim `globalThis.document = { querySelector: () => null, querySelectorAll: () => [] }` before importing.

For out-of-tree extensions:

- Same setup. Your `package.json` `"test": "node --test"` is enough.
- Integration with auditable runtime is exercised by loading your built `index.js` in a real browser session — use `npm run test:examples` (Playwright sweep over `examples/**/*.html`) or build a minimal harness page if your extension affects DAG correctness.

The `examples/defs/<category>/<name>.txt` system is the host's smoke-test corpus. If your extension is in-tree, contribute one or two `.txt` definitions exercising your surface — `gen_examples.js` will pick them up and the smoke test will hit them on every release.

---

## 9. Open questions / future work

- **MCP tools as a manifest field.** See §3.7. `manifest.mcpTools` will replace the imperative `navigator.modelContext.registerTool` pattern with re-registration + audit-log + access-control baked in.
- **Settings / preferences.** An extension contributing UI configuration (default themes for a language tag, API keys, feature toggles) has no convention today. Likely shape: `manifest.settings: { schema, defaults }` auto-populating a per-extension Settings panel tab. Pre-design.
- **Works surface contributions + context-menu actions.** Specced in §3.8. Implementation pending — wires `manifest.surfaces` + `manifest.contextMenu` into `works/js/surface-registry.js` and the tree menu builder; rides on the existing `_inlineLibsIntoSurface` for shared-lib reuse.
- **Asset bundling in `.gcupkg`.** A tagged language wanting to ship a custom CM6 theme, an icon for the cell-type chip, or a font has no current slot. Likely path: `assets/` directory in the gcupkg, written to `/usr/share/assets/<extension>/`. Out of scope for v1 of the gcupkg format.
- **Naming convention.** `@gcu/<slug>` is conventional but not enforced. Lowercase, no whitespace, semver-tag friendly — but the validator accepts anything that's a string. A linter pass would help here but isn't a runtime concern.
- **Permissions / capability gating.** Extensions today have full window access. A capability-token model would let users audit what an extension touches (FS / DOM / network / clipboard / …) before approving install. Pre-design; no implementation plan. (Related but distinct: **notebook → A-Bus access** — letting notebook *cells* publish/subscribe topics, call notebook-scriptable surface interfaces (§3.8.12), and opt into the raw bus under a `%mcp`-style consent. **Shipped** — `notebook.tag` / `notebook.call` / `notebook.requestBus`; design in `spec_inbox/notebook-abus-access-spec.md`.)
- **Extension marketplace / discovery.** Currently extensions are URL-installed or pkg-installed. A curated registry (signed metadata, version range queries) is an obvious follow-up but not on the near roadmap.
- **`pkg build` subcommand**. See §6.1 implementation-status table. Out-of-tree packers work fine today (a few hundred lines that walks a repo, validates `package.json`, computes the integrity hash, and zips the artifacts); an in-tree CLI is a quality-of-life follow-up.
- **Versioned manifest schema.** When 1.0 ships, a `manifestVersion: 1` field will become required. We'll auto-treat legacy manifests as version 0.
- **Localization.** `@gcu/soft` ships a pt-BR locale today as a soft-internal concern. If localization becomes a recurring need (UI strings in tagged-language errors, completions), a `manifest.locales` field would surface it. Pre-design.

---

## 10. Hello world

For a complete worked example that exercises every capability slot this spec defines, see **`ext/example-quip/`** — toy templating language packaged as a `.gcupkg`, with cell type + tagged template + Python adapter + Works surface + context-menu action all wired in. The directory is meant to be forked as a starting template.

The smallest useful extension is a tagged-language registration. The full template:

**`package.json`:**

```json
{
  "name": "@gcu/hello",
  "version": "0.1.0",
  "description": "A minimal Auditable extension — registers a hello tagged-template tag.",
  "type": "module",
  "main": "index.js",
  "license": "MIT"
}
```

**`index.js`** — runs in the notebook context (this hello extension contributes only a tagged language, so it's notebook-only; an extension that also added a Works surface would ship a separate `works.js` per §2.5):

```js
// One file, one ES module, runs at evaluation time.

function tokenize(code) {
  // Minimal — one token for the whole body. Real implementations split
  // into keywords / strings / comments for syntax highlighting.
  return [{ type: 'text', value: code, start: 0, end: code.length }];
}

function completions(_code, _cursor) {
  return [
    { label: 'hello', detail: 'greeting' },
    { label: 'world', detail: 'audience' },
  ];
}

const register = window.auditable?.registerExtension;
if (register) {
  register({
    name: '@gcu/hello',
    version: '0.1.0',
    description: 'A minimal hello tagged template',
    taggedLanguage: {
      name: 'hello',
      tokenize,
      completions,
    },
    onActivate() {
      console.log('[@gcu/hello] activated');
    },
  });
}
```

**Try it.** From any auditable code cell:

```js
await install('https://your-host/hello/index.js');
// Now in any cell:
const greeting = hello`hello world`;
// → '<minimally tokenized template>'
```

That's the entire contract. From here:

- Add `execute()` + `parseNames()` and a `cellType` block to make it a full cell type (§3.1).
- Add an `airLowerer` to compile your language to V8-hinted JS (§3.4).
- Add `exports` to surface a Python-shaped namespace to adder cells (§3.5).
- Add a `build.js` and a `src/` directory once you outgrow one file (§5.2).
- Wrap in a `.gcupkg` once you want drag-drop installs with bundled docs and examples (§6.1).

Each step is independent. Ship the smallest thing that works; add capabilities as users ask for them.

---

## 11. Documentation conventions

These rules apply to every `README.md` / `SPEC.md` an extension ships. Derived from the strongest in-tree docs (`ext/{air,adder,calque,crypto,switchboard,atra}/SPEC.md`) — the template is what those existing docs share, not a new ceremony. (Full long-form guide lives at `docs/advanced/docs-style.md`; this section is the digest.)

### 11.1 The first-paragraph rule

The first paragraph of every doc is its **elevator pitch** — single sentence first, optionally one expanding paragraph. No throat-clearing, no historical preamble, no "this document describes…". Two reasons:

1. The docs surface uses this as the search snippet — a bad first paragraph looks bad in every search result that hits it.
2. The reader has already decided to click into your doc; they want to confirm they're in the right place inside two seconds.

Good first paragraphs from existing specs:

```
A Python interpreter in JavaScript for auditable.            — adder
A spreadsheet language that compiles to xlsx.                — calque
The GCU canonical design system.                             — switchboard
Arithmetic TRAnspiler — wat, but for humans.                 — atra
```

Each is one bold sentence that tells you exactly what to expect.

### 11.2 Three audience tiers

| Doc | Reader | Voice |
|---|---|---|
| `README.md` | Someone who wants to **use** this package. | Concrete, examples-first, API-as-table-of-contents. |
| `SPEC.md`   | Someone who wants to **understand** this package. | Design-first, prose-heavy, lineage and rationale, longer-lived. |
| `INTERNALS.md` | Someone who wants to **modify** this package. | Implementation notes, walks, gotchas. Optional. |

Don't repeat content between them. README points readers at SPEC for "why"; SPEC points at README for "how to call it."

### 11.3 README template (user-facing)

```markdown
# @gcu/<name>

<one bold sentence — elevator pitch>

<one paragraph expanding the pitch: what it is, what it isn't, who
it's for. Avoid history; lead with capability.>

<optional: a minimal working example as a code block.>
<optional: "Pre-1.0 — APIs may change on minor version bumps.">

## Install         (only if npm-published / installable; else drop)
## Quick start     (under 30 lines, end-to-end)
## API             (signature + one-line summary + optional example;
                    order by importance, not alphabetically)
## Usage patterns  (worked examples covering common cases)
## Options         (every key in the options bag, if you have one)
## Data model      (types / IRs / schemas if vocabulary matters)
## Architecture    (optional one-paragraph overview)
## What's not supported   (honest enumeration of limitations)
## Status          (optional — pre-1.0 / stable / experimental + date)
## License
```

### 11.4 SPEC template (design-facing)

```markdown
# <name>

**<one bold sentence — elevator pitch>**

<one paragraph framing: what, what problem, what's distinctive.>

<optional: code example or ASCII diagram within first 30 lines.>

---

## Lineage              (recommended — even one sentence pays off)
## Premise / Overview   (motivating argument; design commitments)
## <Core domain sections>      (Syntax / Semantics / Types / IR / …)
## Design principles    (recommended — anchors trade-offs for future readers)
## Architecture         (file tree + one-line summaries per file)
## API reference        (optional — leave to README if you have one)
## Testing              (what's covered, where the tests live)
## Open questions       (honest list — date your roadmap items)
## What <name> is NOT   (recommended — drops reader expectations)
## Versioning           (optional)
```

### 11.5 Metadata block

When a doc warrants it (SPECs of substantial packages), include a metadata block near the top:

```markdown
| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 1.0                                            |
| Status     | Canon / Draft / Implemented / Pre-1.0          |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | What this descends from, dated                 |
```

Smaller packages can use bold-prefix lines instead:

```markdown
**Status:** Implemented (v1 format)
**Date:** 2026-03-18
**Implementation:** `src/js/crypto.js`, tests: `test/crypto.test.mjs`.
```

### 11.6 Anti-patterns

Things to avoid:

- **Opening with definitions of unrelated context.** "Markdown is a lightweight markup language…" → cut. The reader knows.
- **API-as-prose paragraphs.** API surfaces go in tables or code blocks. If you find yourself writing "the function `foo` accepts a `bar`," reach for the markdown table.
- **Hidden capabilities.** If a feature exists, document it. Don't bury non-obvious switches in inline comments — promote them to a §Options section.
- **Stale TODO markers without dates.** A `TODO` from two years ago pretending to be a roadmap item is a lie. Date your roadmap items so the staleness is visible.
- **"This document describes…" / "This README explains…"** The doc describes itself by existing. Lead with the subject.
- **Decorative emoji.** GCU aesthetic — functional over decorative. Symbols with semantic meaning (✓, ✗, ⚠, →) are fine when used consistently; decorative emoji isn't.
- **Marketing voice.** "Powerful, flexible, and easy-to-use" is a smell. Show, don't claim.

### 11.7 When to write what

- New ext under ~500 LOC of source: **README only** is usually enough.
- New ext that introduces a *vocabulary* (a language, an IR, a protocol, a format): **SPEC required.** README optional but recommended.
- New ext that's *application infrastructure* (rails, dialog, menu, …): **README only**, with the SPEC subsumed into the consumer's spec.
- Ext that ships to npm: **README required** (it's what npmjs.com shows on the package page); SPEC optional.

### 11.8 File naming + character set

- `ext/<name>/README.md` — user-facing.
- `ext/<name>/SPEC.md` — design-facing.
- `ext/<name>/INTERNALS.md` — implementation-deep, optional.
- All caps, `.md` extension, UTF-8. Use raw Unicode characters (`—`, `×`, `α`, `→`, `·`) — no `\uXXXX` escapes.

The Auditable docs surface auto-ingests every `ext/*/SPEC.md` and `ext/*/README.md` it can find. Keep that in mind: if you write it, people will search it.

---

## 12. Reference

| Concern | Source |
|---|---|
| Manifest validation + apply pipeline | `src/js/cell-types.js:40–129` |
| Built-in cell-type registrations | `src/js/cell-types.js:292–327` |
| Capability lookup helpers | `src/js/cell-types.js` (exported on `window.auditable`) |
| AIR lowerer registration (adder) | `ext/adder/src/air-lower.js:75–84` |
| AIR lowerer registration (soft) | `ext/soft/src/air-lower.js:34–38` |
| Cross-lang adapter pattern (learn) | `ext/learn/adder.js:80–96` |
| Cross-lang adapter pattern (natra) | `ext/natra/adder.js:730–740` |
| Adder cell-arena hook (NOT contextHook) | `ext/natra/adder.js:296–326` |
| ipynb substitution table | `ext/ipynb/src/substitutions.js` |
| Example picker (consumes `/usr/share/examples/`) | `works/js/menubar.js openExamplePicker` |
| Cell-def format (used by `examples/*.txt`) | `examples/defs/FORMAT.md` |
| Docs surface (consumes `/usr/share/docs/`) | `works/surfaces/docs.html` |
| Hook bus (intra-notebook events) | `src/js/hooks.js`, CLAUDE.md "hook bus" section |
| A-Bus (cross-iframe events, Works) | `ext/abus/SPEC.md`, `spec_inbox/a-bus-spec.md` |
| Build concat patterns | `ext/adder/build.js`, `ext/plot/build.js`, `ext/licenses/build.js` |
