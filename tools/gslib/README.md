# gslib.atra — GSLIB in a browser

A single-file geostatistics workbench (`node build.js --target=gslib` → `gslib.html`, ~660 KB)
built on **`@gcu/gslib`** — the frozen atra→WebAssembly transcription of Stanford's GSLIB
(Deutsch & Journel), where *the Fortran is the spec*: same variable names, same accumulation
order, the original `.for` files in `ext/gslib/ref/`. The tool can say "these are GSLIB's
numbers" because they are the same arithmetic, not a reimplementation.

The Wasm is **auditable**: the `.atra` source and the compiler live in this repo, and the
bytecode is reproducible from both. Networkless (`connect-src 'none'`); nothing leaves the
machine.

## The workflow (one step rail, one viewer)

1. **Data** — GeoEAS `.dat` (the book's format) or CSV (delimiter + decimal knobs, decimal
   comma supported); **drillholes** (collar + survey + intervals in one multi-file pick,
   sniffed and desurveyed by minimum curvature via `@gcu/condenser`); a **samples menu**:
   clustered 2D synthetic · 3D drillhole campaign · **cluster.dat** (the book's 140 samples,
   embedded verbatim with the 1996 Stanford notice, authenticated against the book's own
   fingerprints).
2. **Decluster** — `declus`, with the cell-size sweep plotted and the minimum marked.
3. **Variography** — `gamv` experimental variograms (directions carry dip + dip tolerance for
   3D), a **variogram map** (24-azimuth fan), and the model editor: nugget + nested structures
   with the full anisotropy ellipsoid (range / minor / vert, azimuth / dip). The overlay is
   `vmodel` — the exact covariance the kriging uses. Model exports as JSON.
4. **Kriging** — `kb2d` (2D) / `kt3d` (true 3D grids), OK/SK, search + discretization. The
   result lands in the viewer as a block model (estimate / variance). Exports: grid CSV,
   `kt3d.par`.
5. **Simulation** — the honest chain: `nscore` (declustering weights honoured) → `sgsim` in
   Gaussian space (the fitted model rescaled to unit sill — the labelled teaching shortcut) →
   `backtr` with tails pinned to the data extremes. **N realizations per click** on a cached
   handle; view any realization, the e-type mean, or the per-node std dev. Exports:
   `realizations.csv` (one column per seed), `sgsim.par`.

The viewer is `@gcu/condenser` (micro's engine): samples as points coloured by grade, results
as block layers, EDL depth cueing, axis sections (scrub with `,` / `.`, toggle with `x`).

## `.par` files, both directions

Import a `gamv/kt3d/sgsim/declus.par` (named after its program) and the **parameters travel**
— grid, search, lags, directions, the nested variogram — while the file paths inside are
ignored and *said* to be ignored. Export writes `.par` files real GSLIB can run, with 1-based
GeoEAS column numbers from the actual mapping. The round-trip is smoke-guarded.

## Verification

- `node test/gslib-smoke.mjs` — the pipeline, 2D + the full 3D arc (26 checks).
- `node test/gslib-smoke2.mjs` — the book guards (16 checks), including: **our `declus` on
  cluster.dat must land on the book's published declustered mean** (~2.5; we get 2.56), and a
  `kt3d.par` export→wipe→import round-trip preserving the full anisotropy ellipsoid.
- Library layer: `test/gslib.test.js` (the oracle vs the Fortran).

## Status / not yet

ik3d + sisim (indicator methods — cutoff UI undesigned), a user manual, the seal
networkless+wasm profile (build prints `seal: SKIPPED`, honestly), deploy. UI/UX polish target:
**lamina-level**.
