# ext/bearing — vendored @gcu/bearing

`@gcu/bearing` is the structural-geology stereonet engine (projections,
statistics, contouring, fabric analysis) developed in the sibling repo
**[gentropic/bearing.js](https://github.com/endarthur/bearing.js)**. It is the
engine behind the `/// stereonet` cell type (`ext/stereonet`).

This directory holds a **vendored build** of it: `index.js` is the current
`dist/bearing.mjs` (a self-contained ESM, zero deps), bundled into the Works
shell as a `/usr/lib/@gcu/bearing` builtin. That makes `load('@gcu/bearing')`
resolve the **current** version offline — the npm/esm.sh copy lags behind the
repo, so we don't depend on it.

## Canonical source / updating

`index.js` is **generated — do not hand-edit.** The source of truth is the
`bearing.js` repo. To refresh after a new bearing build:

```
# in the bearing.js repo: node build.js   (regenerates dist/bearing.mjs)
node ext/bearing/sync.mjs                  # sibling at ../bearing.js
node ext/bearing/sync.mjs /path/to/bearing.js
```

Then rebuild the Works targets (`node build.js --target=works` /
`--target=works-all`) so the embedded builtin updates.

## Exports

`Stereonet`, `conversions`, `mat3`, `vec3`, `quat`, `rotation`, `euler`,
`statistics`, `fabricplot`, `equalArea`/`equalAngle`, `rose`, `circular`, … —
see `bearing.d.ts` in the source repo for the full typed surface.
