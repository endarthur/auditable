const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

// ── Helpers that mirror the browser-side logic ──

function extractSignature(html) {
  const m = html.match(/<!--AUDITABLE-SIGNATURE\n([\s\S]*?)\nAUDITABLE-SIGNATURE-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractRuntime(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!style || !script) return null;
  return { style: style[1], script: script[1] };
}

function buildSignedContent(style, script) {
  return 'AUDITABLE-SIGNED-CONTENT\n'
    + style + '\n'
    + 'AUDITABLE-STYLE-SCRIPT-BOUNDARY\n'
    + script;
}

function verifyEd25519(pubB64, sigB64, message) {
  const pubBytes = Buffer.from(pubB64, 'base64');
  // Wrap raw 32-byte key in SPKI DER
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = Buffer.concat([spkiPrefix, pubBytes]);
  const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const sigBytes = Buffer.from(sigB64, 'base64');
  return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, sigBytes);
}

function extractData(html) {
  const data = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  const settings = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  const modules = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  const title = html.match(/<title>([^<]*)<\/title>/);
  return {
    data: data ? data[0] : null,
    settings: settings ? settings[0] : null,
    modules: modules ? modules[0] : null,
    title: title ? title[1] : 'untitled',
  };
}

function reassemble(newHtml, oldData) {
  let html = newHtml;
  html = html.replace(/<!--AUDITABLE-DATA\n[\s\S]*?\nAUDITABLE-DATA-->\n?/g, '');
  html = html.replace(/<!--AUDITABLE-SETTINGS\n[\s\S]*?\nAUDITABLE-SETTINGS-->\n?/g, '');
  html = html.replace(/<!--AUDITABLE-MODULES\n[\s\S]*?\nAUDITABLE-MODULES-->\n?/g, '');

  const parts = [];
  if (oldData.data) parts.push(oldData.data);
  if (oldData.modules) parts.push(oldData.modules);
  if (oldData.settings) parts.push(oldData.settings);
  const dataBlock = parts.length ? '\n' + parts.join('\n') + '\n' : '';

  const sigIdx = html.indexOf('<!--AUDITABLE-SIGNATURE');
  const scriptIdx = html.indexOf('<script>');
  const insertIdx = sigIdx >= 0 ? sigIdx : scriptIdx;
  if (insertIdx >= 0) {
    html = html.slice(0, insertIdx) + dataBlock + html.slice(insertIdx);
  }
  return html;
}

// ── Generate a fresh test keypair ──

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  return {
    pub: pubRaw.toString('base64'),
    priv: privRaw.toString('base64'),
    publicKey,
    privateKey,
  };
}

// ── Tests ──

describe('keygen', () => {
  it('generates valid Ed25519 keypair and gh CLI commands', () => {
    const output = execSync('node keygen.js', { cwd: root, encoding: 'utf8' });
    assert.match(output, /gh variable set AUDITABLE_PUBLIC_KEY/);
    assert.match(output, /gh secret set ED25519_PRIVATE_KEY/);
    // Extract the base64 keys from the gh commands
    const pubMatch = output.match(/AUDITABLE_PUBLIC_KEY --body "([^"]+)"/);
    const privMatch = output.match(/ED25519_PRIVATE_KEY --body "([^"]+)"/);
    assert.ok(pubMatch, 'should contain public key gh command');
    assert.ok(privMatch, 'should contain private key gh command');
    assert.equal(Buffer.from(pubMatch[1], 'base64').length, 32, 'public key should be 32 bytes');
    assert.equal(Buffer.from(privMatch[1], 'base64').length, 32, 'private key seed should be 32 bytes');
  });
});

