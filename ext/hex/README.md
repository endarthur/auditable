# @gcu/hex

The **Hex viewer** surface for Auditable Works — a universal loose-file viewer
for raw binary: a virtualized hex/ASCII dump plus a data inspector (read any
bytes at an offset as int/float/string in either endianness). The "any-bytes
floor": every file opens to *something* useful.

This package contributes a single **surface** (`works.js` → `surface.html`,
kind `hex`, `universal: true`). No service, no `src/` build — the surface is a
self-contained iframe document that needs only the universal `@gcu/surface` +
`@gcu/abus` base (both already in every shell).

Ships baked into `works` / `works-all` (pre-installed into `/lib`) and is
installable into the lean `works-core` shell from the package registry. See
EXTENSION_SPEC §3.8 (surfaces).
