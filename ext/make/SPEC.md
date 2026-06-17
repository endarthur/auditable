# @gcu/make — derived-graph build orchestrator

**"The catcher in the rye of build orchestrators. No phonies."**

Make's premise is *write down your dependencies*. GCU already **has** them — in the imports and
`inline` lists — so `@gcu/make` **derives** the graph instead of declaring it, and rebuilds only
what changed (and whatever sits downstream of a change). Content-hash, not mtime. No Makefile, no
rule DSL, no `.PHONY` — every target is a real artifact whose source-hash is the truth.

It's the orchestration layer above [`@gcu/build`](../build/SPEC.md) (the bundler). `@gcu/build`
produces *one* bundle; `@gcu/make` runs the *graph* of bundles / carts / packages / deploys in
order, skipping the unchanged.

## What's built (2026-06-07)

- **Discovery + derivation** — finds every package whose `build.js` is `@gcu/build`-managed
  (`build.js` mentions `@gcu/build` + has `src/main.js`), reads the cross-package edges out of the
  source imports (`@gcu/x` bare / `../x/` escaping), topo-sorts deps-first.
- **Content-hash incremental** — `.gcu-make.cache.json` (gitignored); rebuild only changed +
  downstream-of-changed. Orchestrates by spawning each `build.js` — the per-package config stays the
  single source of truth (no duplication).
