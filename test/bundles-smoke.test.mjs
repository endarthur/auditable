// Parse-time smoke test for every ext/<name>/index.js — load each bundle
// as an ESM module, assert it doesn't throw SyntaxError. Runtime errors
// from missing browser globals (window, document, CodeMirror, Acorn, …)
// are tolerated: most bundles target a browser context and reach for
// globals that Node doesn't supply.
//
// The thing this catches that unit tests can't:
// concat-time identifier collisions. test/<ext>.test.mjs files exercise
// SOURCE files via `import '../ext/<name>/src/main.js'`. The concat'd
// worker bundle (ext/<name>/index.js) is only loaded at actual boot in
// the browser/worker — a duplicate top-level `const tokenize` between
// two prepended bundles slips past every unit test, but the parser
// rejects it at module-load time as SyntaxError. This test runs that
// rejection check in Node.
//
// History: surfaced because the licenses-prepend in geas's bundle (commit
// ad85d20) collided with geas's own `tokenize` and `formatTable` exports;
// the unit suite stayed green and the regression only showed up when the
// user typed `welcome to geas` in works (commit bfc64a57 fixed it via
// IIFE isolation + _lic prefix). This test would have caught it at
// `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..', 'ext');

// Discover ext/<name>/index.js bundles. Skip ext/<name>/ that don't have
// one (still source-only or scheduled for a future build).
function discoverBundles() {
  const out = [];
  for (const name of fs.readdirSync(extDir).sort()) {
    const idx = path.join(extDir, name, 'index.js');
    if (fs.existsSync(idx)) out.push({ name, path: idx });
  }
  return out;
}

const bundles = discoverBundles();

// Per-bundle test. Treat a SyntaxError as failure; treat any other error
// (ReferenceError, TypeError from missing browser globals, etc.) as a
// successful parse — the bundle is structurally fine, it just can't
// fully evaluate in Node. That's expected for browser-targeted bundles.
for (const { name, path: bundlePath } of bundles) {
  test(`bundle parses: ext/${name}/index.js`, async () => {
    const url = pathToFileURL(bundlePath).href;
    let parseError = null;
    let runtimeError = null;
    try {
      await import(url);
    } catch (e) {
      if (e instanceof SyntaxError) parseError = e;
      else runtimeError = e;
    }
    // The assertion: no SyntaxError. A runtime error is fine and gets
    // recorded silently; we don't enforce that the bundle fully boots
    // in Node, only that it parses.
    if (parseError) {
      // Re-throw with bundle name in the message so the failure line is
      // diagnosable without scrolling up.
      throw new Error(
        `ext/${name}/index.js: SyntaxError at parse time — ` + parseError.message);
    }
    // Sanity: at least one bundle existed.
    assert.ok(true, runtimeError ? `(needs browser globals — ${runtimeError.message.slice(0, 80)})` : '(loaded fully)');
  });
}

// Sanity check: there's at least one bundle to load. If this fires the
// discovery glob is broken, which would silently turn the whole smoke
// test into a no-op.
test('bundles-smoke: discovery found at least one bundle', () => {
  assert.ok(bundles.length > 0, 'no ext/*/index.js bundles discovered');
});
