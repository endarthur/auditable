# @gcu/book

The **Book reader** surface for Auditable Works — reflowable long-form reading
(a directory with `book.json` + Markdown/HTML chapters), with highlights,
per-book search, and KaTeX math.

Contributes a **surface** (`works.js` → `surface.html` [from `reader.html`], kind
`book`). Lib deps `@gcu/docview` + `@gcu/katex` + `@gcu/librarian` +
`@gcu/reader-core` via `gcu.requires` (`@gcu/markdown` is baked).

Ships baked into `works` / `works-all` and is installable into `works-core` from
the package registry. See EXTENSION_SPEC §3.8.
