// Context-menu registry tests — EXTENSION_SPEC §3.8.2.
//
// The registry is intentionally import-dependency-free; tree.js builds
// the ctx object and passes it to dispatch. So this test imports the
// registry directly with no shims required.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  registerExtensionContextMenu,
  unregisterExtensionContextMenu,
  itemsForNode,
  dispatch,
  registerOpenActionForSurface,
  unregisterOpenActionForSurface,
  _resetForTests,
} = await import('../works/js/context-menu-registry.js');

beforeEach(() => _resetForTests());

describe('contextMenu registration + scope filtering', () => {
  it('register + itemsForNode returns the matching item', () => {
    let called = 0;
    registerExtensionContextMenu({
      name: '@test/show-schema',
      contextMenu: [{
        label: 'Show schema', scope: 'file',
        filter: (p) => p.endsWith('.parquet'),
        action: () => { called++; },
      }],
    });
    const items = itemsForNode('/data/a.parquet', 'file');
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Show schema');

    // Non-matching scope
    assert.equal(itemsForNode('/data', 'folder').length, 0);
    // Non-matching filter
    assert.equal(itemsForNode('/data/a.csv', 'file').length, 0);
  });

  it('items default to scope=file when omitted', () => {
    registerExtensionContextMenu({
      name: '@test/default-scope',
      contextMenu: [{ label: 'do', action: () => {} }],
    });
    assert.equal(itemsForNode('/x', 'file').length, 1);
    assert.equal(itemsForNode('/x', 'folder').length, 0);
  });

  it('multiple contributions appear in registration order', () => {
    registerExtensionContextMenu({
      name: '@test/a',
      contextMenu: [{ label: 'A1', scope: 'file', action: () => {} }],
    });
    registerExtensionContextMenu({
      name: '@test/b',
      contextMenu: [
        { label: 'B1', scope: 'file', action: () => {} },
        { label: 'B2', scope: 'file', action: () => {} },
      ],
    });
    const items = itemsForNode('/x', 'file');
    assert.deepEqual(items.map(i => i.label), ['A1', 'B1', 'B2']);
  });

  it('unregister drops every item from the manifest', () => {
    const manifest = {
      name: '@test/multi',
      contextMenu: [
        { label: 'X', scope: 'file', action: () => {} },
        { label: 'Y', scope: 'file', action: () => {} },
      ],
    };
    registerExtensionContextMenu(manifest);
    assert.equal(itemsForNode('/x', 'file').length, 2);
    unregisterExtensionContextMenu(manifest);
    assert.equal(itemsForNode('/x', 'file').length, 0);
  });

  it('filter that throws hides the item but does not break others', () => {
    registerExtensionContextMenu({
      name: '@test/broken',
      contextMenu: [{
        label: 'broken', scope: 'file',
        filter: () => { throw new Error('boom'); }, action: () => {},
      }],
    });
    registerExtensionContextMenu({
      name: '@test/works',
      contextMenu: [{
        label: 'works', scope: 'file', action: () => {},
      }],
    });
    const items = itemsForNode('/x', 'file');
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'works');
  });
});

describe('contextMenu dispatch', () => {
  it('action receives (path, ctx) and its return value is propagated', async () => {
    let captured = null;
    registerExtensionContextMenu({
      name: '@test/echo',
      contextMenu: [{
        label: 'echo', scope: 'file',
        action: (p, c) => { captured = { p, c }; return 'OK'; },
      }],
    });
    const items = itemsForNode('/x', 'file');
    const ctx = { dialog: {}, bus: null, vfs: null, setStatus: () => {} };
    const r = await dispatch(items[0].item, '/x', ctx);
    assert.equal(r, 'OK');
    assert.equal(captured.p, '/x');
    assert.equal(captured.c, ctx);
  });

  it('action errors are caught + reported via ctx.setStatus', async () => {
    const errs = [];
    const origErr = console.error;
    console.error = () => {};
    try {
      registerExtensionContextMenu({
        name: '@test/throws',
        contextMenu: [{
          label: 'fail', scope: 'file',
          action: () => { throw new Error('nope'); },
        }],
      });
      const items = itemsForNode('/x', 'file');
      let status = null;
      await dispatch(items[0].item, '/x', { setStatus: (s) => { status = s; } });
      assert.match(status, /"fail" failed: nope/);
    } finally {
      console.error = origErr;
    }
  });
});

describe('openAction sugar', () => {
  it('registers a synthetic Open-in item filtered by surface extensions', () => {
    registerOpenActionForSurface('data-grid', {
      label: 'Data Grid',
      extensions: ['.parquet', '.arrow'],
      openAction: true,
    });
    const items = itemsForNode('/data/a.parquet', 'file');
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Open in Data Grid');
    assert.match(items[0].key, /^_openin:data-grid$/);
    assert.equal(itemsForNode('/data/a.csv', 'file').length, 0);
  });

  it('extensions matched case-insensitively', () => {
    registerOpenActionForSurface('data-grid-2', {
      label: 'Grid',
      extensions: ['.parquet'],
      openAction: true,
    });
    assert.equal(itemsForNode('/X/A.PARQUET', 'file').length, 1);
  });

  it('skipped entirely when openAction: false', () => {
    registerOpenActionForSurface('quiet-surface', {
      label: 'Quiet',
      extensions: ['.foo'],
      openAction: false,
    });
    assert.equal(itemsForNode('/x.foo', 'file').length, 0);
  });

  it('unregister drops the synthetic item', () => {
    registerOpenActionForSurface('grid3', {
      label: 'G3', extensions: ['.x'], openAction: true,
    });
    assert.equal(itemsForNode('/y.x', 'file').length, 1);
    unregisterOpenActionForSurface('grid3');
    assert.equal(itemsForNode('/y.x', 'file').length, 0);
  });

  it('openAction items dispatch via ctx.spawnSurface', async () => {
    let captured = null;
    registerOpenActionForSurface('grid4', {
      label: 'G4', extensions: ['.foo'], openAction: true,
    });
    const items = itemsForNode('/file.foo', 'file');
    const ctx = {
      spawnSurface: (kind, opts) => { captured = { kind, opts }; },
      setStatus: () => {},
    };
    await dispatch(items[0].item, '/file.foo', ctx);
    assert.equal(captured.kind, 'grid4');
    assert.equal(captured.opts.path, '/file.foo');
  });
});
