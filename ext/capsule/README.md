# @gcu/capsule

The GCU **capsule** transport — fragment-based content addressing for
share-by-URL, QR, and NFC. A *capsule* is a compact string that resolves to
bytes, either **carrying** content inline (deflate-compressed into a URL
fragment) or **referencing** it. Zero dependencies, browser-native only.

**Vendored** into auditable from ep's reference implementation
(`../ep/src/js/capsule.js`). The normative contract lives in the **cradle** repo
(`../cradle/SPEC-capsule.md` + `CAPSULES.md`) — read those, not this, when
extending. Keep in sync with ep.

## Schemes (Phase 1 — inline only)

- `inline:deflate:<base64url>` — long form.
- `i:d<base64url>` — compact inline (share links).
- `q:d<base45>` — QR/NFC-optimized (base45, ~22% denser in QR alphanumeric mode).

Reference schemes (`gh:` / `gist:` / `url:` / `doi:` / `zenodo:`) currently
resolve to `EUNKNOWN` (conforming graceful-degradation). They get wired when a
consumer needs them — notably the content registry (see
`spec_inbox/auditable-registry-spec.md` §9).

## API

`encodeInlineI(text)` · `encodeInlineQ(text)` · `resolveCapsule(capsule)` ·
`fragmentEncode/Decode` · `hasCapsuleFragment(loc?)` · `consumeCapsule()`.

## The one gotcha

`q:`/base45 contains space and `%`, both URL-fragment-unsafe. `fragmentEncode`
escapes `%`→`%25` then space→`%20`; `fragmentDecode` reverses with a **single
left-to-right pass** (not sequential global replaces) so a literal `%20` in the
payload round-trips. Always wrap a capsule through `fragmentEncode` before
putting it after `#`, and `fragmentDecode` (or `consumeCapsule`) on the way back.

## Tests

`test/capsule.test.mjs` — round-trips + the fragment-safety vectors (ported from
ep's conformance suite). `npm test`.