describe('sign.js', () => {
  const testFile = path.join(root, 'test', '_test_sign.html');

  it('signs an HTML file and injects signature comment', () => {
    const keys = generateTestKeypair();
    // Build a minimal auditable-like HTML
    const html = `<!DOCTYPE html>
<html><head><title>Test</title>
<style>body { color: red; }</style>
</head><body>
<script>console.log('hello');<\/script>
</body></html>`;
    fs.writeFileSync(testFile, html);

    execSync(`node sign.js "${testFile}" --key=${keys.priv}`, { cwd: root });

    const signed = fs.readFileSync(testFile, 'utf8');
    const sig = extractSignature(signed);
    assert.ok(sig, 'signature comment should exist');
    assert.equal(sig.v, 1);
    assert.equal(sig.alg, 'Ed25519');
    assert.equal(sig.pub, keys.pub);
    assert.ok(sig.sig.length > 10, 'signature should be non-trivial base64');

    // Clean up
    fs.unlinkSync(testFile);
  });

  it('produces a valid signature verifiable with the public key', () => {
    const keys = generateTestKeypair();
    const html = `<!DOCTYPE html>
<html><head><title>Test</title>
<style>.x { color: blue; }</style>
</head><body>
<script>const y = 42;<\/script>
</body></html>`;
    fs.writeFileSync(testFile, html);

    execSync(`node sign.js "${testFile}" --key=${keys.priv}`, { cwd: root });

    const signed = fs.readFileSync(testFile, 'utf8');
    const sig = extractSignature(signed);
    const runtime = extractRuntime(signed);
    assert.ok(runtime);

    const content = buildSignedContent(runtime.style, runtime.script);
    const valid = verifyEd25519(sig.pub, sig.sig, content);
    assert.ok(valid, 'signature should verify against signed content');

    fs.unlinkSync(testFile);
  });

  it('detects tampered content', () => {
    const keys = generateTestKeypair();
    const html = `<!DOCTYPE html>
<html><head><title>Test</title>
<style>.orig { margin: 0; }</style>
</head><body>
<script>const orig = true;<\/script>
</body></html>`;
    fs.writeFileSync(testFile, html);

    execSync(`node sign.js "${testFile}" --key=${keys.priv}`, { cwd: root });

    let signed = fs.readFileSync(testFile, 'utf8');

    // Tamper with the script content
    signed = signed.replace('const orig = true;', 'const orig = false;');

    const sig = extractSignature(signed);
    const runtime = extractRuntime(signed);
    const content = buildSignedContent(runtime.style, runtime.script);
    const valid = verifyEd25519(sig.pub, sig.sig, content);
    assert.ok(!valid, 'tampered content should NOT verify');

    fs.unlinkSync(testFile);
  });

  it('replaces existing signature on re-sign', () => {
    const keys = generateTestKeypair();
    const html = `<!DOCTYPE html>
<html><head><title>Test</title>
<style>a{}</style>
</head><body>
<script>1+1;<\/script>
</body></html>`;
    fs.writeFileSync(testFile, html);

    // Sign twice
    execSync(`node sign.js "${testFile}" --key=${keys.priv}`, { cwd: root });
    execSync(`node sign.js "${testFile}" --key=${keys.priv}`, { cwd: root });

    const signed = fs.readFileSync(testFile, 'utf8');
    const matches = signed.match(/<!--AUDITABLE-SIGNATURE/g);
    assert.equal(matches.length, 1, 'should have exactly one signature comment');

    fs.unlinkSync(testFile);
  });
});

