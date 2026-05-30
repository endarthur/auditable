# @gcu/pdfjs

Vendored **PDF.js** (Mozilla) — the rendering engine for the reader's `pdf`
backend (`@gcu/reader-core`). **Apache-2.0** (full notice is inline in the
vendored source headers; see `vendor/`).

- Pinned: **pdfjs-dist 3.11.174**, the `legacy` **UMD** build (`pdf.min.js` +
  `pdf.worker.min.js`).
- **Why v3, not v4:** v4 is ESM-only with a module worker. Works reader surfaces
  run from `file://` as `blob:file://` iframes, where cross-blob ESM imports are
  blocked — so the engine must load as a *classic* script (indirect `eval`) and
  use a *classic* worker (blob URL). v3's UMD build is the last line that
  provides both.

## Build

`node ext/pdfjs/build.js` concatenates `vendor/pdf.min.js` + the worker (embedded
as a `globalThis.__pdfjsWorkerSrc` string) into `index.js`.

## How it's consumed

Not a normal importable ESM lib — it's never inlined into a surface. It's a
**works-all-only** shared lib: auto-discovered by `build.js` (`_allExtBundles`),
shipped as a `lib-pdfjs` payload, and installed to
`/usr/lib/@gcu/pdfjs/source`. The reader surfaces read that source over the
works VFS service, `(0,eval)` it (→ `globalThis["pdfjs-dist/build/pdf"]`), and
build a classic worker from `globalThis.__pdfjsWorkerSrc`. Absent in base
`works.html`, so PDF chapters there degrade gracefully.

## Updating

Re-fetch `pdf.min.js` + `pdf.worker.min.js` from a `pdfjs-dist@3.x/legacy/build/`
CDN into `vendor/`, then rerun the build. Do **not** jump to v4 without solving
the file:// ESM-worker constraint above.
