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
- **Declared `REPO_TARGETS`** (in `make.js`) for the non-uniform root builds — `auditable.html →
  works / works-all / examples`, each `{ name, out, cmd, deps, inputs(root), checkPaths? }`,
  content-gated, run after the packages. The keystone: auditable's `inputs` include every
  `ext/*/index.js`, so a package rebuild → auditable rebuilds → works rebuilds — the
  "forgot-to-rebuild-the-embedded-notebook" staleness is structural.
- **CLI** (`bin: gcu-make`): `[--force | --check | --graph | --no-targets | --quiet] [pkg…]`.
  `--check` = force-rebuild + assert no git drift (the CI invariant).

## Roadmap — `gcu-make.yaml`, standalone, in-browser, `make` in geas

The forcing function: **atra carts** (the `@gcu/wasm4` build — `SPEC-wasm4.md` §4) are the first
**non-JS toolchain** to orchestrate, and **catra** (the C-syntax frontend on the atra backend,
specced not built) is the second that confirms the shape. A `.atra → .wasm` step has no import
graph to read, and lives in a package that shouldn't have to edit the central `make.js`. So:

### 1. Per-package declarative targets (`gcu-make.yaml`)

Lift the `REPO_TARGETS` array out of `make.js` into discovered, per-root/per-package
`gcu-make.yaml` files. The record is *exactly* today's `{ name, out, cmd, deps, inputs }` — sourced
from YAML (via `@gcu/yaml`) instead of a JS array:

```yaml
# ext/wasm4/gcu-make.yaml — an atra/wasm4 toolchain package
targets:
  mathlib:                          # minimax transcendentals, atra → wasm
    out: build/mathlib.wasm
    run: "@gcu/atra#compile"        # a GCU FUNCTION recipe (see §3) → builds in-browser too
    inputs: [src/mathlib.atra]
  cart:
    out: build/cart.wasm
    run: "@gcu/atra#compile"
    deps: [mathlib]
    inputs: [src/cart.atra, src/mathlib.atra]
  pack:
    out: dist/wasm4-demo.gcupkg
    cmd: [node, pack.js, build/cart.wasm]   # a subprocess recipe (CLI path)
    deps: [cart]
```

```yaml
# auditable/gcu-make.yaml — the repo targets, moved out of make.js (the dogfood:
# proves @gcu/make has nothing auditable-specific left inside it). Managed @gcu/build
# packages stay AUTO-DISCOVERED + edge-DERIVED — you only declare the non-derivable.
targets:
  auditable: { out: auditable.html, cmd: [node, build.js],
               inputs: ["src/**", "ext/*/index.js", "build.js"] }
  works:     { out: works.html, cmd: [node, build.js, --target=works], deps: [auditable],
               inputs: ["works/**", "ext/*/index.js", "auditable.html", "build.js"] }
  examples:  { out: null, cmd: [node, gen_examples.js], deps: [auditable],
               inputs: ["examples/defs/**", "auditable.html"],
               check: ["examples/**/*.html"] }   # drift pathspec (skips random-DEK crypto demo)
```

`inputs:` globs replace the JS `inputs(root)` functions. **Hybrid: derive where possible
(import graphs), declare where you must (no graph to read — `.atra→.wasm`, packing, signing).**
You write config only for the irreducible part.

### 2. Standalone — read `gcu-make.yaml` from any root

Once §1 lands, the *only* auditable-specific thing in `@gcu/make` is gone (it's in
`auditable/gcu-make.yaml` now). `@gcu/make` becomes a **generic bin**: any repo — a wasm4 game, a
catra project, ep, weir — drops a `gcu-make.yaml` and gets the content-hash incremental + drift
engine for free. (It's already its own package with a `gcu-make` bin; this is what makes it
*usable* outside the monorepo.)

### 3. `run:` — GCU-function recipes (in-browser builds)

`cmd: [...]` is a subprocess (Node CLI, today). `run: "@gcu/atra#compile"` is a **GCU function** —
imported + invoked over a vfs/memory adapter, no subprocess. This is how `@gcu/make` compiles atra
**inside Works, air-gapped, no Node** — the same self-hosting ethos as `@gcu/build`'s vfs adapter
(`@gcu/build` §1.4). Recipe contract (sketch): `run(inputs[], outPath, opts) → bytes`. This is the
axis Make structurally cannot have — it's shell all the way down.

### 4. `make` in geas

Expose `@gcu/make` as a **`make`** builtin/alias in geas — because we can, and because in the GCU
shell a build *is* `make`. Composes with typed pipes; with §3, `make` builds GCU software from
inside the desktop with no external toolchain.

**Build it when the wasm4 multi-artifact graph (cart + mathlib + rasterizer + surface + pack) makes
it pay — not for a single `atra.compile(src)` one-liner.** atra carts motivate it; catra confirms it.