describe('data extraction and reassembly', () => {
  it('extractData parses all comment blocks', () => {
    const html = `<!DOCTYPE html>
<html><head><title>Auditable \u2014 mynotebook</title></head><body>
<!--AUDITABLE-DATA
[{"type":"code","code":"x = 1"}]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
{"https://cdn.example.com/lib.js":"source code"}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{"theme":"dark","fontSize":13}
AUDITABLE-SETTINGS-->
<script>/*runtime*/<\/script>
</body></html>`;

    const data = extractData(html);
    assert.ok(data.data);
    assert.ok(data.modules);
    assert.ok(data.settings);
    assert.match(data.data, /AUDITABLE-DATA/);
    assert.match(data.modules, /cdn\.example\.com/);
    assert.match(data.settings, /fontSize/);
    assert.equal(data.title, 'Auditable \u2014 mynotebook');
  });

  it('reassemble injects old data into new template', () => {
    const newHtml = `<!DOCTYPE html>
<html><head><title>Auditable</title></head><body>
<!--AUDITABLE-SIGNATURE
{"v":1,"sig":"abc","pub":"xyz","alg":"Ed25519"}
AUDITABLE-SIGNATURE-->
<script>/*new runtime*/<\/script>
</body></html>`;

    const oldData = {
      data: '<!--AUDITABLE-DATA\n[{"type":"code","code":"hello"}]\nAUDITABLE-DATA-->',
      settings: '<!--AUDITABLE-SETTINGS\n{"theme":"light"}\nAUDITABLE-SETTINGS-->',
      modules: null,
      title: 'mynotebook',
    };

    const result = reassemble(newHtml, oldData);
    assert.match(result, /AUDITABLE-DATA/);
    assert.match(result, /AUDITABLE-SETTINGS/);
    assert.match(result, /hello/);
    assert.match(result, /new runtime/);
    // Data should be before signature
    const dataIdx = result.indexOf('AUDITABLE-DATA');
    const sigIdx = result.indexOf('AUDITABLE-SIGNATURE');
    assert.ok(dataIdx < sigIdx, 'data should appear before signature');
  });

  it('reassemble strips existing data from new template', () => {
    const newHtml = `<!DOCTYPE html>
<html><head><title>Auditable</title></head><body>
<!--AUDITABLE-DATA
[{"type":"code","code":"new data"}]
AUDITABLE-DATA-->
<!--AUDITABLE-SETTINGS
{"theme":"dark"}
AUDITABLE-SETTINGS-->
<script>/*runtime*/<\/script>
</body></html>`;

    const oldData = {
      data: '<!--AUDITABLE-DATA\n[{"type":"md","code":"# old"}]\nAUDITABLE-DATA-->',
      settings: '<!--AUDITABLE-SETTINGS\n{"theme":"light"}\nAUDITABLE-SETTINGS-->',
      modules: null,
      title: 'untitled',
    };

    const result = reassemble(newHtml, oldData);
    // Should have old data, not new data
    assert.match(result, /# old/);
    assert.ok(!result.includes('new data'), 'new template data should be replaced');
    assert.match(result, /light/);
    assert.ok(!result.includes('"dark"'), 'new template settings should be replaced');
  });
});

describe('full round-trip: build → sign → verify → update', () => {
  it('signed build verifies correctly via Node crypto', () => {
    const keys = generateTestKeypair();

    // Build with the test public key
    execSync(`node build.js`, {
      cwd: root,
      env: { ...process.env, AUDITABLE_PUBLIC_KEY: keys.pub },
    });

    // Sign with the test private key
    execSync(`node sign.js auditable.html --key=${keys.priv}`, { cwd: root });

    // Read the signed file
    const signed = fs.readFileSync(path.join(root, 'auditable.html'), 'utf8');

    // Verify public key was baked in
    assert.ok(signed.includes(keys.pub), 'public key should be embedded in script');

    // Extract and verify signature
    const sig = extractSignature(signed);
    assert.ok(sig, 'signature should be present');
    assert.equal(sig.pub, keys.pub);

    const runtime = extractRuntime(signed);
    assert.ok(runtime, 'runtime should be extractable');

    const content = buildSignedContent(runtime.style, runtime.script);
    const valid = verifyEd25519(sig.pub, sig.sig, content);
    assert.ok(valid, 'full build signature should verify');

    // Simulate an "update": extract data, reassemble into new runtime
    // Add some fake data to the signed file
    const withData = signed.replace(
      '<!--AUDITABLE-SIGNATURE',
      '<!--AUDITABLE-DATA\n[{"type":"code","code":"x = 42"}]\nAUDITABLE-DATA-->\n<!--AUDITABLE-SETTINGS\n{"theme":"dark"}\nAUDITABLE-SETTINGS-->\n<!--AUDITABLE-SIGNATURE'
    );

    const oldData = extractData(withData);
    assert.ok(oldData.data, 'should extract data');
    assert.ok(oldData.settings, 'should extract settings');

    // Reassemble: put old data into a fresh signed build
    const updated = reassemble(signed, oldData);
    assert.match(updated, /x = 42/, 'reassembled file should contain old cell data');
    assert.match(updated, /theme.*dark/, 'reassembled file should contain old settings');

    // The signature should still be present
    const updatedSig = extractSignature(updated);
    assert.ok(updatedSig, 'signature should survive reassembly');

    // Rebuild clean (without test key) to restore auditable.html
    execSync('node build.js', { cwd: root });
  });
});
