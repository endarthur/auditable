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

// ── import ──
const { S } = await import('../src/js/state.js');

// reset window state
window._cellTypes = {};
window._auditableExtensions = {};
window._auditablePlugins = new Map();

const {
  registerCellType,
  registerExtension,
  hasExtension,
  getExtension,
  registerPlugin,
  _ctGetHandler,
  _ctIsPlugin,
  _ctIsFallback,
  _ctIsBuiltin,
  _ctAllTypeNames,
  _ctRegisteredTypes,
  _ctRenderOutput,
} = await import('../src/js/cell-types.js');

describe('registerCellType', () => {
  beforeEach(() => {
    // clear registrations
    for (const key of Object.keys(window._cellTypes)) delete window._cellTypes[key];
  });

  it('registers a handler', () => {
    const handler = {
      label: 'python',
      color: '#4B8BBE',
      shortcut: 'p',
      parseNames: () => new Set(),
      findUses: () => new Set(),
      execute: async () => ({ defines: {} }),
    };
    registerCellType('python', handler);
    assert.strictEqual(window._cellTypes['python'], handler);
  });

  it('rejects built-in type names', () => {
    const handler = { label: 'code', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) };
    registerCellType('code', handler);
    assert.strictEqual(window._cellTypes['code'], undefined);
    registerCellType('md', handler);
    assert.strictEqual(window._cellTypes['md'], undefined);
    registerCellType('css', handler);
    assert.strictEqual(window._cellTypes['css'], undefined);
    registerCellType('html', handler);
    assert.strictEqual(window._cellTypes['html'], undefined);
  });

  it('first registration wins', () => {
    const h1 = { label: 'first', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) };
    const h2 = { label: 'second', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) };
    registerCellType('lua', h1);
    registerCellType('lua', h2);
    assert.strictEqual(window._cellTypes['lua'].label, 'first');
  });

  it('tracks plugin URL', () => {
    const handler = { label: 'r', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) };
    registerCellType('r', handler, '@gcu/r-lang');
    assert.strictEqual(handler._pluginUrl, '@gcu/r-lang');
  });
});

describe('registerExtension / hasExtension / getExtension', () => {
  beforeEach(() => {
    window._auditableExtensions = {};
  });

  it('round-trips', () => {
    const exports = { foo: 42, bar: () => {} };
    registerExtension('test-ext', exports);
    assert.ok(hasExtension('test-ext'));
    assert.strictEqual(getExtension('test-ext'), exports);
    assert.strictEqual(getExtension('test-ext').foo, 42);
  });

  it('returns false/null for missing', () => {
    assert.ok(!hasExtension('nope'));
    assert.strictEqual(getExtension('nope'), null);
  });
});

describe('registerPlugin', () => {
  beforeEach(() => {
    window._auditablePlugins = new Map();
  });

  it('adds to map', () => {
    registerPlugin('@gcu/adder', { description: 'python cells' });
    assert.ok(window._auditablePlugins.has('@gcu/adder'));
    assert.strictEqual(window._auditablePlugins.get('@gcu/adder').description, 'python cells');
  });
});

describe('dispatch helpers', () => {
  beforeEach(() => {
    for (const key of Object.keys(window._cellTypes)) delete window._cellTypes[key];
  });

  it('_ctGetHandler returns handler for registered type', () => {
    const handler = { label: 'test', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) };
    registerCellType('test-lang', handler);
    assert.strictEqual(_ctGetHandler('test-lang'), handler);
    assert.strictEqual(_ctGetHandler('unknown'), null);
  });

  it('_ctIsPlugin', () => {
    registerCellType('test-p', { label: 'tp', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) });
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
    registerCellType('test-all', { label: 'ta', parseNames: () => new Set(), findUses: () => new Set(), execute: async () => ({}) });
    const names = _ctAllTypeNames();
    assert.ok(names.includes('code'));
    assert.ok(names.includes('md'));
    assert.ok(names.includes('test-all'));
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
    S.cells = [];
  });

  it('buildDAG calls handler.parseNames for plugin cells', async () => {
    const { buildDAG } = await import('../src/js/dag.js');

    const parseNamesCalled = [];
    const findUsesCalled = [];

    registerCellType('test-dag', {
      label: 'dag-test',
      parseNames: (code) => {
        parseNamesCalled.push(code);
        // extract `x = ...` style defines
        const defines = new Set();
        const re = /^(\w+)\s*=/gm;
        let m;
        while ((m = re.exec(code))) defines.add(m[1]);
        return defines;
      },
      findUses: (code, allDefined) => {
        findUsesCalled.push({ code, allDefined });
        const uses = new Set();
        for (const name of allDefined) {
          if (code.includes(name)) uses.add(name);
        }
        return uses;
      },
      execute: async () => ({ defines: {} }),
    });

    S.cells = [
      { id: 0, type: 'code', code: 'const a = 1', defines: new Set(), uses: new Set() },
      { id: 1, type: 'test-dag', code: 'b = a + 1', defines: new Set(), uses: new Set() },
    ];

    buildDAG();

    assert.ok(parseNamesCalled.length > 0);
    assert.ok(S.cells[1].defines.has('b'));
    assert.ok(findUsesCalled.length > 0);
    assert.ok(S.cells[1].uses.has('a'));
  });

  it('skips fallback cells in buildDAG', async () => {
    const { buildDAG } = await import('../src/js/dag.js');

    S.cells = [
      { id: 0, type: 'unknown-type', code: 'x = 1', _fallback: true, defines: new Set(), uses: new Set() },
    ];

    const allDefined = buildDAG();
    assert.ok(!allDefined.has('x'));
  });
});
