# @gcu/doc

The **Document** editor surface for Auditable Works — a Markdown editor with live
preview, YAML frontmatter, `{{template}}` interpolation, and EPUB export. A
universal any-file fallback that claims `.md` / `.markdown`.

Contributes a **surface** (`works.js` → `surface.html`, kind `doc`). Its lib
deps — `@gcu/archive`, `@gcu/epub`, `@gcu/template`, `@gcu/yaml` — are declared
in `package.json` `gcu.requires` and pulled by the dep-closure on install
(`@gcu/markdown` + `@gcu/menu` are baked into every shell).

Ships baked into `works` / `works-all` (pre-installed into `/lib`) and is
installable into the lean `works-core` shell from the package registry. See
EXTENSION_SPEC §3.8 (surfaces) + §3.9 (requires).
