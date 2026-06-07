// mcp-access.test.mjs — the pure MCP access-level decision (mcp-access.js).
// Locks the "open to read, gated to act" posture + directive/manifest precedence.

// dag.js (imported by mcp-access.js) pulls state.js, which touches document.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccess, readable } from '../src/js/mcp-access.js';

const A = (code, manifest = null, idx = 0, name = null) => resolveAccess(code, manifest, idx, name);

test('default posture is read-open (no directive, no manifest)', () => {
  assert.equal(A('const x = 1;'), 'open');
  assert.equal(A(''), 'open');
});

test('explicit cell directives', () => {
  assert.equal(A('// %private\nx=1'), 'private');
  assert.equal(A('// %mcp\nx=1'), 'read');
  assert.equal(A('// %mcp rw\nx=1'), 'rw');
  assert.equal(A('// %mcp manifest\n({ defaults: "open" })'), 'private'); // the manifest cell itself
});

test('%mcp rw wins over %mcp (order)', () => {
  // a cell carrying the rw directive resolves to rw, not read
  assert.equal(A('// %mcp rw\nx=1'), 'rw');
});

test('manifest defaults set the baseline', () => {
  assert.equal(A('x=1', { defaults: 'rw' }), 'rw');
  assert.equal(A('x=1', { defaults: 'read' }), 'read');
  assert.equal(A('x=1', { defaults: 'r' }), 'read');
  assert.equal(A('x=1', { defaults: 'open' }), 'open');
  assert.equal(A('x=1', { defaults: 'private' }), 'none', 'strict: hidden until annotated');
  assert.equal(A('x=1', { defaults: 'strict' }), 'none');
  assert.equal(A('x=1', { defaults: 'none' }), 'none');
  assert.equal(A('x=1', {}), 'open', 'manifest present but no defaults → still open');
});

test('cell directive beats manifest defaults', () => {
  assert.equal(A('// %private\nx=1', { defaults: 'rw' }), 'private');
  assert.equal(A('// %mcp rw\nx=1', { defaults: 'private' }), 'rw');
  assert.equal(A('// %mcp\nx=1', { defaults: 'private' }), 'read');
});

test('manifest tool-level access binds by index or name, and beats defaults', () => {
  assert.equal(A('x=1', { tools: { t: { cell: 2, access: 'rw' } } }, 2), 'rw');
  assert.equal(A('x=1', { tools: { t: { cell: 'foo', access: 'read' } } }, 9, 'foo'), 'read');
  assert.equal(A('x=1', { tools: { t: { cell: 0, access: 'private' } } }, 0), 'private');
  // tool bound to a DIFFERENT cell → falls through to defaults (open here)
  assert.equal(A('x=1', { tools: { t: { cell: 7, access: 'rw' } } }, 0), 'open');
  // tool-level beats a manifest default
  assert.equal(A('x=1', { tools: { t: { cell: 0, access: 'read' } }, defaults: 'rw' }, 0), 'read');
});

test('readable(): visible levels are read/rw/open', () => {
  assert.equal(readable('open'), true);
  assert.equal(readable('read'), true);
  assert.equal(readable('rw'), true);
  assert.equal(readable('private'), false);
  assert.equal(readable('none'), false);
});
