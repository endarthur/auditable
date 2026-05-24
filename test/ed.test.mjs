// @gcu/ed tests — buffer ops, address parsing, regex translation.
// The dispatcher + commands are exercised end-to-end via a mock ctx in
// the integration block at the bottom.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBuffer, snapshot, undo,
  insertAfter, deleteRange, moveRange, transferRange, replaceLine,
} from '../ext/ed/src/buffer.js';
import { edToJsRegex, applySubstitute } from '../ext/ed/src/regex.js';
import { parseAddress, resolveRange } from '../ext/ed/src/address.js';
import { runEd } from '../ext/ed/src/api.js';

// ── buffer ──────────────────────────────────────────────────────────

describe('buffer: insert / delete / move', () => {
  function fresh(lines) {
    const b = createBuffer();
    b.lines = [...lines];
    b.cur = lines.length;
    return b;
  }
  it('insertAfter appends and moves cursor', () => {
    const b = fresh(['a', 'b']);
    insertAfter(b, 2, ['c', 'd']);
    assert.deepEqual(b.lines, ['a', 'b', 'c', 'd']);
    assert.equal(b.cur, 4);
    assert.equal(b.dirty, true);
  });
  it('insertAfter at 0 prepends', () => {
    const b = fresh(['a', 'b']);
    insertAfter(b, 0, ['x']);
    assert.deepEqual(b.lines, ['x', 'a', 'b']);
    assert.equal(b.cur, 1);
  });
  it('deleteRange removes inclusive range', () => {
    const b = fresh(['a', 'b', 'c', 'd']);
    deleteRange(b, 2, 3);
    assert.deepEqual(b.lines, ['a', 'd']);
    assert.equal(b.cur, 2);
  });
  it('moveRange relocates lines', () => {
    const b = fresh(['1', '2', '3', '4', '5']);
    moveRange(b, 1, 2, 4);   // move "1\n2" to after line 4 → "3\n4\n1\n2\n5"
    assert.deepEqual(b.lines, ['3', '4', '1', '2', '5']);
    assert.equal(b.cur, 4);
  });
  it('transferRange duplicates lines', () => {
    const b = fresh(['a', 'b', 'c']);
    transferRange(b, 1, 1, 3);   // copy "a" to after line 3 → "a b c a"
    assert.deepEqual(b.lines, ['a', 'b', 'c', 'a']);
    assert.equal(b.cur, 4);
  });
  it('moveRange into-own-range errors', () => {
    const b = fresh(['1', '2', '3']);
    assert.throws(() => moveRange(b, 1, 3, 2), /invalid destination/);
  });
});

describe('buffer: undo', () => {
  it('snapshot then mutate then undo restores', () => {
    const b = createBuffer();
    b.lines = ['a', 'b'];
    b.cur = 2;
    snapshot(b);
    insertAfter(b, 2, ['c']);
    assert.deepEqual(b.lines, ['a', 'b', 'c']);
    undo(b);
    assert.deepEqual(b.lines, ['a', 'b']);
    assert.equal(b.cur, 2);
  });
  it('undo is its own inverse', () => {
    const b = createBuffer();
    b.lines = ['a', 'b'];
    b.cur = 2;
    snapshot(b);
    insertAfter(b, 2, ['c']);
    undo(b);
    undo(b);
    assert.deepEqual(b.lines, ['a', 'b', 'c']);
  });
});

// ── regex ───────────────────────────────────────────────────────────

describe('regex: ed BRE → JS', () => {
  it('parens are literal in BRE, \\( is a group', () => {
    const re = edToJsRegex('\\(foo\\)bar', '');
    assert.equal(re.test('foobar'), true);
    const re2 = edToJsRegex('(foo)', '');
    assert.equal(re2.test('foo'), false);   // literal parens
    assert.equal(re2.test('(foo)'), true);
  });
  it('\\| is alternation', () => {
    const re = edToJsRegex('foo\\|bar', '');
    assert.equal(re.test('bar'), true);
    assert.equal(re.test('foo'), true);
    assert.equal(re.test('xyz'), false);
  });
  it('\\< \\> map to \\b', () => {
    const re = edToJsRegex('\\<foo\\>', '');
    assert.equal(re.test('foo bar'), true);
    assert.equal(re.test('foobar'), false);
  });
  it('+ and ? are literal in BRE', () => {
    const re = edToJsRegex('a+b', '');
    assert.equal(re.test('a+b'), true);
    assert.equal(re.test('aab'), false);
  });
});

describe('regex: applySubstitute', () => {
  it('plain replacement', () => {
    const re = edToJsRegex('foo', '');
    assert.equal(applySubstitute('foo bar', re, 'baz', false), 'baz bar');
  });
  it('& replaced with whole match', () => {
    const re = edToJsRegex('foo', '');
    assert.equal(applySubstitute('foo bar', re, '[&]', false), '[foo] bar');
  });
  it('\\1 backreference', () => {
    const re = edToJsRegex('\\(f\\)\\(oo\\)', '');
    assert.equal(applySubstitute('foo', re, '\\2\\1', false), 'oof');
  });
  it('global replaces all', () => {
    const re = edToJsRegex('a', '');
    assert.equal(applySubstitute('banana', re, 'X', true), 'bXnXnX');
  });
});

// ── address ─────────────────────────────────────────────────────────

