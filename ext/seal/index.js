// @gcu/seal — build-emit + build-verify of security artifacts (hash · capability.json
// · csp.txt · CycloneDX SBOM), so a tool's capability declaration is build-ENFORCED,
// not hand-asserted. Node-only today (node:crypto + an injected runtime smoke); the
// pure parts are environment-agnostic for an in-browser provisioning path later.
//
// Real ESM modules (no concat build) — seal is a CI/build tool, not a bundled browser
// lib. See SPEC.md.
export { PROFILES, profileOf } from './src/profiles.js';
export { sha256, extractCsp, cspToLines, cspText, buildSbom, emitArtifacts } from './src/emit.js';
export { SealError, verifyClaims } from './src/verify.js';
