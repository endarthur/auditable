// Dispatch helpers + DAG plugin-cell integration tests.
//
// Manifest-API-level tests live in test/extensions.test.mjs. This file
// keeps the helper / DAG integration coverage that the manifest tests
// don't reach.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── shim DOM ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    closest: () => null,
    cloneNode() { return this; },
    get outerHTML() { return '<div></div>'; },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { contains() { return false; } } },
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };
try { globalThis.navigator = { hardwareConcurrency: 4 }; } catch {}
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 } });

const { S } = await import('../src/js/state.js');

window._cellTypes = {};
window._auditableExtensions = {};
window._auditablePlugins = new Map();

const {
  registerExtension,
  _ctGetHandler,
  _ctIsPlugin,
  _ctIsFallback,
  _ctIsBuiltin,
  _ctAllTypeNames,
  _ctRegisteredTypes,
  _ctRenderOutput,
} = await import('../src/js/cell-types.js');

// Helper: register a plugin cell type via manifest (replaces legacy registerCellType in tests).
function _testRegisterCellType(name, handler, opts = {}) {
  registerExtension({
    name: opts.pluginUrl || `test:${name}`,
    version: '0.0.0',
    cellType: {
      name,
      label: handler.label || name,
      capabilities: {
        executable: !!handler.execute,
        definesScope: !!handler.parseNames,
        hasOutput: !!handler.execute,
        hasEditor: !!(handler.createEditor || handler.tokenize),
        builtin: false,
      },
      parseNames: handler.parseNames,
      findUses: handler.findUses,
      execute: handler.execute,
      tokenize: handler.tokenize,
      createEditor: handler.createEditor,
    },
    pluginUrl: opts.pluginUrl,
  });
}

describe('dispatch helpers', () => {
  beforeEach(() => {
    for (const key of Object.keys(window._cellTypes)) delete window._cellTypes[key];
  });

  it('_ctGetHandler returns the handler shape for plugin types', () => {
    _testRegisterCellType('test-lang', {
      label: 'test', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}),
    });
    const h = _ctGetHandler('test-lang');
    assert.ok(h);
    assert.equal(h.label, 'test');
    assert.equal(_ctGetHandler('unknown'), null);
  });

  it('_ctIsPlugin', () => {
    _testRegisterCellType('test-p', {
      label: 'tp', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}),
    });
    assert.ok(_ctIsPlugin('test-p'));
    assert.ok(!_ctIsPlugin('code'));
    assert.ok(!_ctIsPlugin('unknown-no-handler'));
  });

  it('_ctIsBuiltin', () => {
    assert.ok(_ctIsBuiltin('code'));
    assert.ok(_ctIsBuiltin('md'));
    assert.ok(_ctIsBuiltin('css'));
    assert.ok(_ctIsBuiltin('html'));
    assert.ok(!_ctIsBuiltin('python'));
  });

  it('_ctAllTypeNames includes builtins and registered', () => {
    _testRegisterCellType('test-all', {
      label: 'ta', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}),
    });
    const all = _ctAllTypeNames();
    assert.ok(all.includes('code'));
    assert.ok(all.includes('md'));
    assert.ok(all.includes('css'));
    assert.ok(all.includes('html'));
    assert.ok(all.includes('test-all'));
  });

  it('_ctIsFallback checks cell._fallback', () => {
    assert.ok(_ctIsFallback({ _fallback: true }));
    assert.ok(!_ctIsFallback({ _fallback: false }));
    assert.ok(!_ctIsFallback({}));
  });
});

describe('DAG dispatch for plugin cells', () => {
  beforeEach(() => {
    for (const key of Object.keys(window._cellTypes)) delete window._cellTypes[key];
    S.cells.length = 0;
  });

  it('buildDAG calls handler.parseNames for plugin cells', async () => {
    const { buildDAG } = await import('../src/js/dag.js');
    let parseNamesCalls = 0;
    _testRegisterCellType('dpc-lang', {
      label: 'dpc',
      parseNames: () => { parseNamesCalls++; return new Set(['x']); },
      findUses: () => new Set(),
      execute: async () => ({}),
    });
    S.cells.push({ id: 1, type: 'dpc-lang', code: 'x = 1', defines: new Set(), uses: new Set() });
    buildDAG();
    assert.ok(parseNamesCalls > 0);
  });

  it('skips fallback cells in buildDAG', async () => {
    const { buildDAG } = await import('../src/js/dag.js');
    S.cells.push({ id: 2, type: 'unknown', code: 'something', _fallback: true, defines: new Set(), uses: new Set() });
    // Should not throw — fallback cells contribute nothing.
    buildDAG();
    assert.ok(true);
  });
});
