// Manifest-based extension API tests.
//
// Spec: spec_inbox/auditable-extension-api-spec.md (roadmap C).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── shim DOM ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    addEventListener() {},
    appendChild() {},
    remove() {},
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { contains() { return false; } } },
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 } });

window._cellTypes = {};
window._taggedLanguages = {};
window._auditableExtensions = {};
window._auditablePlugins = new Map();
window._cellContextHooks = [];

await import('../src/js/state.js');
const {
  registerExtension,
  getExtension,
  listExtensions,
  getCellType,
  getTaggedLanguage,
  getExports,
  hasExports,
  _ctIsExecutable,
  _ctDefinesScope,
  _ctHasOutput,
  _ctHasEditor,
  _ctIsBuiltin,
} = await import('../src/js/cell-types.js');

describe('registerExtension — validation', () => {
  it('rejects null/non-object manifest', () => {
    assert.throws(() => registerExtension(null), /must be an object/);
    assert.throws(() => registerExtension('string'), /must be an object/);
  });

  it('requires name', () => {
    assert.throws(() => registerExtension({ version: '1.0.0' }), /name is required/);
  });

  it('requires semver-shaped version', () => {
    assert.throws(() => registerExtension({ name: 'x', version: '1' }), /must be semver/);
    assert.throws(() => registerExtension({ name: 'x', version: 'v1.0.0' }), /must be semver/);
  });

  it('rejects shadowing built-in cell types', () => {
    assert.throws(() =>
      registerExtension({
        name: 'shadow',
        version: '1.0.0',
        cellType: { name: 'code', capabilities: { executable: true } },
      }), /built-in cell type "code" cannot be shadowed/);
  });

  it('cellType requires capabilities', () => {
    assert.throws(() =>
      registerExtension({
        name: 'no-caps',
        version: '1.0.0',
        cellType: { name: 'foo' },
      }), /cellType\.capabilities is required/);
  });

  it('executable: true requires execute()', () => {
    assert.throws(() =>
      registerExtension({
        name: 'no-exec',
        version: '1.0.0',
        cellType: { name: 'foo', capabilities: { executable: true } },
      }), /declares executable: true but provides no execute/);
  });

  it('definesScope: true requires parseNames()', () => {
    assert.throws(() =>
      registerExtension({
        name: 'no-pn',
        version: '1.0.0',
        cellType: {
          name: 'foo',
          capabilities: { definesScope: true, executable: true },
          execute: async () => ({}),
        },
      }), /declares definesScope: true but provides no parseNames/);
  });

  it('taggedLanguage requires tokenize', () => {
    assert.throws(() =>
      registerExtension({
        name: 'tl-no-tok',
        version: '1.0.0',
        taggedLanguage: { name: 'foo' },
      }), /requires tokenize/);
  });
});

describe('registerExtension — happy path', () => {
  it('cellType + taggedLanguage + exports together', () => {
    registerExtension({
      name: '@gcu/sample',
      version: '0.1.0',
      cellType: {
        name: 'sample',
        label: 'Sample',
        capabilities: { executable: true, definesScope: true, hasOutput: true, hasEditor: true },
        parseNames: () => new Set(),
        findUses: () => new Set(),
        execute: async () => ({}),
      },
      taggedLanguage: {
        name: 'sample',
        tokenize: () => [],
      },
      exports: { sampleHelper: 42 },
    });
    assert.equal(getExtension('@gcu/sample').cellType.name, 'sample');
    assert.equal(getCellType('sample').label, 'Sample');
    assert.ok(getTaggedLanguage('sample'));
    assert.equal(getExports('sampleHelper'), 42);
    assert.ok(hasExports('sampleHelper'));
  });

  it('listExtensions includes registered manifests + built-ins', () => {
    const all = listExtensions();
    const names = all.map(m => m.name);
    assert.ok(names.includes('auditable:builtin/code'));
    assert.ok(names.includes('auditable:builtin/md'));
    assert.ok(names.includes('auditable:builtin/css'));
    assert.ok(names.includes('auditable:builtin/html'));
  });

  it('multiple taggedLanguages', () => {
    registerExtension({
      name: '@gcu/multi-tag',
      version: '0.1.0',
      taggedLanguages: [
        { name: 'tagA', tokenize: () => [] },
        { name: 'tagB', tokenize: () => [] },
      ],
    });
    assert.ok(getTaggedLanguage('tagA'));
    assert.ok(getTaggedLanguage('tagB'));
  });

  it('contextHook is appended to _cellContextHooks', () => {
    const hookFn = (cell, ctx) => { ctx.foo = 'bar'; };
    const before = window._cellContextHooks.length;
    registerExtension({
      name: '@gcu/ctxhook-test',
      version: '0.1.0',
      contextHook: { setup: hookFn },
    });
    assert.equal(window._cellContextHooks.length, before + 1);
    assert.equal(window._cellContextHooks[before].setup, hookFn);
  });

  it('description + pluginUrl populate _auditablePlugins', () => {
    registerExtension({
      name: '@gcu/desc-test',
      version: '0.1.0',
      description: 'a test plugin',
      pluginUrl: 'https://example.com/plugin.js',
    });
    assert.equal(window._auditablePlugins.get('https://example.com/plugin.js').description, 'a test plugin');
  });

  it('re-registering same manifest name warns and replaces', () => {
    const origWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      registerExtension({ name: '@gcu/replace-test', version: '0.1.0', exports: { v: 1 } });
      registerExtension({ name: '@gcu/replace-test', version: '0.2.0', exports: { v: 2 } });
    } finally { console.warn = origWarn; }
    assert.equal(warned, true);
    assert.equal(getExports('v'), 2);
  });

  it('onActivate fires once on registration', () => {
    let called = 0;
    registerExtension({
      name: '@gcu/activate-test',
      version: '0.1.0',
      onActivate: () => { called++; },
    });
    assert.equal(called, 1);
  });
});

describe('built-in cell types via manifests', () => {
  it('getCellType("code") returns a manifest-shaped cellType', () => {
    const ct = getCellType('code');
    assert.ok(ct);
    assert.equal(ct.name, 'code');
    assert.ok(ct.capabilities);
    assert.equal(ct.capabilities.builtin, true);
    assert.equal(ct.capabilities.executable, true);
  });

  it('built-in capability checks match the legacy semantics', () => {
    assert.equal(_ctIsExecutable('code'), true);
    assert.equal(_ctIsExecutable('html'), true);
    assert.equal(_ctIsExecutable('md'), false);
    assert.equal(_ctIsExecutable('css'), false);

    assert.equal(_ctDefinesScope('code'), true);
    assert.equal(_ctDefinesScope('html'), true);
    assert.equal(_ctDefinesScope('md'), false);
    assert.equal(_ctDefinesScope('css'), false);

    assert.equal(_ctHasOutput('code'), true);
    assert.equal(_ctHasOutput('html'), true);
    assert.equal(_ctHasOutput('md'), false);
    assert.equal(_ctHasOutput('css'), false);

    assert.equal(_ctHasEditor('code'), true);
    assert.equal(_ctHasEditor('md'), true);
    assert.equal(_ctHasEditor('css'), true);
    assert.equal(_ctHasEditor('html'), true);
  });

  it('_ctIsBuiltin matches', () => {
    assert.ok(_ctIsBuiltin('code'));
    assert.ok(_ctIsBuiltin('md'));
    assert.ok(_ctIsBuiltin('css'));
    assert.ok(_ctIsBuiltin('html'));
    assert.ok(!_ctIsBuiltin('python'));
  });
});
