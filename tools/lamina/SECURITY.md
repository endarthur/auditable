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
- **No account, no server, no SaaS.** Nothing to log in to; no backend; no
  data-processing agreement. It reads only the local files you open.
- **Read-only.** lamina never modifies the files it opens.

## Deployment

- Run it from a **file share**, an **internal web server**, or straight off the
  local disk (`file://`). Works **air-gapped** and **behind any proxy** — no
  firewall exceptions or domain allowlisting needed.
- Installable as a PWA for offline use, but that is optional; the bare `.html`
  is fully functional on its own.

## Verifying the artifact

- The footer shows a build stamp `version · <content-hash> · date`. The hash is a
  content hash of the runtime, so two files with the same stamp are byte-identical
  in behaviour — a quick integrity check after copying it onto a locked-down host.

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
