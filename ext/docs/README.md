# @gcu/docs

The **Documentation browser** surface for Auditable Works — a full-pane shelf
over the same content registry as Browse Library, with full-text search and
Markdown rendering.

Contributes a **surface** (`works.js` → `surface.html`, kind `docs`). Lib deps
`@gcu/docview` + `@gcu/librarian` via `gcu.requires` (`@gcu/markdown` is baked).

Ships baked into `works` / `works-all` and is installable into `works-core` from
the package registry. See EXTENSION_SPEC §3.8.
