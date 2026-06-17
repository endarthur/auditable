# editions

Pre-bundled **editions** of Auditable — the base notebook (`auditable.html`) with a
curated set of extensions embedded in `_installedModules`, so `load("@gcu/<ext>")`
resolves instantly and **offline** (no network fetch). Open the file and start working.

Built by `node build.js --target=<edition>` (and managed by gcu-make, which builds the
base first). Reproducible: the build date is the git commit date, so the same source
yields byte-identical output.

| edition | bundles | for |
|---|---|---|
| `auditable-py.html` | adder + `@gcu/plot` + `@gcu/sadpan` | scientific Python (NumPy/pandas/matplotlib-shaped), offline |
| `auditable-geo.html` | the above + gslib (geostatistics: sgsim, kriging) | resource estimation, offline (the dogfood handout) |

The lean `auditable.html` at the repo root stays the canonical app; editions are
batteries-included distributables built on top of it. Adding one is a small entry in
`build.js`'s `EDITIONS` table plus a target in the repo's `make.yaml`.
