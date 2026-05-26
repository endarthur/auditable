// Extension-surfaces tests — registration with VFS-backed surface HTML,
// snapshot persistence, and boot-time rehydration. EXTENSION_SPEC §3.8.
//
// extension-surfaces.js imports './state.js' (WKS) and './surface-registry.js'.
// We pre-populate a stub state and shim document/URL before importing.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};
const _revoked = [];
globalThis.URL = {
  createObjectURL: (blob) => 'blob:test-' + Math.random().toString(36).slice(2, 8),
  revokeObjectURL: (url) => _revoked.push(url),
};
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };

// In-memory stub VFS — readdir/stat/readFile/writeFile shaped like
// CommentBackend's surface. Tracks writes so tests can assert the
// snapshot was persisted.
function makeFakeVfs() {
  const files = new Map();   // path → Uint8Array | string
  return {
    files,
    async readFile(p, enc) {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      const v = files.get(p);
      if (enc === 'utf8') return typeof v === 'string' ? v : new TextDecoder().decode(v);
      return v;
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : p + '/';
      const names = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        names.add(rest.split('/')[0]);
      }
      return [...names];
    },
    async stat(p) {
      if (files.has(p)) return { type: 'file', size: 0 };
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) return { type: 'directory', size: 0 };
      }
      throw new Error('ENOENT ' + p);
    },
    async mkdir() {},
  };
}

// Bootstrap modules — state must be present before extension-surfaces
// imports from it.
const stateMod = await import('../works/js/state.js');
stateMod.WKS.vfs = makeFakeVfs();

const reg = await import('../works/js/surface-registry.js');
const extSurf = await import('../works/js/extension-surfaces.js');

beforeEach(() => {
  // Reset VFS + revoke list between tests, and wipe the kind registry
  // for kinds we've added (built-ins stay).
  stateMod.WKS.vfs = makeFakeVfs();
  _revoked.length = 0;
});

describe('registerExtensionSurfaces — happy path', () => {
  it('reads surface HTML from /lib/<pkg>/, processes it, registers kind', async () => {
    const vfs = stateMod.WKS.vfs;
    vfs.files.set('/lib/@test/foo/surface.html', '<!DOCTYPE html><html><body>data-grid</body></html>');

    await extSurf.registerExtensionSurfaces({
      name: '@test/foo', version: '0.1.0',
      surfaces: [{
        kind: 'test-foo-grid',
        label: 'Foo Grid',
        file: 'surface.html',
        extensions: ['.foo'],
      }],
    });

    const def = reg.kindDef('test-foo-grid');
    assert.ok(def);
    assert.equal(def.label, 'Foo Grid');
    assert.deepEqual(def.extensions, ['.foo']);
    assert.equal(def.isExtension, true);
    // Blob URL stashed
    assert.equal(typeof reg.surfaceUrl('test-foo-grid'), 'string');

    reg.unregisterKind('test-foo-grid');
  });

  it('retains detect callback in the live registration', async () => {
    // Detect lives in works.js (shell context), runs in the shell — so
    // the registration just stores the live function reference, no
    // serialization concerns.
    const vfs = stateMod.WKS.vfs;
    vfs.files.set('/lib/@test/with-detect/surface.html', '<html></html>');

    await extSurf.registerExtensionSurfaces({
      name: '@test/with-detect', version: '0.1.0',
      surfaces: [{
        kind: 'test-with-detect',
        file: 'surface.html',
        extensions: ['.foo'],
        detect: async () => true,
      }],
    });

    const def = reg.kindDef('test-with-detect');
    assert.equal(typeof def.detect, 'function');

    reg.unregisterKind('test-with-detect');
  });

  it('unregister removes the kind and revokes the blob URL', async () => {
    const vfs = stateMod.WKS.vfs;
    vfs.files.set('/lib/@test/gone/surface.html', '<html></html>');

    const manifest = {
      name: '@test/gone', version: '0.1.0',
      surfaces: [{ kind: 'test-gone-1', file: 'surface.html' }],
    };
    await extSurf.registerExtensionSurfaces(manifest);
    const blobUrl = reg.surfaceUrl('test-gone-1');
    assert.ok(blobUrl);

    extSurf.unregisterExtensionSurfaces(manifest);
    assert.equal(reg.kindDef('test-gone-1'), null);
    assert.ok(_revoked.includes(blobUrl), 'unregister should revoke the blob URL');
  });
});

