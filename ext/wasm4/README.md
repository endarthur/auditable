# @gcu/wasm4

The **WASM-4** fantasy console for Auditable Works — runs conformant `.wasm`
carts (written in any source language) over a small register/framebuffer/APU
engine. Spawns with a baked demo cart when opened path-less.

This package is **self-contained**: its `index.js` *is* the WASM-4 engine
(installed to `/lib/@gcu/wasm4/source`), and the console **surface**
(`works.js` → `surface.html`, kind `wasm4`) imports `@gcu/wasm4` — resolved from
the package's own source at spawn. No external lib deps, no dep-closure.

Ships baked into `works` / `works-all` (pre-installed into `/lib`) and is
installable into the lean `works-core` shell from the package registry. See
EXTENSION_SPEC §3.8 (surfaces).
