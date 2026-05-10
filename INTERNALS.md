# Auditable internals

> Public surface for extension authors and contributors. Full design context lives under `spec_inbox/shipped/`; this document is the working reference.

This is what's stable enough to build against. Pre-1.0 — APIs evolve as consumers reveal real needs — but the shapes below have settled across the spec_inbox/auditable-internals-roadmap tracks (A–E shipped 2026-05-08).

---

## 1. `window.auditable` — public surface

Single canonical namespace. Replaces the legacy `window._x` slot pattern.

### 1.1 Hooks (event bus)

`window.auditable.hooks` — pure synchronous event bus, defined in `src/js/hooks.js`. Intra-notebook lifecycle events. **Cross-realm coordination** (Auditable Works panels) is A-Bus's job, not this bus.

```js
const off = auditable.hooks.on('dag:complete', () => { /* ... */ });
auditable.hooks.once('crypto:unlocked', () => { /* fires once */ });
auditable.hooks.off('event', fn);
auditable.hooks.emit('notebook:dirty');
await auditable.hooks.emitAsync('event', ...args);
auditable.hooks.listenerCount('event');
```

**Event catalog:**

| Event | Payload | Emitted by | Subscribed by |
|---|---|---|---|
| `dag:start` | `{ dirtyIds, force }` | `exec.js` runDAG | goto.js |
| `dag:cell:before-exec` | `cell` | `exec.js` runDAG | goto.js |
| `dag:cell:after-exec` | `cell, index` | `exec.js` runDAG | observers (no return value) |
| `dag:complete` | none | `exec.js` runDAG | mcp-adapter, workshop |
| `notebook:dirty` | none | editor.js, fs.js, settings.js, ui.js, mcp-adapter, modules.js | editor.js (Works bridge) |
| `notebook:saved` | `{ filename, mode }` | save.js | (extension hook point) |
| `notebook:loaded` | `{ source }` | save.js, init.js | (extension hook point) |
| `fs:changed` | none | globals.js (VFS write/delete/rename), fs.js | fs.js panel refresh |
| `crypto:locked` | none | crypto.js cryptoLock | mcp-adapter |
| `crypto:unlocked` | none | init.js _resumeAfterUnlock | mcp-adapter |
| `mcp:tool-call` | `{ tool, args, result, error }` | mcp-adapter | (extension hook point) |

