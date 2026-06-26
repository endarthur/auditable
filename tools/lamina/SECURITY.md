# lamina — security & IT notes

lamina is a **single, self-contained HTML file** for viewing arbitrarily large
data files (CSV/TSV, Datamine `.dm`, text, archives) in the browser. It is built
for environments where the data is sensitive and must not leave the machine.

## The guarantee: your data never leaves the page

- **No network egress, enforced by the browser.** The file ships a Content
  Security Policy with **`connect-src 'none'`** — every network channel (fetch,
  XHR, WebSocket, beacon, EventSource) is blocked at the browser level. It is not
  "we chose not to call out"; the page *cannot*. (You can verify: open it, run
  `fetch(location.href)` in the console — it is rejected by CSP.)
- **No external resources.** No CDN, no remote scripts or styles, no web fonts
  (font names are referenced with system fallbacks — nothing is downloaded), no
  analytics, no telemetry, no auto-update. The favicon is an inline `data:` image.
  The entire runtime is inlined **in the clear** in the one file (no `eval`, no
  self-extractor) — so the CSP needs no `'unsafe-eval'`, and what runs is exactly
  what you can read.
- **No code generation, no WebAssembly.** The CSP grants neither `'unsafe-eval'`
  *nor* `'wasm-unsafe-eval'` — lamina runs no `eval`/`new Function` and instantiates
  no WASM module. (One consequence, by design: `.xz` archives need a WebAssembly
  decoder, so they aren't supported — re-compress as `.gz`, `.zst`, or `.zip`. Every
  other format works.)
- **No account, no server, no SaaS.** Nothing to log in to; no backend; no
  data-processing agreement. It reads only the local files you open.
- **Read-only.** lamina never modifies the files it opens. (Export writes a *new*
  file you choose, locally via the File System Access API — never an upload.)

## Deployment

- Run it from a **file share**, an **internal web server**, or straight off the
  local disk (`file://`). Works **air-gapped** and **behind any proxy** — no
  firewall exceptions or domain allowlisting needed.
- Installable as a PWA for offline use, but that is optional; the bare `.html`
  is fully functional on its own.

## Verifying the artifact — the capability declaration

Every release publishes a machine-readable **capability declaration** at
**[gentropic.org/security](https://gentropic.org/security)**, and these claims are
**enforced by lamina's build** (via `@gcu/seal`) — derived from the shipped bytes,
not asserted by hand:

- **`sha256.txt`** — the SHA-256 of the exact `lamina.html`. Reproduce it:
  `shasum -a 256 lamina.html` must match the published value.
- **`capability.json`** — the profile (`Sealed`) and the verified claims: no network,
  no codegen, no WebAssembly, no remote import; read-only; user-initiated I/O only.
- **`csp.txt`** — the exact CSP the file runs under, **extracted from the file
  itself**, so it can't drift from what's documented.
- **`sbom.json`** — the dependency set (a few MIT decoders; otherwise zero).

The build re-derives all four from the bytes and **fails if a claim is false** — a
stray remote import, or network egress on load (a headless test loads the file under
the pinned CSP and records zero requests). So the declaration can't lie: a false
"Sealed" doesn't ship.

- The footer also shows a build stamp `version · <content-hash> · date` (the hash is
  a content hash of the runtime) — a quick at-a-glance check after copying the file
  onto a locked-down host; the SHA-256 + the wing are the full verification.

## Licensing

- lamina and its libraries (`@gcu/loom`, `@gcu/lamina`, `@gcu/expr`, `@gcu/dm`,
  `@gcu/proc`, `@gcu/archive`) are **MIT**. The Datamine `.dm` reader is a clean,
  independent implementation (format reverse-engineered from public sources;
  excluded from copyright under the EU Software Directive) — see `ext/dm/SPEC.md`.

## The CSP, in full

```
default-src 'none';
script-src 'self' 'unsafe-inline' blob:;
style-src 'unsafe-inline';
img-src data:;
worker-src 'self' blob:;
child-src 'self' blob:;
manifest-src 'self';
connect-src 'none';
base-uri 'none';
form-action 'none'
```

No `'unsafe-eval'` — the runtime is inlined in the clear, not unpacked at load.
`'unsafe-inline'` covers that inlined boot, which **is** the application, present
in the file you audit (not loaded from anywhere); `blob:` isolates each module as
its own ES module. There are **no remote origins** in `script-src`, so no external
code can ever load — and `connect-src 'none'` is the line that matters for
confidentiality: it makes data egress impossible.
