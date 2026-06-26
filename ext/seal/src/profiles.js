// @gcu/seal — the three GCU enterprise profiles (weir-desk doctrine) and what
// `verifyClaims` asserts for each. A profile is a CONTRACT the built artifact must
// satisfy; verify checks it against the real bytes (+ an injected runtime smoke), so
// a false declaration fails the build. This makes a profile DECLARATION build-enforced
// rather than asserted.
//
// Field values:
//   network:      'none'   — zero egress, ever (verified: 0 requests under connect-src 'none')
//                 'opt-in' — egress allowed, but NONE on load + user-invoked (verified: 0 on-load requests)
//                 'any'    — unrestricted (descriptive; no network gate)
//   codegen/wasm/remoteImport:
//                 false      — forbidden (gate)
//                 'declared' — allowed; verify only checks the flag matches observed behaviour
export const PROFILES = {
  Sealed:    { network: 'none',   codegen: false,      wasm: false,        remoteImport: false },
  Connected: { network: 'opt-in', codegen: false,      wasm: 'declared',   remoteImport: false },
  Full:      { network: 'any',    codegen: 'declared', wasm: 'declared',   remoteImport: 'declared' },
};

export function profileOf(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`@gcu/seal: unknown profile "${name}" (expected ${Object.keys(PROFILES).join(' | ')})`);
  return p;
}
