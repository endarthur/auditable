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

// ── manifest.requires — cross-extension dependency check (EXTENSION_SPEC.md §2.4) ──

describe('registerExtension — manifest.requires', () => {
  // Note: we don't have a clean way to unregister between tests in this
  // harness, so each test uses uniquely-named manifests to avoid bleed.

  it('passes when no requires field', () => {
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-empty', version: '0.1.0',
    }));
  });

  it('passes when requires is satisfied (exact)', () => {
    registerExtension({ name: '@test/req-base-1', version: '1.2.3' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-dep-1', version: '0.1.0',
      requires: { '@test/req-base-1': '1.2.3' },
    }));
  });

  it('passes when requires is satisfied (>=)', () => {
    registerExtension({ name: '@test/req-base-gte', version: '1.5.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-dep-gte', version: '0.1.0',
      requires: { '@test/req-base-gte': '>=1.0.0' },
    }));
  });

  it('passes when requires is satisfied (^ — locked major)', () => {
    registerExtension({ name: '@test/req-base-caret', version: '1.5.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-dep-caret', version: '0.1.0',
      requires: { '@test/req-base-caret': '^1.0.0' },
    }));
  });

  it('passes when requires is satisfied (~ — locked minor)', () => {
    registerExtension({ name: '@test/req-base-tilde', version: '1.2.9' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-dep-tilde', version: '0.1.0',
      requires: { '@test/req-base-tilde': '~1.2.0' },
    }));
  });

  it('passes when requires is *', () => {
    registerExtension({ name: '@test/req-base-star', version: '0.0.1' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-dep-star', version: '0.1.0',
      requires: { '@test/req-base-star': '*' },
    }));
  });

  it('throws on missing dep', () => {
    assert.throws(
      () => registerExtension({
        name: '@test/req-missing-dep', version: '0.1.0',
        requires: { '@test/never-installed': '>=1.0.0' },
      }),
      /requires "@test\/never-installed" >=1\.0\.0 but it is not registered/,
    );
  });

  it('throws on out-of-range version (exact)', () => {
    registerExtension({ name: '@test/req-oor-exact', version: '1.2.3' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-oor-exact-dep', version: '0.1.0',
        requires: { '@test/req-oor-exact': '1.2.4' },
      }),
      /requires "@test\/req-oor-exact" 1\.2\.4 but 1\.2\.3 is registered/,
    );
  });

  it('throws on out-of-range version (^ — major mismatch)', () => {
    registerExtension({ name: '@test/req-oor-caret', version: '2.0.0' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-oor-caret-dep', version: '0.1.0',
        requires: { '@test/req-oor-caret': '^1.0.0' },
      }),
      /requires "@test\/req-oor-caret" \^1\.0\.0 but 2\.0\.0 is registered/,
    );
  });

  it('throws on out-of-range version (~ — minor mismatch)', () => {
    registerExtension({ name: '@test/req-oor-tilde', version: '1.3.0' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-oor-tilde-dep', version: '0.1.0',
        requires: { '@test/req-oor-tilde': '~1.2.0' },
      }),
      /requires "@test\/req-oor-tilde" ~1\.2\.0 but 1\.3\.0 is registered/,
    );
  });

  it('throws on > when version equals target', () => {
    registerExtension({ name: '@test/req-gt-eq', version: '1.0.0' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-gt-eq-dep', version: '0.1.0',
        requires: { '@test/req-gt-eq': '>1.0.0' },
      }),
      /requires "@test\/req-gt-eq" >1\.0\.0 but 1\.0\.0 is registered/,
    );
  });

  it('throws on malformed requires shape — array', () => {
    assert.throws(
      () => registerExtension({
        name: '@test/req-bad-shape-array', version: '0.1.0',
        requires: ['@gcu/foo'],
      }),
      /requires must be an object/,
    );
  });

  it('throws on malformed requires shape — non-string range', () => {
    assert.throws(
      () => registerExtension({
        name: '@test/req-bad-shape-nonstr', version: '0.1.0',
        requires: { '@gcu/foo': 1 },
      }),
      /requires\["@gcu\/foo"\] must be a non-empty range string/,
    );
  });

  it('throws on unrecognized range syntax', () => {
    assert.throws(
      () => registerExtension({
        name: '@test/req-bad-range', version: '0.1.0',
        requires: { '@gcu/foo': '~~1.0' },
      }),
      /requires\["@gcu\/foo"\] = "~~1\.0" is not a recognized range/,
    );
  });

  it('rejects disjunction (|| not in supported subset)', () => {
    assert.throws(
      () => registerExtension({
        name: '@test/req-disjunction', version: '0.1.0',
        requires: { '@gcu/foo': '1.0.0 || 2.0.0' },
      }),
      /is not a recognized range/,
    );
  });

  // ── x-range support (EXTENSION_SPEC §2.4 — added per carotte's CLAUDE.md §3.1) ──

  it('passes for bare x-range "0.x" (caret-equivalent — any 0.x)', () => {
    registerExtension({ name: '@test/req-xfull-base', version: '0.5.3' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-xfull-dep', version: '0.1.0',
      requires: { '@test/req-xfull-base': '0.x' },
    }));
  });

  it('rejects bare x-range when major doesn\'t match', () => {
    registerExtension({ name: '@test/req-xfull-mismatch', version: '1.5.0' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-xfull-mismatch-dep', version: '0.1.0',
        requires: { '@test/req-xfull-mismatch': '0.x' },
      }),
      /requires "@test\/req-xfull-mismatch" 0\.x but 1\.5\.0 is registered/,
    );
  });

  it('passes for bare x-range "1.2.x" (tilde-equivalent — any patch in 1.2)', () => {
    registerExtension({ name: '@test/req-xminor-base', version: '1.2.9' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-xminor-dep', version: '0.1.0',
      requires: { '@test/req-xminor-base': '1.2.x' },
    }));
  });

  it('rejects "1.2.x" when minor differs', () => {
    registerExtension({ name: '@test/req-xminor-mismatch', version: '1.3.0' });
    assert.throws(
      () => registerExtension({
        name: '@test/req-xminor-mismatch-dep', version: '0.1.0',
        requires: { '@test/req-xminor-mismatch': '1.2.x' },
      }),
      /1\.2\.x but 1\.3\.0 is registered/,
    );
  });

  it('passes for ">=0.x" (lower-bound only, no upper)', () => {
    // ">=0.x" means ">=0.0.0" — the x just becomes 0 for the lower bound;
    // the >= drops the upper bound an x-range would otherwise imply.
    // This is the form carotte's pack-gcupkg.js emits.
    registerExtension({ name: '@test/req-gtex-base', version: '5.0.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-gtex-dep', version: '0.1.0',
      requires: { '@test/req-gtex-base': '>=0.x' },
    }));
  });

  it('passes for x-range with redundant .x.x', () => {
    // "0.x.x" is equivalent to "0.x" — both mean caret on the major.
    registerExtension({ name: '@test/req-xx-base', version: '0.7.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-xx-dep', version: '0.1.0',
      requires: { '@test/req-xx-base': '0.x.x' },
    }));
  });

  it('passes for capital X as a wildcard', () => {
    registerExtension({ name: '@test/req-X-base', version: '0.5.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-X-dep', version: '0.1.0',
      requires: { '@test/req-X-base': '0.X' },
    }));
  });

  it('passes for bare "x" (equivalent to *)', () => {
    registerExtension({ name: '@test/req-x-base', version: '99.0.0' });
    assert.doesNotThrow(() => registerExtension({
      name: '@test/req-x-dep', version: '0.1.0',
      requires: { '@test/req-x-base': 'x' },
    }));
  });

  it('checks requires BEFORE applying contributions (fail-fast invariant)', () => {
    // If the contribution were applied first then the check ran, a failed
    // register would leave the cell-type wired even though the extension
    // "didn't register." Verify the cell-type isn't in _cellTypes after a
    // requires failure.
    assert.throws(() => registerExtension({
      name: '@test/req-failfast', version: '0.1.0',
      requires: { '@test/req-failfast-missing': '>=1.0.0' },
      cellType: {
        name: 'failfast-celltype',
        capabilities: { executable: true, definesScope: false, hasOutput: false, hasEditor: true },
        execute: () => {},
      },
    }));
    assert.equal(window._cellTypes['failfast-celltype'], undefined,
      'cellType should NOT have been wired when requires failed');
  });

  it('reports the requiring extension name in the error', () => {
    // Good error messages name BOTH the requiring extension and the dep.
    assert.throws(
      () => registerExtension({
        name: '@test/req-namedinerror', version: '0.1.0',
        requires: { '@test/req-namedinerror-missing': '>=1.0.0' },
      }),
      /"@test\/req-namedinerror" requires/,
    );
  });
});
