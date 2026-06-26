// @gcu/seal — verify: the load-bearing half. Check each claim the capability
// declaration publishes against the REAL artifact (pure source scans) + an injected
// runtime smoke (the authoritative network/CSP gate), and THROW on any gated failure
// so a false declaration fails the build.
//
// Design note — what gates vs warns:
//   - Clear-cut source facts gate: a literal `import('https://…')` when remoteImport
//     is forbidden is unambiguous.
//   - Fuzzy source scans warn, they don't gate: `eval(`/`WebAssembly` can sit in a
//     string or comment, so the RUNTIME smoke is authoritative (an artifact that runs
//     clean under a no-'unsafe-eval' CSP demonstrably does no codegen, whatever a
//     regex finds). seal reports the sites; it doesn't fail the build on a maybe.
//   - The network gate is the runtime smoke (0 requests under connect-src 'none' for
//     Sealed; 0 on-load requests for Connected). Without a runSmoke, those claims are
//     reported UNVERIFIED (not silently passed).
import { profileOf } from './profiles.js';

export class SealError extends Error {
  constructor(message, report) { super(message); this.name = 'SealError'; this.report = report; }
}

const RE = {
  // import('http…') or import … from 'http…' — remote CODE import (worse than fetch)
  remoteImport: /\bimport\s*\(\s*[`'"]https?:\/\/|\bfrom\s*[`'"]https?:\/\//gi,
  codegen: /\beval\s*\(|\bnew\s+Function\s*\(/g,
  wasm: /\bWebAssembly\b|\.wasm\b/g,
};
function countSites(text, re) {
  const r = new RegExp(re.source, re.flags); let n = 0; while (r.exec(text)) n++; return n;
}

/**
 * @param {object} o
 * @param {Buffer|string} o.bytes      the built artifact
 * @param {object} o.capability        the emitted capability.json (has profile, sha256, flags)
 * @param {function} [o.runSmoke]      async ({bytes, capability}) → { networkRequests, networkRequestsOnLoad, ranClean }
 *                                     — injected by the consumer (seal stays browser-free)
 * @returns {Promise<{ok, profile, checks}>}  throws SealError if a gated check fails
 */
export async function verifyClaims({ bytes, capability, runSmoke } = {}) {
  if (!capability || !capability.profile) throw new Error('@gcu/seal verify: capability with a profile required');
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const prof = profileOf(capability.profile);
  const checks = [], failed = [];
  const add = (name, pass, detail, gate = true) => { const c = { name, pass, detail, gate }; checks.push(c); if (!pass && gate) failed.push(c); return c; };

  add('sha256-well-formed', /^[0-9a-f]{64}$/.test(capability.sha256 || ''), capability.sha256 || '(missing)', true);

  if (prof.remoteImport === false) {                                   // clear-cut → gate
    const n = countSites(text, RE.remoteImport);
    add('no-remote-import', n === 0, `${n} literal remote import site(s)`, true);
  }
  if (prof.codegen === false) {                                        // fuzzy → warn (runtime gates)
    const n = countSites(text, RE.codegen);
    add('no-codegen (source scan)', n === 0, `${n} eval/Function site(s) — runtime smoke is authoritative`, false);
  }
  if (prof.wasm === false) {
    const n = countSites(text, RE.wasm);
    add('no-wasm (source scan)', n === 0, `${n} WebAssembly/.wasm site(s)`, false);
  }

  if (typeof runSmoke === 'function') {                                // the authoritative network/CSP gate
    const r = (await runSmoke({ bytes, capability })) || {};
    if (prof.network === 'none') add('zero-network (runtime)', (r.networkRequests | 0) === 0, `${r.networkRequests | 0} request(s) under connect-src 'none'`, true);
    else if (prof.network === 'opt-in') add('zero-network-on-load (runtime)', (r.networkRequestsOnLoad | 0) === 0, `${r.networkRequestsOnLoad | 0} request(s) on load`, true);
    if ('ranClean' in r) add('runs-under-pinned-csp (runtime)', !!r.ranClean, r.ranClean ? 'ok' : 'failed', true);
  } else if (prof.network !== 'any') {
    add('runtime-smoke', false, "no runSmoke provided — network/CSP claims UNVERIFIED", false);
  }

  const ok = failed.length === 0;
  const report = { ok, profile: capability.profile, checks };
  if (!ok) throw new SealError(`@gcu/seal: verify failed — ${failed.map((c) => c.name).join(', ')}`, report);
  return report;
}