describe('address: parsing', () => {
  it('absolute number', () => {
    const r = parseAddress('5p');
    assert.equal(r.range.a1.type, 'num');
    assert.equal(r.range.a1.value, 5);
    assert.equal(r.rest, 'p');
  });
  it('. and $', () => {
    assert.equal(parseAddress('.p').range.a1.type, 'cur');
    assert.equal(parseAddress('$p').range.a1.type, 'last');
  });
  it('range with comma', () => {
    const r = parseAddress('1,5p');
    assert.equal(r.range.a1.value, 1);
    assert.equal(r.range.sep, ',');
    assert.equal(r.range.a2.value, 5);
    assert.equal(r.rest, 'p');
  });
  it('offset from .', () => {
    const r = parseAddress('+3p');
    assert.equal(r.range.a1.type, 'offset');
    assert.equal(r.range.a1.from.type, 'cur');
    assert.equal(r.range.a1.delta, 3);
  });
  it('shortcut , = 1,$', () => {
    const r = parseAddress(',p');
    assert.equal(r.range.sep, ',');
    assert.equal(r.range.a1, null);
    assert.equal(r.range.a2, null);
  });
});

describe('address: resolving', () => {
  function buf(lines, cur) {
    const b = createBuffer();
    b.lines = lines;
    b.cur = cur != null ? cur : lines.length;
    return b;
  }
  it('absolute number', () => {
    const r = parseAddress('3p');
    const b = buf(['a','b','c','d']);
    assert.deepEqual(resolveRange(r.range, b, { from: 0, to: 0 }), { from: 3, to: 3 });
  });
  it('range 2,4', () => {
    const r = parseAddress('2,4p');
    const b = buf(['a','b','c','d']);
    assert.deepEqual(resolveRange(r.range, b, { from: 0, to: 0 }), { from: 2, to: 4 });
  });
  it(', without addresses = 1,$', () => {
    const r = parseAddress(',p');
    const b = buf(['a','b','c']);
    assert.deepEqual(resolveRange(r.range, b, { from: 0, to: 0 }), { from: 1, to: 3 });
  });
  it('out-of-range throws', () => {
    const r = parseAddress('99p');
    const b = buf(['a','b']);
    assert.throws(() => resolveRange(r.range, b, { from: 0, to: 0 }), /invalid address/);
  });
});

// ── integration: drive runEd with a mock ctx ────────────────────────

function mockCtx(inputLines, vfsFiles) {
  const stdout = [];
  const stderr = [];
  let inputIdx = 0;
  const vfs = {
    files: vfsFiles || {},
    async readFile(p) { if (p in this.files) return this.files[p]; throw new Error('ENOENT'); },
    async writeFile(p, content) { this.files[p] = content; },
  };
  return {
    stdout: async (t) => { stdout.push(t); },
    stderr: async (t) => { stderr.push(t); },
    readLine: async (opts) => {
      if (opts && opts.prompt) stdout.push(opts.prompt);
      if (inputIdx >= inputLines.length) return { eof: true };
      return { line: inputLines[inputIdx++] };
    },
    vfs,
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('ed: integration', () => {
  it('open file, print, quit', async () => {
    const ctx = mockCtx(['1,$p', 'q'], { '/x.txt': 'one\ntwo\nthree\n' });
    await runEd(['ed', '/x.txt'], ctx);
    assert.ok(ctx.out().includes('one\ntwo\nthree\n'));
  });
  it('append then print', async () => {
    const ctx = mockCtx(['a', 'first', 'second', '.', '1,$p', 'q'], {});
    await runEd(['ed'], ctx);
    assert.ok(ctx.out().includes('first\nsecond\n'));
  });
  it('substitute on current line', async () => {
    const ctx = mockCtx(['a', 'hello world', '.', 's/world/everyone/', 'p', 'q'], {});
    await runEd(['ed'], ctx);
    assert.ok(ctx.out().includes('hello everyone\n'));
  });
  it('global substitute across range', async () => {
    const ctx = mockCtx(['a', 'aaa', 'bbb', 'aaa', '.', '1,$s/a/X/g', '1,$p', 'q'], {});
    await runEd(['ed'], ctx);
    const out = ctx.out();
    assert.ok(out.includes('XXX\n'));
    assert.ok(out.includes('bbb\n'));
  });
  it('delete and undo', async () => {
    const ctx = mockCtx(['a', 'one', 'two', 'three', '.', '2d', 'u', '1,$p', 'q'], {});
    await runEd(['ed'], ctx);
    const out = ctx.out();
    assert.ok(out.includes('one\ntwo\nthree\n'));
  });
  it('move lines', async () => {
    const ctx = mockCtx(['a', '1', '2', '3', '.', '1m3', '1,$p', 'q'], {});
    await runEd(['ed'], ctx);
    assert.ok(ctx.out().includes('2\n3\n1\n'));
  });
  it('write to file', async () => {
    const ctx = mockCtx(['a', 'hello', '.', 'w /out.txt', 'q'], {});
    await runEd(['ed'], ctx);
    assert.equal(ctx.vfs.files['/out.txt'], 'hello\n');
  });
  it('wq shortcut writes and quits', async () => {
    const ctx = mockCtx(['a', 'wq-line', '.', 'wq /wq.txt'], {});
    await runEd(['ed'], ctx);
    assert.equal(ctx.vfs.files['/wq.txt'], 'wq-line\n');
  });
  it('--posix mode silences prompt and uses ?', async () => {
    const ctx = mockCtx(['xx', 'q'], {});
    await runEd(['ed', '--posix'], ctx);
    assert.equal(ctx.err(), '?\n');
    // No prompt output.
    assert.equal(ctx.out().includes('* '), false);
  });
  it('default mode is verbose + shows prompt', async () => {
    const ctx = mockCtx(['xx', 'q'], {});
    await runEd(['ed'], ctx);
    assert.ok(ctx.err().startsWith('? '));
    assert.ok(ctx.out().includes('* '));
  });
});
