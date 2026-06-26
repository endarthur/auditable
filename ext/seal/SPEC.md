# @gcu/seal — SPEC

**Build-emit + build-verify of security artifacts, so a tool's capability
declaration is build-ENFORCED, not hand-asserted.**

| | |
|---|---|
| Status | v0.1 — core (emit + verify) built; build-pipeline wiring pending |
| Deps | none (node:crypto); an injected `runSmoke` for the runtime gate |
| Runtime | Node (CI/build). Pure parts are environment-agnostic — swap the hash for Web Crypto to run over a `@gcu/vfs` adapter in-browser later |
| Tests | `test/seal.test.mjs` (11, in `npm test`) |

## Why

The `gentropic.org/security` wing declares each tool's capabilities (profile, hash,
CSP, SBOM). Hand-authored, those claims drift (the lamina stub claimed
`script-src 'self'` while lamina actually runs `'unsafe-inline'`). seal makes the
build EMIT the artifacts from the real bytes and VERIFY each claim against them, so a
false declaration fails the build. It also makes the CLAUDE.md invariant ("network is
an opt-in edge") executable.

## API

```js
emitArtifacts({ bytes, template, deps?, version?, doi? })
  → { sha256, capability, csp, cspText, sbom }
verifyClaims({ bytes, capability, runSmoke? })
  → { ok, profile, checks }   // throws SealError on a gated failure
```

- **emit** (pure): full-file `sha256`; `csp` extracted from the artifact's own
  `<meta http-equiv="Content-Security-Policy">` (single source of truth → can't
  drift); a CycloneDX `sbom` from `deps`; and `capability` = the per-tool template
  with the dynamic facts filled (`version`, `sha256`, real `csp`).
- **verify**: checks each claim against the bytes + an injected runtime smoke, throws
  `SealError` (with `.report`) on any *gated* failure.

## Profiles (`src/profiles.js`)

Weir-desk doctrine. The profile selects what verify asserts:

| Profile | network | codegen | wasm | remoteImport |
|---|---|---|---|---|
| **Sealed** | none (0 requests under `connect-src 'none'`) | forbidden | forbidden | forbidden |
| **Connected** | opt-in (0 requests *on load*) | forbidden | declared | forbidden |
| **Full** | any (no gate) | declared | declared | declared |

lamina = Sealed. works = Connected (install/registry/tiles are user-invoked edges,
never on load) — the doctrine line made executable.

## Gate vs warn (the load-bearing nuance)

- **Clear-cut source facts gate** — a literal `import('https://…')` when
  `remoteImport` is forbidden is unambiguous → fails the build.
- **Fuzzy source scans warn** — `eval(` / `WebAssembly` can sit in a string or
  comment, so the RUNTIME smoke is authoritative (an artifact that runs clean under a
  no-`'unsafe-eval'` CSP demonstrably does no codegen). seal reports the sites; it
  doesn't fail on a maybe.
- **Network is the runtime gate** — 0 requests (Sealed) / 0 on-load (Connected),
  proven by the injected smoke. Without a `runSmoke`, those claims are reported
  UNVERIFIED, never silently passed.

## The `runSmoke` contract

Injected by the consumer (seal stays browser-free):

```js
runSmoke({ bytes, capability }) → {
  networkRequests?,        // total requests observed (Sealed gate)
  networkRequestsOnLoad?,  // requests before first user action (Connected gate)
  ranClean?,               // booted + ran under the pinned CSP
}
```

For lamina this is its existing `test/lamina-built-smoke.mjs` (already proves
`connect-src 'none'` + zero requests).

## Where artifacts land

emit produces the four; a release step copies them into
`gentropic/security/artifacts/<tool>/` + patches the page's provenance
placeholders. v1 = manual copy per release; a PR-to-`gentropic/security` Action
later. seal produces; delivery is the consumer repo's release plumbing.

## Adoption

API complete-first (all three profiles). Prove on **lamina** (Sealed pilot — wire
into `build.js`'s lamina target), validate the generalization on **works**
(Connected), then ep/weir/koma fill the same per-tool template.

## Roadmap

- Wire into `build.js` (lamina): emit → verify (runSmoke = the built-smoke) → write
  artifacts; fail the build on a gated failure.
- Confirm/resolve the lamina `wasm` declaration (the scan flagged WebAssembly sites —
  `xz-decompress`?) before gating it.
- Signing (reuse auditable's Ed25519 `sign.js`?), Zenodo DOI automation.
- Browser/`@gcu/vfs` path (Web Crypto) for in-shell provisioning verification.

## Versioning

Pre-1.0; the emit/verify contracts may shift until works adopts it.