**Single-slot interceptor** (separate from pubsub since the bus doesn't return values):

```js
auditable.hooks.setDagCellInterceptor((cell, idx) => {
  // Return -1 to continue, or a cell index to redirect DAG execution.
});
```

Used by `goto.js` for `// %goto` redirect. Single-slot (not a list of listeners) because there's one redirect target.

### 1.2 `registerExtension(manifest)` — extension registration

`window.auditable.registerExtension(manifest)` is the **single canonical registration entry** for everything an extension contributes. Defined in `src/js/cell-types.js`.

```js
auditable.registerExtension({
  // Required
  name: '@gcu/myext',
  version: '0.1.0',

  // Optional contributions
  apiVersion: '0.x',
  description: 'My extension',
  pluginUrl: '@gcu/myext',           // settings-panel metadata

  cellType: {
    name: 'myext',                    // cell type discriminator
    label: 'myext',
    color: '#abcdef',
    shortcut: 'x',
    editDebounce: 300,
    capabilities: {
      executable: true,               // runs via Ctrl+Enter / DAG
      definesScope: true,             // exports vars to downstream
      hasOutput: true,                // has a cell-output element
      hasEditor: true,                // CM6 editor (vs textarea)
    },
    parseNames: (code) => Set<string>,
    findUses: (code, allDefined) => Set<string>,
    execute: async (code, upstream, cell) => ({ defines, output, error }),
    createEditor: (cell, onChange) => ({ el, getCode, setCode, focus, destroy }),
    syntaxCheck: (code) => boolean,
    completions: (prefix) => Array,
    tokenize: (code) => Array,
  },

  // Tagged template language (e.g. myext`...`)
  taggedLanguage: { name: 'myext', tokenize, completions },
  // Or multiple
  taggedLanguages: [{ name: 'a', tokenize }, { name: 'b', tokenize }],

  // AIR lowerer (transpile path; tree-walker is fallback)
  airLowerer: { language: 'myext', fn: (ast, code) => airModule },

  // Cross-language exports (importable via getExports)
  exports: { foo: ..., bar: ... },

  // Globals — extra named values on `window` (e.g. tag-template functions)
  globals: { myext: tagFn },

  // Cell-context hook (mutates ctx during cell execution)
  contextHook: { setup: (cell, ctx) => { /* mutate ctx */ } },

  // Lifecycle
  onActivate: () => {},
  onDeactivate: () => {},
});
```

**Validation at registration:**
- `name` and `version` (semver) required.
- `cellType.capabilities` required when `cellType` present.
- `executable: true` requires `execute()`; `definesScope: true` requires `parseNames()`.
- Built-in cell type names (`code`, `md`, `css`, `html`) cannot be shadowed.
- `taggedLanguage[s]` requires `tokenize()`.
- Re-registering the same `name` warns and replaces (allows dev hot-reload).

**Lookup helpers** (also on `window.auditable.*`):

```js
auditable.getExtension(name)        // → manifest or null
auditable.listExtensions()          // → manifest[] (incl. built-ins)
auditable.getCellType(name)         // → cellType field or null
auditable.getTaggedLanguage(name)   // → tagged-language entry or null
auditable.getExports(name)          // → exports[name] or null
auditable.hasExports(name)          // → boolean
```

Built-in cell types (`code`, `md`, `css`, `html`) are auto-registered as manifests at module load (`capabilities.builtin: true`).

### 1.3 Services (compiler infrastructure)

These are callable services rather than pubsub events. Set on `window.*`:

| Service | Purpose | Source |
|---|---|---|
| `window._airAnalyzer(code, allDefined)` | parse + lower JS to AIR + run passes | `ext/air/src/api.js` |
| `window._airEmit(air, scopeKeys, injectedNames, opts)` | emit V8-hinted JS from AIR | same |
| `window._airNeedsAsync(air)` | sync vs async function detection | same |
| `window._airRegisterLowerer(language, fn)` | register a frontend lowerer | same |
| `window._airGetLowerer(language)` | look up a registered lowerer (wrapped with fallback handling) | same |
| `window._airRePropagate(air, opts)` | re-run passes (for cross-cell type flow) | same |
| `window._airDebug` | toggle AIR fallback warnings | same |
| `window._airValidate` | when truthy (e.g. `?airdebug=1`), run validator after each lowering | same |
| `window._airValidateModule(module)` | manually validate an AIR module against the schema | same |
| `window._airPrettyPrint(module)` | render an AIR module to human-readable text | same |
| `window._airOpSchema` | the OP_SCHEMA table (introspection: arity / args / regions / extras / can_be_async / side_effecting) | same |
| `window._airRegisterSpecializations(namespace, specs)` | register runtime-helper specializations (frontend bundles call this at init) | same |
| `window._airGetSpecializations(namespace)` | look up registered specializations | same |
| `window._airInterpret(module, opts)` | run an AIR module via the tree-walker interpreter (no eval/Function — for sanity-check, debugger, CSP-locked) | same |
| `window._airInterpreter` | the `Interpreter` class itself (for debugger UX needing access to internal state) | same |
| `window._notebookVFS` | the live VFS instance | `globals.js` |
| `window._installedModules` | runtime cache of installed modules (URL → entry) | various |
| `window._taggedLanguages` | runtime tagged-language registry (read-only consumer) | `cell-types.js` |
| `window._cellTypes` | runtime cell-type registry (read-only consumer) | same |
| `window._auditableExtensions` | runtime exports map | same |
| `window._auditablePlugins` | plugin metadata Map (settings panel) | same |

**Note:** the registries (`_cellTypes`, `_taggedLanguages`, `_auditableExtensions`, `_auditablePlugins`) are kept as the underlying storage layer. The new write API is `registerExtension`; reads should prefer the lookup helpers above.

---

## 2. Notebook format (saved files)

A saved Auditable notebook is a single self-contained HTML file. The runtime is gzip-compressed in a `<script type="text/plain">` payload + small bootstrap loader. Persistent state lives in one of two HTML comment blocks before the `<script>` tag.

### 2.1 Cleartext: `AUDITABLE-VFS`

```html
<!-- auditable notebook data: VFS dump (persistent mounts only) -->
<!--AUDITABLE-VFS
{ "/var/notebook.txt": { "type":"file","kind":"text","content":"...","size":N },
  "/home/nb/data.csv": { "type":"file","kind":"text","content":"..." },
  "/var/modules/lodash/source": { "type":"file","kind":"text","content":"..." },
  "/var/modules/lodash/meta.json": { ... },
  "/empty/dir/": { "type":"directory" } }
AUDITABLE-VFS-->
```

The dump is a flat `{ path → entry }` JSON object. Each entry:
- `{ type: 'file', kind: 'text' | 'binary', content: string, size: number }`
- `{ type: 'directory' }` (for empty directories that need to round-trip)

Binary content is base64. Strict UTF-8 decode at walk time picks the kind — bytes that don't round-trip cleanly become base64 binary. Module URLs in `/var/modules/<x>/` are `encodeURIComponent`-encoded (e.g. `@gcu/adder` → `%40gcu%2Fadder`).

### 2.2 Encrypted: `AUDITABLE-CRYPTO`

```html
<!-- encrypted notebook data: passphrase required to access cells, settings, modules, files -->
<!--AUDITABLE-CRYPTO
{ "version": 1, "cipher": "AES-GCM-256", "iv": "<base64>",
  "payload": "<base64 ciphertext of the VFS dump JSON>",
  "methods": [ {type:"pbkdf2",...}, {type:"recovery",...} ] }
AUDITABLE-CRYPTO-->
```

Same VFS dump, AES-GCM-encrypted. PBKDF2 (passphrase) and HKDF (recovery key) wrap the same DEK independently. See `ext/crypto/SPEC.md`.

**Persistence is write-on-save-only.** No DOM mutation between user-initiated saves. The legacy `live sync to DOM comment nodes` pattern (for native browser Ctrl+S) is retired — browsers save as MHTML or stale-DOM, never produced a working file in practice.

**Legacy 4-block format** (`AUDITABLE-DATA` + `AUDITABLE-SETTINGS` + `AUDITABLE-MODULES` + `AUDITABLE-FS`) auto-imports on load. Older notebooks are detected and rehydrated into the VFS via `importLegacyFormat()`; next save writes the new single-block format. One-time and transparent.

### 2.3 VFS mount layout

| Mount | Backend | Persistent | Contents |
|---|---|---|---|
| `/home/nb/` | CommentBackend | yes | user files (the `notebook.fs` API) |
| `/var/` | MemoryBackend | yes | `/var/notebook.txt` (cells + settings + module decls), `/var/modules/<url>/{source,meta.json}` |
| `/tmp/` | MemoryBackend | no | volatile scratch |
| `/usr/lib/python/` | MemoryBackend | no | Python stdlib (adder repopulates on load) |

The Persister (`src/js/persist.js`) walks `/home/nb/` and `/var/` at save time. Other mounts are reconstructed at load time.

### 2.4 `///` notebook format (`/var/notebook.txt`)

Plain-text format. Spec at `examples/defs/FORMAT.md`. Same format as `examples/defs/<category>/<name>.txt` files.

```
/// auditable
/// title: my notebook
/// settings: {"theme":"dark","fontSize":13,"width":"860"}
/// module: @gcu/sql
/// module: https://esm.sh/lodash abc123

/// md
# heading
some markdown

/// code
const x = ui.slider("n", 50, {min: 0, max: 100});

/// code collapsed
ui.display(`x = ${x}`);
```

Round-trip via `parseNotebookTxt(txt) → { title, settings, cells, modules }` and `serializeNotebookTxt({...})` (in `src/js/serialize.js`).

---

## 3. Cell context (what cells get)

Every code cell runs inside an `AsyncFunction` (or plain `Function` when AIR detects no `await`). The context is constructed per-cell by `createCellContext()` in `src/js/cell-context.js`.

### 3.1 Injected parameters

These names are passed as parameters to every cell function. They're listed in `INJECTED_NAMES` (engine.js):

```
ui, std, sr, load, install, installBinary, invalidation, display, print,
md, html, css, workshop, notebook, worker, workerPool, vfs
```

| Name | Description | Source |
|---|---|---|
| `ui` | `{ display, print, html, canvas, table, slider, dropdown, checkbox, textInput, download, upload, drop }` | `cell-builtins/ui.js` + `file-io.js` |
| `std` | standard library — `csv`, `sum`, `mean`, `bin`, `linspace`, etc. | `stdlib.js` |
| `sr` | sideact reactive primitives — `signal, computed, effect, batch, h, each, render` | `sideact.js` |
| `load(url)` | import ESM module (cached); supports virtual `@std`, `@python`, `fs:`, `@atra/<name>` | `cell-builtins/modules.js` |
| `install(url)` | fetch + persist module to `/var/modules/<url>/` for offline reload | same |
| `installBinary(url, opts?)` | fetch + persist binary asset; returns blob URL | same |
| `invalidation` | promise that resolves when cell is about to re-run (cleanup hook) | `cell-context.js` |
| `display(...)` | append to cell-output (Element / TaggedContent / `_repr_html_` / plain) | `cell-builtins/ui.js` |
| `print` | alias for `display` | same |
| `md`, `html`, `css` | tagged template builtins for rich content | `engine.js` |
| `workshop(pages, opts?)` | slide-out tutorial panel | `cell-builtins/workshop.js` |
| `notebook` | `{ fs, cells, scope, addCell, scrollTo, focus, collapse, expand, run }` | `cell-builtins/notebook-api.js` |
| `worker(fn)` | spawn a Web Worker from a pure function (auto-terminates on cell re-run) | `cell-builtins/workers.js` |
| `workerPool(fn, n?)` | pool of workers with `.map()` for parallel batch dispatch | same |
| `vfs` | the live VFS instance | `cell-context.js` |

Cells that consume only some of these can take only the names they need; the runtime passes them all.

### 3.2 Cell-context hooks

Extensions can mutate the `ctx` object during construction via `contextHook` in their manifest:

```js
auditable.registerExtension({
  name: '@gcu/myext',
  version: '0.1.0',
  contextHook: {
    setup(cell, ctx) {
      ctx.myThing = (...) => { /* surface a new builtin */ };
    },
  },
});
```

Used by `@gcu/sideact` to wire `sr.state` per-cell persistence. See `ext/sideact/src/main.js`.

### 3.3 Cell-instance fields

Each cell carries memoised state on the cell object:
- `cell._cachedFn`, `cell._cacheKey` — compile cache (invalidated by source + import-type changes)
- `cell._air`, `cell._airAnalyzed`, `cell._airImportKey` — AIR analysis state
- `cell._inputs`, `cell._callbacks`, `cell._widgetCleanups`, `cell._inputTimer` — widget bookkeeping
- `cell._tplCache`, `cell._tplScopeSig`, `cell._bindCode`, `cell._textMarkers`, etc. — md/html template binding state
- `cell._invalidate` — resolver for the per-run invalidation promise
- `cell._workshopRecheck`, `cell._workshopCleanup`, `cell._workshopShown` — workshop state
- `cell._pluginEditor`, `cell._fallback`, `cell._ctx` — plugin cell state
- `cell._lastResult` — last DAG result

None of these are serialised; they're rebuilt on load. (Track G in the internals roadmap will namespace them under `cell.compile`, `cell.widgets`, `cell.binding`, etc.; deferred quiet cleanup.)

---

## 4. Writing an extension

Minimal cell-type extension:

```js
// my-extension.js
auditable.registerExtension({
  name: '@me/say-hi',
  version: '0.1.0',
  description: 'Tiny demo extension',

  cellType: {
    name: 'sayhi',
    label: 'sayhi',
    color: '#9966cc',
    capabilities: {
      executable: true,
      definesScope: false,
      hasOutput: true,
      hasEditor: false,
    },
    execute: async (code, _upstream, cell) => {
      const name = code.trim() || 'world';
      return { output: `hello, ${name}` };
    },
  },
});
```

Then publish as an npm package or load via `install('https://example.com/my-extension.js')` from a code cell.

For full-featured examples see:
- `ext/adder/src/register.js` — full manifest (cellType + 2 tagged languages + AIR lowerer + globals + plugin metadata)
- `ext/soft/src/register.js` — same plus locale registration
- `ext/sql/index.js`, `ext/shader/index.js` — minimal `taggedLanguage`-only extensions
- `ext/plot/src/api.js`, `ext/sadpan/src/api.js`, `ext/natra/adder.js` — `exports`-only extensions
- `ext/sideact/src/main.js` — `contextHook` extension

---

## 5. Build & test

```sh
npm test                   # node --test, all unit tests (~3400)
npm run test:examples      # Playwright smoke across 67 example notebooks (~9 min)
node build.js              # rebuild auditable.html
node gen_examples.js       # regenerate example notebooks (after build.js)
node ext/<name>/build.js   # rebuild a specific extension bundle
```

Per-extension builds before `node build.js`:
- After changing `ext/<name>/src/`, run `node ext/<name>/build.js`.
- After any `src/` or `ext/` change, run `node build.js` to rebuild `auditable.html`.
- Then `node gen_examples.js` so the example notebooks pick up the new runtime.

The Playwright smoke is the integration gate. It opens every example, waits for autorun to settle, and asserts no cell-error elements. Slow but high-leverage when changing AIR or the runtime.

---

## 6. Conventions

- **Vanilla JS only.** No frameworks, no transpilation. No TypeScript files.
- **Pre-1.0.** APIs evolve; saved-notebook formats may change with one-time migration paths (e.g. legacy 4-block → AUDITABLE-VFS).
- **Pure modules stay pure.** `dag-core.js`, `engine.js`, `serialize.js`, `stdlib-core.js`, `runtime.js`, `hooks.js`, `persist.js` (mostly), `cell-builtins/text-compression.js` take zero DOM dependencies. New pure modules follow suit.
- **No deprecation windows for internal APIs.** Pre-1.0 internal renames remove old names when the last consumer migrates, in the same commit. Public APIs (`@gcu/*` on npm) get coordinated releases.
- **Persistence is write-on-save-only.** No DOM mutation between user-initiated saves.
- **Hook bus, not window slots.** New lifecycle events use `auditable.hooks.emit/on`. Cross-realm coordination is A-Bus's job (see `spec_inbox/a-bus-spec.md`).
- **`///` txt is the canonical notebook serialization** (per `examples/defs/FORMAT.md`).

---

## 7. Where things live

| Path | What |
|---|---|
| `src/js/main.js` | module manifest (import order = registry order) |
| `src/js/state.js` | `S` shared state object, `$`, `$$` helpers |
| `src/js/hooks.js` | event bus |
| `src/js/cell-types.js` | `registerExtension`, capability lookups, plugin uninstall |
| `src/js/dag-core.js`, `dag.js` | DAG analysis (pure + browser wrapper) |
| `src/js/engine.js` | pure execution engine |
| `src/js/exec.js` | DAG orchestration + AIR compile glue |
| `src/js/cell-context.js` | per-cell context factory |
| `src/js/cell-render.js` | md/html cell rendering |
| `src/js/cell-builtins/*` | individual builtin factories |
| `src/js/save.js` | save/load entry points + buildNotebookHtml |
| `src/js/persist.js` | Persister classes + VFS sync helpers + legacy import |
| `src/js/serialize.js` | pure serialization (cells, /// txt, VFS walkers) |
| `src/js/crypto.js` | encryption primitives |
| `src/js/init.js` | bootstrap IIFE, lock screen, encryption settings UI |
| `src/js/globals.js` | window.* wiring (event handlers from template HTML) |
| `ext/<name>/` | per-extension package, built by `node ext/<name>/build.js` |
| `ext/air/src/` | AIR compiler (registry-style sub-modules) |
| `examples/defs/` | `///` text definitions of example notebooks |
| `examples/<category>/` | generated HTML notebooks |
| `spec_inbox/` | design specs (gitignored; not part of the repo) |
| `spec_inbox/shipped/` | specs for shipped features (kept for reference) |

---

## 8. Roadmap status (as of 2026-05-09)

The pre-announcement internals cleanup is documented in `spec_inbox/auditable-internals-roadmap.md`. **All six tracks (A-F) shipped:**

- **A — AIR lowerer extraction.** `@gcu/air` exposes `registerLowerer`; adder + soft lowerers extracted to their own packages.
- **B — Hook bus.** Single `auditable.hooks` event bus replaces 11 ad-hoc lifecycle slots.
- **C — Extension API.** Single `registerExtension(manifest)` API replaces 4–6 per-extension registries.
- **D — Cell-builtins split.** `exec.js` 1462 → 224 lines; builtins live under `cell-builtins/`.
- **E — Persistence.** VFS-unified; single AUDITABLE-VFS save block; legacy 4-block format auto-imports.
- **F — AIR v0.3 self-describing IR.** OP_SCHEMA table, opt-in validator, textual IR pretty-printer (`prettyPrint` + `parseText`), ScopeChain with push/pop semantics, PASSES metadata, full `ctx.symbols` migration with proper function-scope shadowing fix. See `ext/air/SPEC.md`.

**Post-F shipped (also 2026-05-09):**

- **AIR ctx.exprs region scoping.** emit-js's inline-consume cache is now ScopeChain-backed; pop-time invariant catches cross-region single-use refs under `?airdebug=1`.
- **Lowerer-frontend extraction.** Shared `BaseLowerCtx` + `captureOps` + `emitPhiSelect` + `lowerIfRegion` + `lowerLoopRegion` + `ctx.truthy` hook + `ctx.makeTempName` + `ctx.emitNamespacedCall` in `ext/air/src/lower/base.js`. Adder + soft each shed ~150 LOC of boilerplate; `_py.add → +` and `_soft.eq → ===` specializations registered via the new `registerSpecializations` API.
- **AIR interpreter v0.** `ext/air/src/interp.js` (~570 LOC). Tree-walks AIR ops directly (no eval/Function). Used to sanity-check the JS emitter (35-cell test bank verifies emit-js and interp produce same results). Foundation for a future step-debugger, CSP-locked builds, AIR semantics reference.

**Remaining (not blocking; all in `spec_inbox/lang/` for future):**
- **G — cell-field namespacing** (deferred): `cell._inputs` → `cell.widgets.inputs`, etc.
- **`tools/*` menubar migration** (`spec_inbox/ui-integration-spec.md`).
- **`@gcu/vec`** — TypedArray-based numerical library, lightweight NumPy alternative for JS. Spec at `spec_inbox/gcu-vec-spec.md`. Designed to ship as standalone npm package independent of Auditable.
- **AIR decompiler** (`spec_inbox/lang/air-decompiler-spec.md`): AIR → AST → source for cross-language transpilation.
- **AIR symbolic execution** (`spec_inbox/lang/air-symbolic-execution-spec.md`): static analysis, range refinement, cell-purity classification.
