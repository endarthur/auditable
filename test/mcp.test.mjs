// Tests for MCP adapter pure functions
// These test the logic extracted from mcp-adapter.js without needing a browser environment.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── applyPatches (same logic as _mcpApplyPatches in mcp-adapter.js) ──

function applyPatches(source, patches) {
  let result = source;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (typeof p.old !== 'string' || typeof p.new !== 'string') {
      throw new Error(`Patch ${i}: old and new must be strings`);
    }
    const pos = result.indexOf(p.old);
    if (pos === -1) throw new Error(`Patch ${i}: old string not found in cell source`);
    result = result.slice(0, pos) + p.new + result.slice(pos + p.old.length);
  }
  return result;
}

describe('applyPatches', () => {
  const source = 'const x = 1;\nconst y = 2;\nconst z = x + y;';

  it('applies a single patch', () => {
    const result = applyPatches(source, [{ old: 'const x = 1', new: 'const x = 10' }]);
    assert.ok(result.includes('const x = 10'));
    assert.ok(result.includes('const y = 2'));
  });

  it('applies multiple patches in order', () => {
    const result = applyPatches(source, [
      { old: 'const x = 1', new: 'const x = 10' },
      { old: 'const y = 2', new: 'const y = 20' },
    ]);
    assert.ok(result.includes('const x = 10'));
    assert.ok(result.includes('const y = 20'));
  });

  it('errors when old string not found', () => {
    assert.throws(
      () => applyPatches(source, [{ old: 'nonexistent', new: 'replacement' }]),
      /Patch 0: old string not found/
    );
  });

  it('errors on second patch if not found', () => {
    assert.throws(
      () => applyPatches(source, [
        { old: 'const x = 1', new: 'const x = 10' },
        { old: 'nonexistent', new: 'replacement' },
      ]),
      /Patch 1: old string not found/
    );
  });

  it('replaces only the first occurrence', () => {
    const code = 'a = 1;\na = 2;\na = 3;';
    const result = applyPatches(code, [{ old: 'a = ', new: 'b = ' }]);
    assert.strictEqual(result, 'b = 1;\na = 2;\na = 3;');
  });

  it('handles empty patches array (no-op)', () => {
    const result = applyPatches(source, []);
    assert.strictEqual(result, source);
  });

  it('handles multiline old strings', () => {
    const result = applyPatches(source, [
      { old: 'const x = 1;\nconst y = 2', new: 'const x = 10;\nconst y = 20' }
    ]);
    assert.ok(result.includes('const x = 10;\nconst y = 20'));
  });

  it('errors when old or new is not a string', () => {
    assert.throws(
      () => applyPatches(source, [{ old: 123, new: 'foo' }]),
      /Patch 0: old and new must be strings/
    );
  });

  it('sequential patches see prior changes', () => {
    const result = applyPatches('hello world', [
      { old: 'hello', new: 'hi' },
      { old: 'hi world', new: 'hi there' },
    ]);
    assert.strictEqual(result, 'hi there');
  });

  it('handles empty source', () => {
    assert.throws(
      () => applyPatches('', [{ old: 'x', new: 'y' }]),
      /old string not found/
    );
  });

  it('replaces with empty string (deletion)', () => {
    const result = applyPatches('const x = 1;\nconst y = 2;', [
      { old: 'const x = 1;\n', new: '' }
    ]);
    assert.strictEqual(result, 'const y = 2;');
  });

  it('inserts via empty old at start', () => {
    const result = applyPatches('hello', [{ old: '', new: 'prefix ' }]);
    assert.strictEqual(result, 'prefix hello');
  });
});

// ── changedLines (same logic as _changedLines in cell-ops.js) ──

function changedLines(oldCode, newCode) {
  const oldL = (oldCode || '').split('\n');
  const newL = newCode.split('\n');
  const lines = [];
  const max = Math.max(oldL.length, newL.length);
  for (let i = 0; i < max; i++) {
    if (oldL[i] !== newL[i]) lines.push(i + 1);
  }
  return lines;
}

describe('changedLines', () => {
  it('detects single changed line', () => {
    const result = changedLines('a\nb\nc', 'a\nB\nc');
    assert.deepStrictEqual(result, [2]);
  });

  it('detects multiple changed lines', () => {
    const result = changedLines('a\nb\nc', 'A\nb\nC');
    assert.deepStrictEqual(result, [1, 3]);
  });

  it('handles added lines', () => {
    const result = changedLines('a\nb', 'a\nb\nc');
    assert.deepStrictEqual(result, [3]);
  });

  it('handles removed lines', () => {
    const result = changedLines('a\nb\nc', 'a\nb');
    assert.deepStrictEqual(result, [3]);
  });

  it('returns empty for identical code', () => {
    const result = changedLines('a\nb\nc', 'a\nb\nc');
    assert.deepStrictEqual(result, []);
  });

  it('handles empty old code', () => {
    const result = changedLines('', 'a\nb');
    assert.deepStrictEqual(result, [1, 2]);
  });

  it('returns 1-based line numbers', () => {
    const result = changedLines('x', 'y');
    assert.deepStrictEqual(result, [1]);
  });
});
