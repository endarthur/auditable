# @gcu/build — specification

**Status:** draft — **rev 2** (2026-06-06). Rev 2 folds in: the pure-core / I/O-adapter
split that makes the bundler **browser-native** (§1.4); the `inline` option for the
shared-primitive pattern (§4.2); `renameCollisions` exposed as a reusable pass + a
**merge mode** for the surface inliner's inter-bundle case (§6.6–6.7); a reproducibility
**drift check** (§13.2); and TS annotation elision promoted to a real phase (§18). The
collision examples are now the real ones we've hit (`inferType`, `cmp`).
**Target LOC:** 400–500 for the core
**Audience:** implementers (including Claude Code), future maintainers, reviewers

## 1. Motivation

### 1.1 The local problem

Auditable's `ext/*` packages each ship an `index.js` produced by a hand-written `build.js` that regex-strips `import`/`export` keywords and concatenates source files in a **hand-maintained file list**. Two structural failure modes, both observed in practice:

- **Silent top-level collisions.** Independent modules declaring the same top-level name collide in flat scope: `lowerExpr` across AIR lowerers; `inferType` across `@gcu/over` and `@gcu/loom`; `cmp`/`cmpVal` across over and strata. The current mitigation — manual `_ad`/`_sf`/`_over` suffixes — doesn't scale and **doesn't catch unknown collisions at build time**; they surface at *load*, caught (if you're lucky) by a smoke test.
- **Hand-maintained manifests drift.** The `files: [...]` array is edited by hand; forgetting an entry ships a bundle that *calls* a symbol it never *defines* — this happened (`join.js` omitted from `@gcu/over`'s list, so the bundle invoked `collectJoinAggs` with no definition).

### 1.2 What it is

`@gcu/build` replaces the per-package `build.js` regex pipeline with a small AST-based bundler. It reuses `@gcu/air`'s scope analysis, parses with vendored `acorn`, and emits a single flat-scope ES module with a source map. Scope isolation is by **renaming on collision** — a real scope-hoister — not IIFE-wrapping or a runtime `require`. The module set is the **transitive import graph from `src/main.js`**, not a hand list — which structurally eliminates the drift class above: *you cannot forget a file that something imports.*

It is deliberately narrow — concatenation + scope isolation only — because the GCU ecosystem is shaped so the rest doesn't apply: manifest-driven graph, relative imports only, hand-authored sources (no tree-shaking benefit), single-file output, no dev server. The constraints produce the simplicity; the tool is the consequence.

### 1.3 The big idea

GCU's bet is **owned and legible all the way down.** The runtime, the platform (Works / geas / VFS), and the data formats are all owned and outlive their tooling (hopper: *"a single artifact that outlives the tooling that made it"*). The one rented thing every "no-build" project secretly leans on is the *build*. `@gcu/build` is the keystone that makes the bet true to the bottom: it is **itself a GCU package, it builds itself, and its core runs in the browser** (acorn + air already do — see §1.4). Once browser-native, the loop closes — **Works can author, build, *and* run GCU software, air-gapped, with no node / npm / toolchain, indefinitely.** The longevity property hopper gives *data* now applies to the *build*: the stack is rebuildable from source forever, because nothing in the chain is transitive or rented.

The discipline that protects this: the tool stays **concat + isolate**, never *transform*. A build tool simple enough to be fully owned, legible enough to read in one sitting, and constrained enough that it *cannot* grow into a castle. The constraint is the feature, not an apology — which is why the non-goals (§2) are load-bearing even though the tool is small.

### 1.4 Architecture: a pure core + I/O adapters (browser-native by construction)

The single most important structural decision: **the bundler core is a pure, I/O-free function**, and every filesystem / CLI concern lives in a thin adapter around it.

```js
// the core — no fs, no globals, no environment branches:
bundleModules(sources, opts) → { code, map, meta, warnings }
//   sources: { [path: string]: string }   — the module set, already read
//   opts:    { entry, inline?, define?, sourcemap?, header? }
```

`bundleModules` does only `string → acorn AST → scope analysis → rename → text-splice → string`. acorn runs in the browser (`window.Acorn`), `@gcu/air` runs in the browser, and the core touches no `fs` — so **it is browser-native by construction, not by porting effort.** Three adapters feed it:

- **node-fs** — reads `src/`, writes `index.js` + `.map` + `.meta.json`. Backs the CLI and `node ext/<pkg>/build.js`.
- **@gcu/vfs** — reads/writes the workspace VFS. Backs building **inside Works / geas, in-browser** — the GCU desktop building its own packages and `.gcupkg`s with no toolchain. (geas gets a `gcu-build` builtin; pkg can build from source.)
- **memory** — a plain object in, a result out. Backs the test suite (§16): no temp dirs, deterministic.

`bundle(opts)` (§13.1) is the node-fs adapter: resolve + read the manifest from disk, call `bundleModules`, write the outputs. The **contract is `bundleModules`**; everything else is plumbing. Manifest *walking* (discovering the transitive set by following imports) is adapter-side — it reads files — and hands the core a complete `{path: source}` map plus the entry path.

Everything below specifies the core's behavior; items that are adapter-specific (file writes, the CLI, VFS) say so.

## 2. Non-goals

Declared out of scope, explicitly, so they don't get added later without consensus:

- **Plugin system.** No transform hooks, no loader registration, no config-driven pipeline.
- **Configuration files.** All options are function arguments. The library does not read `.gcubuildrc`, `gcu-build.config.js`, or any such file.
- **node_modules resolution.** Bare specifiers pass through unchanged.
- **Package.json `"browser"` field remapping.** Downstream bundlers handle this.
- **Polyfill injection.** Output targets modern runtimes; consumers polyfill if needed.
- **Minification.** Separate concern, separate tool if ever needed.
- **Code splitting / dynamic `import()`.** `import()` expressions in sources are a build error.
- **CSS, asset, or non-JS imports beyond JSON via `import attributes`.** Deferred; currently a build error.
- **HMR / dev server.** A separate tool (`@gcu/watch` or similar) may wrap `@gcu/build` later.
- **CJS or UMD output.** ESM only.
- **Tree-shaking.** All manifest-listed modules are included in full.
- **TypeScript syntax beyond annotation elision.** No type-aware transformations. (Elision itself is a phase 2 addition; see §14.)

## 3. Manifest format

The manifest is `src/main.js`. Its `import` and `export ... from` declarations, in source order, define the module set and its build order. No separate JSON or declarative format.

Rationale: the main.js-as-manifest convention is already used across every existing `ext/*` `build.js`. It's an ES module that the runtime can also load directly, which means there is exactly one source of truth for "what this package contains." A separate declarative format would introduce a drift surface.

The bundler walks imports transitively from `src/main.js`. Declaration order at each level is preserved. Once a module is included, subsequent imports of it are no-ops.

### 3.1 Import forms recognized

```js
import './file.js';                          // side-effect import
import { foo, bar } from './file.js';        // named imports
import { foo as baz } from './file.js';      // aliased
import defaultExport from './file.js';       // ERROR: default exports disallowed
import * as ns from './file.js';             // namespace import (allowed, see §7.3)
export { foo } from './file.js';             // named re-export
export { foo as bar } from './file.js';      // aliased re-export
export * from './file.js';                   // wildcard re-export
```

### 3.2 Rejected forms

```js
import('./file.js')                          // dynamic import — error
import 'some-package'                        // bare specifier (see §4)
await import(...)                            // dynamic — error
export default ...                           // default exports disallowed
```

Default exports are banned in sources. If a default is genuinely required for external consumers, use `export { foo as default }` at the entry point. In practice no existing ext/* needs this.

## 4. Resolution

Two rules:

1. **Relative imports** (`./foo.js`, `../lib/bar.js`) that resolve to a path inside the package's `src/` directory are **inlined**. Extensions must be explicit. No directory-index inference (`./foo` meaning `./foo/index.js` is an error). No extension inference (`./foo` meaning `./foo.js` is an error).

2. **Bare specifiers** (`@gcu/air`, `acorn`, etc.) and **relative imports that escape `src/`** (`../../vendor/lib.js`) are **external**. They appear in the output `index.js` verbatim. Downstream resolution (by Auditable's loader, by Vite, by a downstream bundler) handles them.

No `node_modules` traversal. No `package.json` `exports` field consultation. No conditional exports. If a relative import points to a file outside `src/` it is passed through as-is, identifier-for-identifier, as an external dependency.

### 4.1 Import attributes

`import x from './config.json' with { type: 'json' }` is recognized as a build error in phase 1 (deferred). In a later phase, inline the JSON as a frozen object bound to `x`. Pass-through is not an option because the output is a single ESM file and relative paths are eliminated by inlining.

### 4.2 Inlined externals — the shared-primitive pattern (`inline`)

The default rule (§4) makes anything outside `src/` *external* (preserved verbatim). But GCU composes **zero-dependency shared primitives by inlining them at build time, not depending on them at runtime**: `@gcu/over` inlines `@gcu/dimensions`, `@gcu/strata` inlines `@gcu/sift` (was `predicate.js`). The default rule would *break* these — it would leave the import as external and emit a single-file bundle that doesn't actually contain dimensions. So the bundler takes an explicit opt-in list:

```js
bundle({
  entry: 'src/main.js',
  inline: ['@gcu/dimensions'],        // resolve, bundle in, rename-dedup
});
```

Semantics:

- Each `inline` entry names a bare specifier (or an escaping-relative path) that would otherwise be external. The adapter resolves it to that package's `src/main.js` (bare `@gcu/x` → the workspace's `ext/x/src/main.js`; the resolution map is adapter-side, not baked into the core).
- The inlined package's modules join the bundle's module set and go through the **same rename-on-collision pass** (§6) as the host's own modules. So a shared primitive that collides with the host (or with another inlined primitive) is renamed deterministically — *the inline path is collision-safe by construction*, which is exactly the property the hand-rolled inlining lacked.
- Only the **names the host imports** from the inlined package are needed as bindings; the package's own unused exports are still emitted (no tree-shaking, §2) but contribute to collision detection.
- An inlined package's *own* `inline`/external deps are followed transitively (dimensions has none; in general, resolve recursively, deduping already-included modules).
- `inline` is the GCU answer to "how do shared primitives compose without a runtime dependency *or* a collision." It replaces the ad-hoc `externalDeps` hack in `ext/over/build.js` and the `'../../sift/src/predicate.js'` manifest entry in `ext/strata/build.js`.

This is **phase 2** (the per-package builds that need it — over, strata — are the ones being migrated then). Phase 1 packages have no inlines.

## 5. Annotations

Source-level comments the bundler honors. All annotations use the `bundle-` prefix and live in block comments immediately preceding a declaration.

### 5.1 `@bundle-share`

Marks a top-level binding as intentionally shared across modules. The binding is not renamed on collision. If two modules declare `@bundle-share` bindings with the same name, the bundler errors — shared-intent is a contract, not a coincidence.

```js
/* @bundle-share */
const REGISTRY = new Map();
```

Use case: module-global singletons (language registries, DOM id tables, sentinel values) where the alternative of putting the binding in its own file and importing it everywhere is more noise than signal.

### 5.2 `@bundle-verbatim`

Marks a declaration whose body should be emitted textually unchanged. The bundler still parses the declaration for scope analysis (the top-level binding still participates in collision detection) but does not rewrite identifiers within the body. Use case: hand-tuned regex literals, string contents that shouldn't be mangled, inlined vendor code.

```js
/* @bundle-verbatim */
function parseEscaped() {
  // contents emitted byte-for-byte
}
```

Rare. Include for the same reason `eslint-disable` exists: the escape hatch is cheaper than the alternative when you need it.

## 6. Rename algorithm

The rename pass operates in three passes over the module set (post-parse, post-scope-analysis).

### 6.1 Collect bindings

For each module, parse with acorn, call `@gcu/air`'s `analyzeModule(code, parser, allDefined)` to obtain `{defines, uses, air}`. The `defines` set (AIR's top-level name extraction) drives collision detection; the raw AST is kept alongside for the rewrite pass (§6.3). The `air` IR object is not used by the bundler — it's SSA-form for emission, not a rewrite surface.

For each top-level binding in `defines`, record `(name, module, isShared, source)` where `source` distinguishes locally-declared bindings from externally-imported ones (see §7.5). The import forms (`import { foo } ...`, `import * as ns ...`) are scanned directly on the AST at this stage, since AIR reports them as `uses` not `defines`.

Top-level bindings include:
- Locally-declared names: `let`, `const`, `function`, `class`.
- Imports from inlined modules: the imported identifier (or its `as`-alias) becomes a top-level binding of the importer, eliminated after rewriting (§7.1).
- Imports from external sources: the imported identifier (or its `as`-alias) becomes a top-level binding of the importer, preserved in the output (§7.5).

Inner scopes (function bodies, block scopes, class methods) do not contribute to this set. A `const REGISTRY` inside a function body in one module does not collide with a `@bundle-share` `REGISTRY` at the top level of another; at most it triggers `W001` (shadowing warning) if the enclosing file itself has a top-level `REGISTRY`.

### 6.2 Classify

For each name, consult the set of modules that declare it:

- **Zero or one module:** no rename, no further action.
- **Multiple modules, one or more `@bundle-share`:** if exactly one share and no others, that's an error (share must not collide with a non-shared declaration of the same name — the intent is ambiguous). If multiple `@bundle-share` declarations across modules, also error (shared-intent must be single-site).
- **Multiple modules, none shared:** collision. Every declaration is renamed to `name$moduleBasename` where `moduleBasename` is the source file's name without extension, sanitized to valid identifier characters.

Only-on-collision rename is chosen over always-rename because readable output is a design goal. The tradeoff: adding a new binding in one file can retroactively rename a binding in another file (a diff-noise effect, not a correctness risk). Mitigated by the fact that renames are deterministic from content — inspecting meta.json shows exactly what happened.

### 6.3 Rewrite

For each module's AST:

- Replace every declaration of a renamed binding with its new name.
- Replace every reference to a renamed binding with its new name (scope-aware — inner scopes that shadow the name are not touched).
- Replace imported references with the renamed target. `import { foo } from './x.js'` where `x.js`'s `foo` was renamed to `foo$x` rewrites references to `foo` in the importer to `foo$x`.
- Strip the `import` statement itself (the reference is now direct).
- `import * as ns from './x.js'` (§7.3) is handled separately.

**Scope tracker:** the rewrite pass needs to distinguish top-level references from inner-scope shadows, which AIR does not expose on the AST. A lightweight scope walker lives in `scope.js` (~60–80 LOC): walks the AST pushing/popping scopes at function, block, catch, and class boundaries; collects declared names per scope (`let`/`const`/`function`/`class`/params/catch-binding/class-name). For each `Identifier` reference, scope-lookup determines whether it resolves to the module's top-level binding or a nested declaration. Only top-level resolutions get renamed. This walker is orthogonal to AIR — AIR's internal scope tracking is tuned for SSA lowering, not for identifier-reference rewriting against original AST positions.

### 6.4 Emit strategy: text-splice over original source

Chosen: **text-splice**, not AST re-serialization.

The bundler keeps the original source text of each module and emits by concatenating slices of it, with targeted overwrites at the byte ranges of renamed identifiers and stripped import statements. Acorn's `ranges: true` gives each AST node a `[start, end]` byte offset pair; rewriting is a matter of collecting a sorted list of `{start, end, replacement}` patches per module and walking both lists in tandem during emit.

Why this over re-serialization:

- **Comment preservation is free.** Comments, whitespace, formatting, string escapes — all preserved byte-for-byte because the emitter is mostly copying the source as-is. A re-serializer has to re-emit comments (acorn doesn't attach them to nodes by default) and tends to normalize whitespace, breaking `@bundle-verbatim` semantics (§5.2) without extra work.
- **Source maps are simpler.** Output positions track input positions almost 1:1, deviating only at patch boundaries. VLQ mappings become a straightforward walk over the patch list plus module boundaries.
- **Smaller implementation.** No AST→string serializer, no formatter, no whitespace normalizer. `emit.js` becomes ~80 LOC of patch-application and position-tracking, instead of ~300+ for a full serializer.

The cost is that AST-level transforms limited to identifier renames and statement removal cover every case in the spec. If a future feature ever needs to synthesize new syntax (e.g. an inserted `const` declaration that wasn't in any source), we emit a freshly-authored string at the appropriate module boundary and record no source-map entry for it — same as the synthesized namespace objects in §7.3. This is a narrow enough case that it doesn't pull in a serializer.

Implementation contract: `emit.js` exports `applyPatches(source, patches) → { code, offsetMap }` where `offsetMap` lets `sourcemap.js` translate any input position to its corresponding output position for mapping generation. Patches are validated to be non-overlapping and in-order before emission.

### 6.5 Pseudocode

```
function bundle(entry):
    modules = walkManifest(entry)
    for module in modules:
        module.ast = parse(module.source)
        module.bindings = collectTopLevelBindings(module.ast)
        module.annotations = collectBundleAnnotations(module.ast)

    renames = {}                          # (module, originalName) -> newName
    sharedOwners = {}                     # name -> module
    bindingsByName = groupBy(allBindings, b -> b.name)

    for name, group in bindingsByName:
        sharedInGroup = [b for b in group if b.isShared]
        if len(sharedInGroup) > 1:
            error("`" + name + "` marked @bundle-share in multiple modules")
        if len(sharedInGroup) == 1 and len(group) > 1:
            error("`" + name + "` is @bundle-share but also declared elsewhere")
        if len(sharedInGroup) == 1:
            sharedOwners[name] = sharedInGroup[0].module
        elif len(group) > 1:
            for binding in group:
                newName = name + "$" + moduleBasename(binding.module)
                renames[(binding.module, name)] = newName

    for module in modules:
        rewriteBindings(module.ast, renames)
        rewriteImports(module.ast, renames, modules)

    return emit(modules, renames, sharedOwners)
```

### 6.6 `renameCollisions` as a reusable pass

The collect → classify → rewrite passes (§6.1–6.3) are exported as a standalone function, not buried inside `bundleModules`:

```js
renameCollisions(modules) → { modules, renames, warnings }
//   modules: [{ path, source, ast, bindings }]  (already parsed)
```

It takes an ordered set of parsed modules, detects top-level name collisions across them, renames on collision (`$basename` suffix), and returns the rewritten modules plus the rename log. `bundleModules` is its primary caller — but it has a *second* caller (§6.7) that the bundler proper never sees, which is why this is a public pass and not a private helper.

### 6.7 Merge mode — bundling pre-built bundles (the surface-inliner case)

Everything above operates on a package's **source** modules. But Auditable has a *second*, structurally identical collision site: the Works surface inliner (`_inlineLibsIntoSurface`) raw-concatenates several **already-built `index.js` bundles** (over + loom + strata + recon + archive) into one iframe scope. Two independently-clean packages can still both *export* `inferType` (over + loom did), and flat-concatenation collides them — caught only at surface load.

This is the same problem one level up, and it takes the same pass. **Merge mode** is `renameCollisions` (§6.6) applied to pre-built bundles:

```js
mergeBundles(bundles, opts) → { code, renames, warnings }
//   bundles: [{ name, source }]   each an already-built index.js (export-bearing ESM)
//   opts:    { entryImports }     the bare @gcu/<name> imports the surface actually makes
```

Behavior:

- Parse each bundle, collect its top-level bindings (its public exports *and* its internal top-level names — both share the flat scope after the inliner strips `export`).
- Run `renameCollisions` across the whole set. Colliding names (whether public or internal) get the `$name` suffix.
- Rewrite the surface's `import { X } from '@gcu/<name>'` consume sites to the (possibly renamed) binding, strip the import, and emit the bundles' bodies in order followed by the consume code — exactly what the inliner does today, but **collision-safe**.

Merge mode is what lets the Works inliner stop being a footgun: it becomes a `@gcu/build` consumer instead of a hand-rolled `export → const` text substitution. It is **phase 2** (the inliner migrates after the per-package builds do), and it is the reason §6.6 is a separate export.

**Note on `@bundle-share` across merge:** shared-intent (§5.1) is *per-package*; two packages each legitimately owning a `REGISTRY` is not a shared contract, it's a collision — so in merge mode `@bundle-share` annotations are ignored (they were already resolved inside each package's own build) and everything is name-by-name.

## 7. Import / export rewriting

### 7.1 Named imports

`import { foo, bar as baz } from './x.js'`:

- Delete the statement from the output.
- Every reference to `foo` in the importer becomes the renamed-or-original name of `x.js`'s `foo`.
- Every reference to `baz` becomes the renamed-or-original name of `x.js`'s `bar`.

### 7.2 Side-effect imports

`import './x.js'`:

- Delete the statement. The module is already in the bundle; its top-level code runs in manifest order.

### 7.3 Namespace imports

`import * as ns from './x.js'`:

- The namespace object must be synthesized at bundle time. Emit a synthetic object near the module boundary:
  ```js
  const ns = Object.freeze({ foo: foo$x, bar: bar$x /* all of x.js's exports */ });
  ```
- `ns.foo` references in the importer resolve normally through the synthesized object.
- Frozen to match ESM namespace object semantics (immutable, live bindings emulated by property access on the renamed identifiers).
- Synthesized names (`ns` above) participate in collision detection along with user-authored bindings.

### 7.4 Named re-exports

`export { foo } from './x.js'` and `export { foo as bar } from './x.js'`:

- Contribute to the final export block.
- Emit nothing in the module body.
- The exported name in the public surface is `foo` (or `bar` for the aliased form); the internal binding it refers to is `foo$x` if renamed.

### 7.5 External import bindings

External imports (bare specifiers like `acorn`, `@gcu/air`, and relative imports that escape `src/`) introduce top-level bindings into the module that imports them, exactly like inlined-module imports. They participate in collision detection (§6.1) and are renamed on collision under the same rules.

Collapsing: if multiple modules import the **same binding from the same external source** (`import { Parser } from 'acorn'` in both `a.js` and `b.js`), the bundler emits a single `import { Parser } from 'acorn'` at the top of the output. No rename needed — the binding refers to the same external symbol everywhere.

Collision: if multiple modules import the **same identifier from different external sources** (`import { Parser } from 'acorn'` in `a.js` and `import { Parser } from '@gcu/sql-parser'` in `b.js`), it's a collision. The bundler renames using the same `$moduleBasename` rule, producing two separate imports at the top of the output:

```js
import { Parser as Parser$a } from 'acorn';
import { Parser as Parser$b } from '@gcu/sql-parser';
```

References within each module are rewritten accordingly.

Aliased imports are normalized before collision detection: `import { Parser as P } from 'acorn'` contributes the top-level name `P`, not `Parser`.

### 7.6 Wildcard re-exports

`export * from './x.js'`:

- Enumerate `x.js`'s named exports (excluding `default`, which doesn't exist in GCU sources).
- Add each to the final export block under its source name.
- Collision across multiple `export *` declarations: per ESM spec, ambiguous re-exports become non-exports, not errors, unless accessed. The bundler emits a warning for each ambiguous re-export and omits the name from the export block.

### 7.7 Final export block

Emitted at the bottom of `index.js`:

```js
export {
  name1,
  name2,
  rename1$mod as externalName1,
  // ...
};
```

Order: **manifest order** (the order in which the names first appeared in `src/main.js`'s export declarations, then any `export *` contributions in the order the source modules were visited). Manifest order over alphabetical because it preserves authorial intent in the output; it's what the author is most recently thinking about.

## 8. Comments

All comments from source are preserved in output. No stripping, no filtering. Rationale: GCU's output is readable-by-design; JSDoc annotations survive into the bundle; license and attribution comments are preserved automatically without a special case.

The bundler **adds** two kinds of comment content:

- **File header** at top of `index.js`:
  ```
  // ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/<pkg>/src/  Build: npx @gcu/build src/main.js
  // <package-name> — <package-description from package.json if available>
  ```
- **Section markers** between modules:
  ```
  // ── src/parse.js ──
  ```

Comment preservation is exact: position relative to the declaration it belongs to is maintained, and source-map mappings point at original comment locations. When a declaration is moved, renamed, or rewritten, any preceding block comment moves with it.

## 9. Lint rules

The bundler enforces a small set of rules at parse time, at zero additional implementation cost given the AST is already walked. These are not style rules; they protect the bundler's assumptions or catch bugs that flat-scope concatenation would turn silent.

Errors (build fails):

- **No `var` declarations.** `let` or `const` only.
- **No `with` statements.**
- **No `eval` calls or references.**
- **No implicit globals.** Assignment to an undeclared identifier is an error. Catches typos like `regsitry = new Map()`.
- **No `arguments` in arrow functions.** (Already a syntax error; the bundler's message is more helpful than V8's.)
- **No `import()` expressions.**
- **No `export default`.**
- **No relative imports escaping `src/`** (prevents accidental coupling to sibling ext/* or repo layout).
- **No `@bundle-share` name colliding with a non-shared declaration of the same name.**
- **No `@bundle-share` declared in multiple modules.**

Warnings (logged, not fatal):

- **Shadowing of top-level bindings by inner scopes.** Inner function declares `function tokenize()` when the enclosing file's top level also has `function tokenize()`. Usually refactor residue.
- **Ambiguous `export *` re-exports.** As per §7.6.

Lint output uses the standard error format (§12).

## 10. Define substitution

Optional feature. The bundler accepts a `define` option mapping identifier names to literal expressions:

```js
bundle({
  entry: 'src/main.js',
  define: {
    __VERSION__: JSON.stringify('0.3.1'),
    __GCU_BUILD_HASH__: JSON.stringify(gitShortSha()),
  },
});
```

Substitution happens at the AST level on `Identifier` nodes whose name matches a key, only in expression position. Identifiers inside strings, comments, property keys, or as declaration names are not substituted. This matches esbuild's `define` semantics.

Keys must follow the `__NAME__` convention (leading and trailing double-underscore, uppercase with underscores between). The bundler rejects keys that don't match, because non-conventional names (`VERSION`, `pi`) would be too easy to collide accidentally with user code.

Values must be strings containing valid JavaScript literal expressions — `JSON.stringify("0.3.1")`, `"42"`, `"true"`. They are parsed and inserted as AST nodes, not text-substituted.

Bindings produced by `define` participate in collision detection: if user code already declares a top-level `__VERSION__`, that's an error regardless of whether `define` is set.

## 11. Source maps

Source Map v3 format, always emitted unless suppressed. A `.map` file is written alongside `index.js`, and a `//# sourceMappingURL=index.js.map` comment is appended to `index.js`.

Suppress with `sourcemap: false` in the library API or `--no-sourcemap` on the CLI.

### 11.1 Fields

- `version`: 3
- `sources`: relative paths to original source files, in manifest order
- `sourcesContent`: full text of each source, inlined. Always included — consumers get working stack traces without needing the original files, and the size cost is negligible for our scale.
- `mappings`: VLQ-base64 encoded segments, one per meaningful position
- `names`: **omitted**. Scope-panel name mapping is devtools-only functionality; line/column is ~90% of the debugging value. Add later if someone asks.
- `file`: `index.js`

### 11.2 Mapping density

Segments are emitted at patch boundaries and module boundaries, not per AST node (see §11.3 and §6.4). Between boundaries, positions are recoverable by linear offset because the output is a verbatim copy of the input. This gives stack-trace-accurate mappings with far fewer segments than per-node emission.

### 11.3 Position tracking

Given text-splice emit (§6.4), mappings fall out of the patch walk:

- Between patches: output is a verbatim slice of input. A single mapping at each slice boundary is enough; positions within the slice are recoverable by linear offset from the boundary.
- At patches: record a mapping from the patch's output position to `node.loc.start` of the AST node that produced the patch (the renamed identifier, the stripped import, etc.).
- At module boundaries: record a mapping to `(source_index, line 1, column 0)` of the next module.
- Synthesized output (namespace objects §7.3, final export block §7.7, file header, section markers) has no source-map entry. The map skips those output ranges — stack traces there point at the bundler itself, which is correct.

This produces a map with O(patches + modules) segments rather than O(AST nodes), which is smaller and equally useful for stack traces.

## 12. Meta output

A sidecar `index.meta.json` written alongside `index.js`. Always emitted unless suppressed (`meta: false` / `--no-meta`).

Shape:

```json
{
  "entry": "src/main.js",
  "package": "@gcu/adder",
  "version": "0.3.1",
  "modules": [
    {
      "path": "src/parse.js",
      "bytes": 3421,
      "lines": 142,
      "exports": ["tokenize", "parseModule"]
    }
  ],
  "renames": [
    {
      "original": "lowerExpr",
      "renamed": "lowerExpr$adder",
      "module": "src/adder.js",
      "reason": "collision",
      "collidingModules": ["src/adder.js", "src/soft.js", "src/calque.js"]
    }
  ],
  "shared": [
    { "name": "REGISTRY", "module": "src/registry.js" }
  ],
  "exports": ["adder"],
  "warnings": [],
  "bundleSize": 84231,
  "bundleHash": "sha256-..."
}
```

`bundleHash` is a hash of the emitted `index.js` content, for cache-busting and change detection.

Field names are stable; new fields may be added, existing fields do not change shape. Consumers that parse meta.json can rely on this.

## 13. API

### 13.1 Library (primary)

The public surface is layered to match §1.4 (pure core → adapters):

```js
import {
  bundle,            // node-fs adapter: read manifest, bundle, WRITE outputs
  bundleModules,     // PURE core: { [path]: source } → BundleResult (no I/O)
  mergeBundles,      // pure: merge pre-built bundles, collision-safe (§6.7)
  renameCollisions,  // pure pass: the rename algorithm alone (§6.6)
} from '@gcu/build';
```

The **node-fs adapter** (the everyday entry):

```js
await bundle({
  entry: 'src/main.js',          // required
  outDir: '.',                   // default: directory of entry's parent
  outFile: 'index.js',           // default: 'index.js'
  sourcemap: true,               // default: true
  meta: true,                    // default: true
  inline: ['@gcu/dimensions'],   // optional — externals to inline (§4.2)
  define: { __VERSION__: '"1.0"' },  // optional (§10)
  header: '// Custom header',    // optional — replaces default header
});
```

The **pure core** (the load-bearing contract — what a VFS/memory adapter calls):

```js
const result = bundleModules(sources, {
  entry: 'src/main.js',
  inline: ['@gcu/dimensions'],   // already resolved INTO `sources` by the adapter
  sourcemap: true,
});
// sources: { 'src/main.js': '…', 'src/parse.js': '…', /* + inlined pkg's modules */ }
```

`bundleModules` performs **no I/O whatsoever** — the adapter has already read every module (host's + inlined) into `sources`. It is the function that runs unchanged in node, in a `@gcu/vfs`-backed Works build, and in tests. Both `bundle()` and `bundleModules()` return a `BundleResult`:

```ts
{
  code: string,
  map: object,         // source map v3, not stringified (null if sourcemap: false)
  meta: object,        // index.meta.json shape (§12)
  warnings: Warning[], // emitted warnings
}
```

`bundle()` writes `code`/`map`/`meta` to disk as a side effect; `bundleModules()` writes nothing. The earlier `bundleToString` name is folded into `bundleModules` — there is one pure entry, not two.

### 13.2 CLI

Available as a `bin` entry in `package.json` when `@gcu/build` is published. Usage:

```
gcu-build [options] <entry>
npx @gcu/build [options] <entry>
```

Options:

```
--out-dir <dir>         default: directory of entry's parent (so src/main.js -> ./index.js)
--out-file <name>       default: index.js
--no-sourcemap          suppress source map emission
--no-meta               suppress meta.json emission
--define <KEY=VALUE>    repeatable; value is parsed as JSON
--inline <pkg>          repeatable; an external to inline into the bundle (§4.2)
--check                 reproducibility / DRIFT check: rebuild from src, assert the
                        committed index.js matches byte-for-byte; exit nonzero on drift
                        OR on any bundling error. Makes "every committed bundle is
                        reproducible from its source" an enforced CI invariant — catches
                        stale bundles (forgot to rebuild) and hand-edits to generated
                        files, the failure modes a hand-written build.js can't self-detect
--stdout                emit code to stdout, no disk writes; implies --no-sourcemap --no-meta
--workspace <glob>      bundle every dir matching glob whose src/main.js exists; skips a
                        package whose source hashes are unchanged (incremental, via §12's
                        bundleHash) — meaningful for the ~20-package monorepo and essential
                        for a browser save-rebuild loop
--quiet                 suppress non-error output
--help
--version
```

The CLI is a thin wrapper over the library. The library is the load-bearing contract: `bin` can be removed and every existing `build.js` keeps working; the CLI can be changed or extended freely without breaking library consumers.

`--stdout` is the CLI mirror of `bundleToString()` — code only, no sidecars. Intended for piping (`gcu-build --stdout src/main.js | node`), determinism checks, and ad-hoc tooling. If a user wants sidecars *and* code on stdout, they should call `bundleToString()` from a script; the CLI doesn't complicate itself for that edge.

### 13.3 Per-package `build.js`

Each `ext/<pkg>/build.js` becomes, ideally, a three-line file:

```js
#!/usr/bin/env node
import { bundle } from '@gcu/build';
await bundle({ entry: 'src/main.js' });
```

The existing convention of `node ext/<pkg>/build.js` continues to work. Packages may pass package-specific options (`define`, custom header, etc.) here.

## 14. Output format

### 14.1 Structure

```
// ⚠ GENERATED FILE — DO NOT EDIT. Source: <dir>  Build: npx @gcu/build <entry>
// @gcu/<pkg> — <description>

// ── src/<first-module>.js ──

<module body, rewritten>

// ── src/<next-module>.js ──

<module body, rewritten>

// ...

export {
  name1,
  renamed$mod as external,
  // ...
};

//# sourceMappingURL=index.js.map
```

### 14.2 Determinism

Two identical inputs produce byte-identical output. Sources of nondeterminism to avoid:

- **No timestamps** in headers or anywhere else.
- **Manifest-ordered iteration** throughout — never filesystem-order, never Map-insertion-order dependent on async resolution.
- **Stable rename suffixes** — always `$moduleBasename`, deterministic from file name alone.
- **Export block in manifest order** (§7.7).
- **Meta.json key order** specified: top-level keys in the order declared in §12; array elements in manifest order; object keys within array elements in declaration order.
- **`sourcesContent` in `sources` order**, never sorted or deduplicated.

Regression test: `diff <(gcu-build --stdout src/main.js) <(gcu-build --stdout src/main.js)` produces no output. (The `--stdout` flag, §13.2, suppresses sidecars and writes code to stdout, making this a one-liner.) Included as part of the synthetic fixture test suite.

## 15. Error format

All errors and warnings use the format:

```
gcu-build: <severity> <code>: <message>
  at <file>:<line>:<col>
  <suggestion, if any>
```

Where `<severity>` is `error` or `warning`, and `<code>` is a stable short identifier (e.g. `E001`, `W003`). Codes are not renumbered; new codes get new numbers.

Example:

```
gcu-build: error E007: `lowerExpr` declared at top level in multiple modules
  at src/soft.js:42:9
  also declared at src/adder.js:8:9, src/calque.js:15:9
  suggestion: mark one as /* @bundle-share */ if intentionally shared, or allow automatic renaming (no action needed in that case — this error only fires if automatic rename would produce an ambiguous name)
```

Error codes in use (expandable):

- `E001`: parse error (propagated from acorn with position adjusted)
- `E002`: relative import escapes `src/`
- `E003`: extension-less import
- `E004`: directory-index import (`./foo` meaning `./foo/index.js`)
- `E005`: `export default` in sources
- `E006`: dynamic `import()` in sources
- `E007`: unresolvable collision (shared + non-shared, or multiple shared)
- `E008`: `@bundle-share` annotation on non-top-level declaration
- `E009`: implicit global assignment
- `E010`: `var` declaration
- `E011`: `with` statement
- `E012`: `eval` reference
- `E013`: circular import detected
- `E014`: top-level code in module depends on binding from later module (manifest-order violation)
- `E015`: malformed `define` key (not `__NAME__` convention)
- `E016`: malformed `define` value (not a valid literal expression)

Warnings:

- `W001`: top-level binding shadowed by inner scope declaration
- `W002`: ambiguous `export *` re-export
- `W003`: `import` attribute (`with { type: 'json' }`) not yet supported in this phase

## 16. Test structure

Three layers:

### 16.1 Synthetic fixture suite

A checked-in directory `tests/fixtures/` containing small (~5 file) synthetic packages. Fixtures split into two kinds by how they verify:

**Semantic fixtures** (no goldens): run the bundler, import the bundled module, assert behavior. Structural and behavioral features go here, because they're what actually matters. Emit-layer formatting changes don't churn these.

- `01-basic/`: single module, named exports — asserts exports match
- `02-collision/`: two modules with colliding top-level name — asserts both exports resolve to the correct renamed binding and their values are distinguishable
- `03-shared/`: `@bundle-share` binding — asserts the shared binding is a single object identity across importers
- `03b-shared-inner-shadow/`: `@bundle-share REGISTRY` at top level, another module declares `const REGISTRY` inside a function body — asserts: no error, `W001` not raised (inner scope doesn't count), shared binding's identity preserved
- `04-reexport/`: `export { foo } from './x.js'`, aliased re-export, wildcard re-export — asserts export surface
- `05-namespace-import/`: `import * as ns from './x.js'` — asserts `ns.foo` resolves and object is frozen
- `06-tla/`: top-level await passes through — asserts awaited value reaches exports
- `07-external-collision/`: `import { Parser } from 'acorn'` and `import { Parser } from '@gcu/sql-parser'` in two modules — asserts both imports appear in output, renamed, and both references resolve
- `09-define/`: `__VERSION__` substitution — asserts the literal shows up at the right positions and not inside strings
- `10-verbatim/`: `@bundle-verbatim` function body — asserts the body text is preserved byte-for-byte (inspected via `toString()` on the bundled function)
- `11-lint/`: each lint rule, catch each error code — asserts bundler throws the expected `E0xx` / `W0xx` code
- `12-inline/`: a host package + an inlined "primitive" package that declares a name *also* declared in the host (§4.2) — asserts the primitive is inlined (no surviving import), the collision is renamed, and both bindings resolve to their correct values
- `13-merge/`: two pre-built bundles each exporting `inferType` with different bodies (§6.7) — asserts `mergeBundles` renames both, the surface's consume sites resolve to the right one, and no top-level redeclaration survives. The regression test for the real over×loom collision.

**Golden fixtures** (output compared to checked-in `expected/`): only for things where the *shape* of the output file is the contract, not its behavior. Small set, kept stable on purpose.

- `G1-shape/`: header format, section markers between modules, final export block structure — the canonical "what the output looks like" fixture
- `G2-determinism/`: runs the bundler twice via `--stdout`, diffs output — no `expected/`, just asserts byte-identical
- `G3-comments/`: JSDoc, license block (`/*! ... */`), inline comments — asserts each is preserved at the correct position
- `G4-sourcemap/`: small bundle with source map — asserts the map decodes to correct source positions for a fixed set of output locations

Rationale for the split: goldens are expensive to maintain (any whitespace change churns every file), but irreplaceable for format-shape contracts. Semantic tests scale linearly with features without adding maintenance cost. The 4-vs-11 ratio reflects that most bundler contracts are behavioral, not textual.

### 16.2 Round-trip suite against real `ext/*`

For each shipped `ext/<pkg>/`:

- Import `src/main.js` and `index.js` as ES modules.
- Assert `Object.keys(srcExports).sort() === Object.keys(bundledExports).sort()`.
- Invoke a small fixed set of exported functions on fixed inputs; assert equal outputs.

No golden files. Purely semantic check that the bundled version behaves like the source. When an ext/* adds a new export, the test must be updated with the new name, but that update is trivial (one line in the per-package test fixture listing expected exports).

### 16.3 Self-hosting check

`@gcu/build` bundles itself. The bundled version bundles `ext/adder/`. The output matches what the unbundled `@gcu/build` produces on the same input. One test case, catches a wide class of regressions.

## 17. Module layout

Lives at `ext/build/`, following the convention that any package with `src/main.js` → `index.js` lives under `ext/`.

```
ext/build/
  package.json
  cli.js                 # CLI entry, `bin` target (thin wrapper over src/main.js)
  build.js               # self-bundler: runs @gcu/build against its own src/
  src/
    main.js              # library entry; re-exports the public surface (§13.1)
    core.js              # bundleModules(sources, opts) — the PURE core (no I/O) (§1.4)
    merge.js             # mergeBundles(bundles, opts) — merge mode (§6.7)
    parse.js             # acorn wrappers, comment attachment
    manifest.js          # walk imports transitively → ordered module list (ADAPTER-side: reads files)
    resolve.js           # bare/inline specifier → source path (adapter-side; §4.2 inline)
    scope.js             # AST scope walker for rewrite pass (§6.3); AIR integration helpers
    annotations.js       # extract @bundle-share and @bundle-verbatim from comments
    rename.js            # renameCollisions() — the three-pass rename algorithm (§6, §6.6)
    rewrite.js           # patch generation: identifier renames, import/export stripping
    emit.js              # apply sorted patches to original source; build offset map (§6.4)
    sourcemap.js         # VLQ encoding, segment building, v3 map construction from offset map
    meta.js              # meta.json construction
    lint.js              # lint rules (§9)
    define.js            # define substitution (§10)
    errors.js            # error codes, formatting, throw helpers
    io/
      node.js            # node-fs adapter: bundle() — reads src/, writes outputs
      vfs.js             # @gcu/vfs adapter: build inside Works / geas (browser)
      memory.js          # in-memory adapter: { [path]: source } → result (tests)
  tests/
    fixtures/            # §16.1
    roundtrip/           # §16.2
    self-host/           # §16.3
    run.js               # test runner (node:test or a minimal custom one)
  index.js               # bundled output (generated by ext/build/build.js)
  index.js.map
  index.meta.json
```

Vendored dependencies:

```
ext/acorn/               # already present, shared across GCU tooling
ext/air/                 # already present, scope analysis
```

`@gcu/build` imports from both as bare specifiers. The bundler's own `index.js` (after self-hosting) treats these as external, so consumers resolve them through their own dependency tree.

### 17.1 Bootstrap

`@gcu/build` bundles itself, which raises the chicken-and-egg question of where the first `index.js` comes from. Resolution:

- **Before first bundle exists:** `ext/build/build.js` runs the unbundled source directly via `node --experimental-vm-modules` or, more simply, by importing `./src/main.js` as an ES module and calling `bundle()` on its own manifest. Node handles inlined relative ES modules natively, so no wrapper tooling is required to run the source tree.
- **After first bundle exists:** `ext/build/build.js` can switch to importing `./index.js` for faster startup, but this is optional — running from source stays correct. Most ext-repo build scripts already pay ~50ms of startup; re-bundling the bundler is not a hot path.
- **CI safety net:** the self-hosting test (§16.3) runs both modes (from-source and from-bundle) and asserts identical output. Any drift is caught immediately.

New implementers: start in from-source mode. Only switch to from-bundle after the test suite goes green end-to-end.

## 18. Phased implementation

### Phase 1 — Core bundling

**Goal:** bundle a real `ext/<pkg>/` and produce byte-identical exports to the current hand-written `build.js` output (modulo formatting differences).

**Scope:**
- Manifest walking (§3)
- Relative import resolution, extensions required (§4)
- Collision detection and rename (§6)
- Named imports and side-effect imports rewriting (§7.1, §7.2)
- Named re-exports only (§7.4) — namespace imports and `export *` deferred
- Default-export ban enforced (§3.2)
- Basic errors: parse, resolve, collision (§15)
- Comment preservation (§8)
- Section markers and file header (§8)
- Final export block (§7.7)
- **The pure-core / adapter split (§1.4) from day one**: `bundleModules()` (pure, no I/O)
  + the node-fs adapter `bundle()`. The split is foundational, not a later refactor.
- Synthetic fixture tests for phase-1 features (§16.1) — use the **memory adapter**, no temp dirs
- Round-trip test against `ext/adder` (§16.2)

**Out:**
- Source maps
- Meta.json
- Lint rules
- Define substitution
- Namespace imports (`import * as`)
- Wildcard re-exports (`export *`)
- Annotations (`@bundle-share`, `@bundle-verbatim`)
- CLI
- TS annotation elision

**LOC estimate:** ~200.

**Exit criterion:** `ext/build/src/main.js`'s `bundle()` can replace `ext/adder/build.js`'s concat pipeline, and round-trip tests pass.

### Phase 2 — Production bundling

**Goal:** `@gcu/build` replaces every existing `ext/<pkg>/build.js` across the repo.

**Scope:**
- Source map emission (§11), with `--no-sourcemap` flag
- Meta.json emission (§12), with `--no-meta` flag
- Namespace imports (§7.3)
- Wildcard re-exports (§7.6)
- Annotations: `@bundle-share`, `@bundle-verbatim` (§5)
- **Inlined externals — the `inline` option (§4.2)** — replaces over's `externalDeps`
  hack + strata's escaping-relative manifest entry. The first real migrations (over,
  strata) need it, so it lands here, not in phase 3.
- **Merge mode — `mergeBundles` (§6.7)** + migrating the Works surface inliner
  (`_inlineLibsIntoSurface`) to use it. This is what fixes the *inter-bundle* collision
  class (over×loom `inferType`) at its root.
- **The `@gcu/vfs` adapter (§1.4)** — building inside Works / geas, in-browser. With
  this, `bundleModules` runs unchanged over the workspace VFS; geas gets a `gcu-build`
  builtin. (The core is already browser-native from phase 1; this is just the adapter.)
- **Reproducibility / drift `--check` (§13.2)** wired into CI — every committed `index.js`
  reproducible from source.
- **TS annotation elision** — cheap, because `acorn-typescript` is *already vendored*
  (air parses `: i32` hints with it). Elision = "don't emit the annotation nodes";
  no new parser, no type-aware transform (still §2-compliant). Lands here, not deferred.
- Lint rules (§9), all errors and warnings
- Define substitution (§10)
- CLI (§13.2) with `bin` entry
- All error codes (§15)
- Full synthetic fixture suite (§16.1)
- Round-trip tests for every `ext/<pkg>/` (§16.2)
- Self-hosting check (§16.3)
- Determinism regression test

**LOC estimate:** ~400–500 cumulative (phase 1 + phase 2 combined).

**Exit criterion:** every `ext/<pkg>/build.js` is a three-line wrapper around `bundle()`. CI runs the full test suite. `@gcu/build` is publishable.

### Phase 3 — Comfort features

**Goal:** quality-of-life additions, none blocking.

**Scope (pick as needed):**
- (TS elision and the drift `--check` moved up to phase 2 — see above.)
- Import attributes inlining (`import json from './x.json' with { type: 'json' }`)
- `--workspace <glob>` incremental bulk rebuilds with `bundleHash` skip (§12, §13.2)
- Manifest-order violation detection (`E014`) — requires extra top-level code flow analysis
- Improved error suggestions using AIR's scope info (e.g. "did you mean `<similarly-named binding>`")
- A geas `gcu-build` builtin + Works "Build package" affordance on top of the §1.4 VFS adapter

**Out (still):**
- Plugins, configs, minification, chunking, watch mode, HMR — these are separate tools or explicit non-goals.

**LOC estimate:** +100–200 depending on which features land.

### Phase 4 — Ecosystem

**Goal:** `@gcu/build` is usable by external authors building GCU-style extensions or unrelated flat-bundle libraries.

**Scope:**
- Published to npm as `@gcu/build`
- Documentation site or README-driven docs
- `npx @gcu/build` usage documented
- Blog post or GCU-PRESS entry explaining the constraints and the why
- Integration notes for downstream consumers (pyskit, etc.) that still want esbuild for node_modules resolution — document the layering

Not implementation work. Organizational.

## 19. Open questions for later

Flagged here so they don't get lost but don't need resolution to begin implementation:

- If TS annotation elision lands in phase 3, does it also imply JSDoc preservation semantics change (since annotations become code positions)? Probably not, but verify with a fixture.
- Should the bundler enforce a maximum module count or bundle size? Currently no. A warning threshold might be useful.
- Should warnings be promotable to errors via an option? Similar to `--warnings-as-errors`. Probably phase 3.
- Workshop use case (`GCU-CERT-101` or future `GCU-BUILD-101`): does the tool need a `--verbose` mode that narrates its passes for pedagogy? Cheap to add; defer until asked.

## 20. Summary of decisions

For quick reference and in case Claude Code or a future reviewer wants the decisions without the rationale:

- **Architecture: a pure I/O-free core (`bundleModules`) + thin adapters (node-fs, @gcu/vfs, memory). Browser-native by construction — the core touches no `fs`, acorn+air already run in the browser. This is the keystone; everything else is plumbing.**
- **Big idea: the self-hosting build layer of an owned stack — builds itself, runs in the browser on the GCU platform, rebuildable from source forever. "Owned and legible all the way down" made true at the bottom.**
- **Inlined externals (`inline` option): GCU shares zero-dep primitives by inlining at build (dimensions→over, sift→strata), collision-safe via the same rename pass. Not a runtime dep.**
- **Two collision sites, one pass: per-package (intra-bundle) AND the Works surface inliner (inter-bundle, over×loom). `renameCollisions` is a public pass; `mergeBundles` (merge mode) applies it to pre-built bundles so the inliner stops being a footgun.**
- **Drift `--check`: every committed `index.js` reproducible from source; a CI invariant. Import-graph manifest (not a hand list) structurally prevents the "forgot a file" bug.**
- **TS annotation elision: in (phase 2), cheap — acorn-typescript is already vendored. Elision only, no type-aware transform (still §2-compliant).**
- Rename: only on collision, `$moduleBasename` suffix, deterministic
- Annotations: `@bundle-share`, `@bundle-verbatim`, block-comment form
- Default exports: banned, build error
- Dynamic imports: banned, build error
- Top-level await: allowed, no special handling needed
- Manifest: `src/main.js`, no separate format
- Resolution: relative inside `src/` inlined, everything else external
- Output: single ESM file, preserved comments, section markers, `index.js.map` + `index.meta.json` sidecars by default
- Export block: manifest order
- Source maps: v3 with `sourcesContent`, no `names` field
- Lint rules: enforced at parse, see §9
- Define: `__NAME__`-convention keys, expression-context-only substitution
- API: library primary, CLI secondary, both present at phase 2
- Tests: synthetic fixtures + real-package round-trip + self-hosting
- Non-goals: plugins, configs, node_modules resolution, polyfills, minification, chunking, CSS/asset, browser-field, HMR, tree-shaking, CJS/UMD
- Determinism: byte-identical output from identical input, explicitly tested
- Target core LOC: ~400–500 after phase 2

## 21. AIR prerequisites

> **Shipped.** §21.1–21.4 landed in `@gcu/air 0.3.0`, AND the self-host step is done: `ext/air/build.js`
> now emits an `export { … }` footer so the air *bundle* (`ext/air/index.js`) carries its public API.
> `core.js` + `merge.js` import `parseModule`/`extractImports`/`extractExports` from `../../air/index.js`
> (the built artifact) instead of reaching into `../../air/src/api.js` — @gcu/build consumes air as a
> proper package. (The bundle's browser-init stays `window`-guarded, so it imports cleanly in node.)

Four small additions to `@gcu/air`'s public API land alongside or before `@gcu/build` v1. They are independently useful (other consumers benefit), bounded (~30 LOC total in `ext/air/src/api.js`), and feed AIR's existing domain — AIR already parses and walks ASTs; these just expose more of what it already does.

Ship as `@gcu/air 0.3.0`. None are breaking changes.

### 21.1 Return the AST from `analyzeModule`

Today `analyzeModule(code, parser, allDefined)` returns `{defines, uses, air}`. Add `ast` to the return shape:

```js
return { defines, uses, air: module, ast };
```

Rationale: `analyzeModule` already parses internally. The bundler would otherwise re-parse to get its own AST for the rewrite pass. Returning the existing AST saves one parse per module (~20 modules per ext/* package × ~50 packages in the long tail = real savings). Cost: zero new code, one extra field in the return object.

### 21.2 Enable `ranges: true` on acorn parse

Update the `parser.parse(code, {...})` call in `analyzeModule` and `extractDefines` to include `ranges: true`:

```js
const ast = parser.parse(code, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  locations: true,
  ranges: true,          // NEW
});
```

Rationale: byte-offset `[start, end]` pairs on every AST node are free at parse time. The bundler needs them for text-splice emit (§6.4). Any future byte-level AST consumer (formatter, refactor tool, precise source-map generator) benefits. Cost: one flag, ~no perf impact on acorn.

### 21.3 Export `parseModule(code)` convenience

Every consumer of AIR currently repeats the same parser setup:

```js
const { Parser, tsPlugin } = window.Acorn;   // or acorn in node
const parser = Parser.extend(tsPlugin());
const ast = parser.parse(code, { ... });
```

Add a zero-argument helper to `api.js`:

```js
import { Parser } from 'acorn';
import tsPlugin from 'acorn-typescript';
const _parser = Parser.extend(tsPlugin());

export function parseModule(code) {
  return _parser.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    ranges: true,
  });
}
```

Rationale: single source of truth for parser config. If AIR ever swaps parsers (e.g. for a faster one, or adds plugins), consumers don't rewrite their setup. Cost: ~10 LOC including exports. Also useful for test harnesses.

### 21.4 Expose `extractImports(ast)` / `extractExports(ast)`

AIR already walks the AST during lowering. It's natural to expose structured extraction of ES module declarations as standalone helpers:

```js
export function extractImports(ast) {
  // returns array of:
  // { kind: 'named', source: './x.js', specifiers: [{ imported, local }] }
  // { kind: 'namespace', source: './x.js', local: 'ns' }
  // { kind: 'side-effect', source: './x.js' }
  // kind: 'default' excluded — not used in GCU ecosystem
}

export function extractExports(ast) {
  // returns array of:
  // { kind: 'named', specifiers: [{ local, exported }] }
  // { kind: 'reexport-named', source: './x.js', specifiers: [...] }
  // { kind: 'reexport-wildcard', source: './x.js' }
  // { kind: 'declaration', declaration: <ast node> }  (export const/let/function/class)
}
```

Rationale: the bundler's primary need — classification of import/export declarations — is a narrow AST walk that doesn't belong to the bundler specifically. Future reactive-DAG work in Auditable (distinguishing static ES imports from runtime `load()` calls) would use the same helpers. Cost: ~40 LOC of AST walking, well-bounded.

**Non-goal:** these helpers do not resolve or rewrite. They only report structure. Resolution (which specifier maps to which inlined module) stays in the bundler; import stripping and reference rewriting stay in the bundler.

### 21.5 Not in scope for AIR

Rejected or deferred, to keep AIR focused:

- **Generic scope tree / scope-lookup service.** AIR's internal scope tracking is tuned for SSA lowering (mutable captures, hoisting, slot allocation). A bundler needs lexical-resolution-of-identifier-reference, which is a different question. The bundler rolls its own ~60 LOC walker (§6.3). Not worth binding AIR to a second use case.
- **Comment attachment.** Text-splice emit (§6.4) doesn't need structured comment access — comments are bytes between nodes, preserved by slicing. If a future consumer ever needs attached comments, revisit then.
- **AST rewriting utilities / code generation.** Out of AIR's domain (compilation) and overlaps with what the bundler already does locally.

These four additions are the whole set. If implementation reveals a fifth genuinely-needed helper, we add it; otherwise this is the complete AIR-side surface for `@gcu/build`.

---

*End of specification.*
