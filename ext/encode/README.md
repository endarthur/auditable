# @gcu/encode

The **Encode / Hash** tool surface for Auditable Works — base64 / hex / URL /
JSON transforms and SHA-1/256/512 digests via the Web Crypto API. A path-less
Tools-menu surface (not a file opener).

Contributes a single **surface** (`works.js` → `surface.html`, kind `encode`).
No service, no `src/` build, no lib deps beyond the universal `@gcu/surface` +
`@gcu/abus` base.

Ships baked into `works` / `works-all` (pre-installed into `/lib`) and is
installable into the lean `works-core` shell from the package registry. See
EXTENSION_SPEC §3.8 (surfaces).
