# @gcu/workbench

The geoscience/tabular **Data Workbench** for Auditable Works — a surface plus a
shell-side `pipeline` A-Bus service that streams summary stats, grade-tonnage,
swath, and category profiles over CSV / OMF block models, computed shell-side so
only small results cross A-Bus.

This package contributes **both** kinds of Works contribution:

- a **surface** (`works.js` → `surface.html`, kind `workbench`) — the UI;
- a **service** (`package.json` `gcu.services` → `service.js`) — the `pipeline`
  flowsheet engine, declared as data and activated cold→hot on first call
  (dependency-injected; `requires` flowsheet / sluice / recon / proc / omf1).

Built from `src/` via `node ext/workbench/build.js`. Ships baked into
`works` / `works-all` (pre-installed into `/lib`) and is installable into the
lean `works-core` shell from the package registry. See EXTENSION_SPEC §3.8
(surfaces) + §3.9 (services).