- **Declared targets** (the repo's `make.yaml`) for the non-uniform root builds — `auditable.html →
  works / works-all / examples`, each `{ name, out, cmd, deps, inputs, check? }` (glob `inputs:`,
  `cmd:` a full argv), content-gated, run after the packages. The keystone: auditable's `inputs`
  include every `ext/*/index.js`, so a package rebuild → auditable rebuilds → works rebuilds — the
  "forgot-to-rebuild-the-embedded-notebook" staleness is structural. (Roadmap parts 1+2, below, are
  BUILT: targets moved out of `make.js` into `make.yaml`, so `@gcu/make` carries nothing
  repo-specific — it's a generic bin. Accepted makefile names: `make.yaml` (canonical) /
  `gcu-make.yaml` / `makefile.yaml`.)
- **CLI** (`bin: gcu-make`): `[--force | --check | --graph | --no-targets | --quiet] [pkg…]`.
  `--check` = force-rebuild + assert no git drift (the CI invariant).

## Roadmap — `gcu-make.yaml`, standalone, in-browser, `make` in geas

The forcing function: **atra carts** (the `@gcu/wasm4` build — `SPEC-wasm4.md` §4) are the first
**non-JS toolchain** to orchestrate, and **catra** (the C-syntax frontend on the atra backend,
specced not built) is the second that confirms the shape. A `.atra → .wasm` step has no import
graph to read, and lives in a package that shouldn't have to edit the central `make.js`. So:

### 1. Per-package declarative targets (`make.yaml`) — BUILT

> **Built.** The repo-root `auditable/make.yaml` replaces the old `REPO_TARGETS` JS array;
> `loadTargets(root)` parses it (via `@gcu/yaml`) into the same `{ name, out, cmd, deps,
> inputs(root), checkPaths }` shape, with glob `inputs:` resolved through `globFiles` and `check:`
> mapped to `checkPaths`. Names resolve `make.yaml` → `gcu-make.yaml` → `makefile.yaml` (first wins,
> warns on multiple). NB `@gcu/yaml` is a strict subset: **block sequences only** (no `[a, b]`
> flow), **scalars quoted**. Per-package `ext/<pkg>/make.yaml` files are discovered too — their
> targets are namespaced `<pkg>:<target>`, with inputs/out/check and relative `run:` modules
> resolved against the package dir, so a package owns its own build graph (see `ext/wasm4/make.yaml`).

Lift the `REPO_TARGETS` array out of `make.js` into discovered, per-root/per-package
`make.yaml` files. The record is *exactly* today's `{ name, out, cmd, deps, inputs }` — sourced
from YAML (via `@gcu/yaml`) instead of a JS array:

As BUILT — `@gcu/yaml` is a strict subset, so block sequences + quoted scalars (no `[a, b]` flow).
The real `ext/wasm4/make.yaml` (a per-package toolchain; targets namespaced `wasm4:*`, paths relative
to the package dir, the recipe module relative too):

```yaml
# ext/wasm4/make.yaml — an atra/wasm4 toolchain package
targets:
  raster:
    out: "build/raster.wasm"
    run: "../atra/atrac.js#compileRecipe"   # a GCU FUNCTION recipe (§3) — in-process, vfs-portable
    opts:
      __memory: true                         # the rasterizer imports the shared framebuffer memory
    inputs:
      - "raster.atra"
  cart:
    out: "build/cart-demo.wasm"
    run: "../atra/atrac.js#compileRecipe"
    inputs:
      - "cart-demo.atra"
```

```yaml
# auditable/make.yaml — the repo targets, moved out of make.js (the dogfood: proves
# @gcu/make has nothing auditable-specific left inside it). Managed @gcu/build
# packages stay AUTO-DISCOVERED + edge-DERIVED — you only declare the non-derivable.
targets:
  auditable:
    out: "auditable.html"
    cmd:
      - "node"
      - "build.js"
    inputs:
      - "src/**"
      - "ext/*/index.js"
      - "build.js"
  works:
    out: "works.html"
    deps:
      - "auditable"
    cmd:
      - "node"
      - "build.js"
      - "--target=works"
    inputs:
      - "works/**"
      - "ext/*/index.js"
      - "auditable.html"
      - "build.js"
  examples:                       # no out: → many outputs (input/dep-gated)
    deps:
      - "auditable"
    cmd:
      - "node"
      - "gen_examples.js"
    inputs:
      - "examples/defs/**"
      - "auditable.html"
    check:                        # drift pathspecs (skips the random-DEK crypto demo)
      - "examples/"
      - ":(exclude)examples/basics/example_encrypted_password-is-auditable.html"
```

`inputs:` globs replace the JS `inputs(root)` functions. **Hybrid: derive where possible
(import graphs), declare where you must (no graph to read — `.atra→.wasm`, packing, signing).**
You write config only for the irreducible part.

### 2. Standalone — read `make.yaml` from any root — BUILT

> **Built.** `REPO_TARGETS` is deleted from `make.js`; `make()` reads targets via
> `loadTargets(root)` (→ `[]` when no makefile, so a generic repo just runs its packages). Nothing
> auditable-specific remains in `@gcu/make`.

Once §1 lands, the *only* auditable-specific thing in `@gcu/make` is gone (it's in
`auditable/make.yaml` now). `@gcu/make` becomes a **generic bin**: any repo — a wasm4 game, a
catra project, ep, weir — drops a `make.yaml` and gets the content-hash incremental + drift
engine for free. (It's already its own package with a `gcu-make` bin; this is what makes it
*usable* outside the monorepo.)

### 3. `run:` — GCU-function recipes (in-browser builds) — BUILT

> **Built.** A target may declare `run: "<module>#<export>"` instead of `cmd:`. The named export is
> a **pure transform** `recipe(inputs, opts) → Uint8Array | string | { relpath: data }`; gcu-make
> owns all file I/O (reads `inputs`, writes the return), so the *same* recipe runs over node-fs today
> and a `@gcu/vfs` adapter in-browser/geas — the `@gcu/build` §1.4 pure-core+adapter shape (option 1
> over "recipe owns its own I/O"). A single blob → the target's `out:`; a map → each key written
> relative to root. `<module>` = `@gcu/<name>` (→ `ext/<name>/index.js`) or a path relative to root.
> `make()` is now async (recipes + the future vfs path are async). `inputs` arrive as
> `{path, text, bytes}` so a recipe picks text or bytes; `opts:` in the target is passed through.
>
> First recipe: `ext/atra/atrac.js#compileRecipe` (a 3-line wrapper over `atra.compile`, in atra's
> tooling entry — NOT the embedded index.js, so no auditable cascade). Dogfood: `ext/wasm4/make.yaml`
> (a per-package makefile) compiles `raster.atra` + `cart-demo.atra → .wasm` entirely in-process.

`cmd: [...]` is a subprocess (Node CLI, today). `run: "@gcu/atra#compile"` is a **GCU function** —
imported + invoked over a vfs/memory adapter, no subprocess. This is how `@gcu/make` compiles atra
**inside Works, air-gapped, no Node** — the same self-hosting ethos as `@gcu/build`'s vfs adapter
(`@gcu/build` §1.4). Recipe contract (as built): `recipe(inputs, opts) → bytes | string | {relpath:
data}` (gcu-make owns I/O — option 1, not the sketch's `run(inputs[], outPath, opts)`). This is the
axis Make structurally cannot have — it's shell all the way down.

### 4. `make` in geas

Expose `@gcu/make` as a **`make`** builtin/alias in geas — because we can, and because in the GCU
shell a build *is* `make`. Composes with typed pipes; with §3, `make` builds GCU software from
inside the desktop with no external toolchain.

**Build it when the wasm4 multi-artifact graph (cart + mathlib + rasterizer + surface + pack) makes
it pay — not for a single `atra.compile(src)` one-liner.** atra carts motivate it; catra confirms it.
