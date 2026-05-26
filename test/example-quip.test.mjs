// Tests for the @example/quip reference extension — the language
// itself (parse / render / makePhrases). Surface + registration are
// browser-side; this is just the pure-JS portion.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseQuip, renderQuip, makePhrases, compileQuip, tokenizeQuip,
} = await import('../ext/example-quip/index.js');

describe('parseQuip', () => {
  it('parses key = template lines', () => {
    const t = parseQuip('hello = Hi, {name}!\nbye = See you');
    assert.deepEqual({ ...t }, { hello: 'Hi, {name}!', bye: 'See you' });
  });

  it('strips whitespace around = and at line edges', () => {
    const t = parseQuip('   hello   =   Hi!   ');
    assert.equal(t.hello, 'Hi!');
  });

  it('skips comments and blank lines', () => {
    const t = parseQuip('# a comment\n\nhi = Hi\n# another');
    assert.deepEqual({ ...t }, { hi: 'Hi' });
  });

  it('rejects duplicate names', () => {
    assert.throws(() => parseQuip('a = 1\na = 2'), /duplicate name 'a'/);
  });

  it('rejects malformed names', () => {
    assert.throws(() => parseQuip('1bad = x'), /is not a valid name/);
  });

  it('rejects lines without =', () => {
    assert.throws(() => parseQuip('no equals here'), /missing '='/);
  });
});

describe('renderQuip', () => {
  it('substitutes {var} placeholders', () => {
    assert.equal(renderQuip('Hi, {name}!', { name: 'Ada' }), 'Hi, Ada!');
  });

  it('leaves unknown placeholders intact', () => {
    assert.equal(renderQuip('Hi, {name}!', {}), 'Hi, {name}!');
  });

  it('treats {{ and }} as literal braces', () => {
    assert.equal(renderQuip('{{x}} and {y}', { y: 'real' }), '{x} and real');
  });

  it('stringifies non-string vars', () => {
    assert.equal(renderQuip('{n} times', { n: 42 }), '42 times');
  });

  it('handles empty input gracefully', () => {
    assert.equal(renderQuip('', {}), '');
    assert.equal(renderQuip(null, {}), '');
  });
});

describe('makePhrases', () => {
  it('builds callables with .template + .vars metadata', () => {
    const p = makePhrases({ hi: 'Hi, {name}!', plain: 'static' });
    assert.equal(p.hi({ name: 'Ada' }), 'Hi, Ada!');
    assert.equal(p.hi.template, 'Hi, {name}!');
    assert.deepEqual(p.hi.vars, ['name']);
    assert.deepEqual(p.plain.vars, []);
    assert.equal(p.plain(), 'static');
  });

  it('preserves order from the source', () => {
    const p = makePhrases({ first: 'a', second: 'b', third: 'c' });
    assert.deepEqual(Object.keys(p), ['first', 'second', 'third']);
  });
});

describe('compileQuip (round-trip)', () => {
  it('parses + makes phrases in one call', () => {
    const p = compileQuip('greet = Hello, {name}!');
    assert.equal(p.greet({ name: 'Ada' }), 'Hello, Ada!');
  });
});

describe('tokenizeQuip', () => {
  it('returns tokens with stable kinds', () => {
    const toks = tokenizeQuip('hello = Hi, {name}!');
    const kinds = new Set(toks.map(t => t.kind));
    assert.ok(kinds.has('name'));
    assert.ok(kinds.has('operator'));
    assert.ok(kinds.has('string'));
    assert.ok(kinds.has('variable'));
  });

  it('marks # lines as comments', () => {
    const toks = tokenizeQuip('# comment\nhi = x');
    const comment = toks.find(t => t.kind === 'comment');
    assert.ok(comment);
  });

  it('flags malformed lines as errors', () => {
    const toks = tokenizeQuip('no equals here');
    assert.ok(toks.some(t => t.kind === 'error'));
  });
});
