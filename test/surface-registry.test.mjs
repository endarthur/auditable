// Surface registry tests — kindForExtension fast path + kindForPath
// cascade (extension match → extensionless-name → detect() callbacks
// with shared peek cache).
//
// EXTENSION_SPEC §3.8.3. surface-registry.js touches `document` at
// import time via decompressLibs, so we shim it before import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};
globalThis.URL = globalThis.URL || { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };

const {
  registerKind, unregisterKind, kindForExtension, kindForPath,
} = await import('../works/js/surface-registry.js');

// Stub VFS that returns a fixed byte sequence for path → Uint8Array.
function fakeVfs(table) {
  return {
    readCount: 0,
    async readFile(path) {
      this.readCount++;
      if (table[path] === undefined) throw new Error('ENOENT ' + path);
      return table[path];
    },
  };
}

describe('kindForExtension (sync fast path)', () => {
  it('matches lowercase extensions', () => {
    registerKind('test-parquet-1', { label: 'Parquet', extensions: ['.testparquet'] });
    assert.equal(kindForExtension('data.testparquet'), 'test-parquet-1');
    assert.equal(kindForExtension('DATA.TESTPARQUET'), 'test-parquet-1');
    unregisterKind('test-parquet-1');
  });

  it('returns null when no kind matches', () => {
    assert.equal(kindForExtension('weird.testunknown'), null);
  });

  it('extensionlessNames overrides bare basenames', () => {
    registerKind('test-text-1', {
      label: 'Test',
      extensions: ['.testxyz'],
      extensionlessNames: ['MYWEIRDFILE'],
    });
    assert.equal(kindForExtension('MYWEIRDFILE'), 'test-text-1');
    assert.equal(kindForExtension('myweirdfile'), 'test-text-1');
    unregisterKind('test-text-1');
  });

  it('dotfiles are NOT treated as extensions', () => {
    // .gitignore should fall through, not match a hypothetical
    // ".gitignore"-extension kind.
    assert.equal(kindForExtension('.gitignore'), null);
  });
});

describe('kindForPath (async cascade with detect)', () => {
  it('falls back to kindForExtension when no detect is needed', async () => {
    registerKind('test-md-1', { label: 'MD', extensions: ['.testmd'] });
    const got = await kindForPath('/x/foo.testmd', { vfs: fakeVfs({}) });
    assert.equal(got, 'test-md-1');
    unregisterKind('test-md-1');
  });

  it('returns null without a vfs when no extension matches', async () => {
    const got = await kindForPath('/x/foo.testunknown', {});
    assert.equal(got, null);
  });

  it('detect callback claims a path via magic bytes', async () => {
    // 'PAR1' — Parquet's footer magic, also used at the head in some
    // formats. Detect callback receives peek(n) → Uint8Array.
    const PAR1 = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
    registerKind('test-parquet-detect', {
      label: 'Parquet',
      detect: async (_path, peek) => {
        const head = await peek(4);
        return head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31;
      },
    });
    const vfs = fakeVfs({ '/x/file': PAR1 });
    const got = await kindForPath('/x/file', { vfs });
    assert.equal(got, 'test-parquet-detect');
    unregisterKind('test-parquet-detect');
  });

  it('first matching detect wins', async () => {
    registerKind('test-second', { detect: async () => true });
    registerKind('test-first',  { detect: async () => true });
    const vfs = fakeVfs({ '/x/foo': new Uint8Array(4) });
    const got = await kindForPath('/x/foo', { vfs });
    // Registration order is insertion order; test-second registered first.
    assert.equal(got, 'test-second');
    unregisterKind('test-second');
    unregisterKind('test-first');
  });

  it('shared peek cache — two detect callbacks asking for ≤N bytes triggers ONE VFS read', async () => {
    let aCalled = false, bCalled = false;
    registerKind('test-detect-a', {
      detect: async (_p, peek) => { aCalled = true; await peek(8); return false; },
    });
    registerKind('test-detect-b', {
      detect: async (_p, peek) => { bCalled = true; await peek(16); return false; },
    });
    const vfs = fakeVfs({ '/x/y': new Uint8Array(32) });
    await kindForPath('/x/y', { vfs });
    assert.equal(aCalled, true);
    assert.equal(bCalled, true);
    assert.equal(vfs.readCount, 1);  // one read, shared
    unregisterKind('test-detect-a');
    unregisterKind('test-detect-b');
  });

  it('detect that throws is skipped, not fatal', async () => {
    const errs = [];
    const origErr = console.error;
    console.error = (...args) => errs.push(args.join(' '));
    try {
      registerKind('test-detect-throws', { detect: async () => { throw new Error('boom'); } });
      registerKind('test-detect-survives', { detect: async () => true });
      const vfs = fakeVfs({ '/x/file': new Uint8Array(8) });
      const got = await kindForPath('/x/file', { vfs });
      assert.equal(got, 'test-detect-survives');
      assert.ok(errs.some(s => s.includes('test-detect-throws')));
    } finally {
      console.error = origErr;
      unregisterKind('test-detect-throws');
      unregisterKind('test-detect-survives');
    }
  });

  it('peek budget caps total bytes read', async () => {
    let observed = null;
    registerKind('test-detect-budget', {
      detect: async (_p, peek) => { observed = await peek(2000); return false; },
    });
    const vfs = fakeVfs({ '/x/big': new Uint8Array(2000) });
    await kindForPath('/x/big', { vfs, peekBudget: 128 });
    assert.equal(observed.length, 128);  // truncated to budget
    unregisterKind('test-detect-budget');
  });

  it('VFS read failure → detect peek returns empty, no throw', async () => {
    registerKind('test-detect-noent', {
      detect: async (_p, peek) => {
        const head = await peek(8);
        return head.length > 0;  // false on empty read
      },
    });
    const vfs = fakeVfs({});  // /x/missing throws ENOENT
    const got = await kindForPath('/x/missing', { vfs });
    assert.equal(got, null);
    unregisterKind('test-detect-noent');
  });
});
