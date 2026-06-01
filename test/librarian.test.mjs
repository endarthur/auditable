// @gcu/librarian tests — pure unit coverage for tokenize, fuzzy, index,
// search, serialize. The Ctrl+K integration is exercised in the docs
// surface end-to-end (works-smoke, eventually).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, tokenizeStrings } from '../ext/librarian/src/tokenize.js';
import { editDistance, nearTerms } from '../ext/librarian/src/fuzzy.js';
import { buildIndex, mergeIndexes } from '../ext/librarian/src/index.js';
import { search, suggest } from '../ext/librarian/src/search.js';
import { serialize, deserialize } from '../ext/librarian/src/serialize.js';
import { buildBlob, scan } from '../ext/librarian/src/scan.js';
import { Librarian } from '../ext/librarian/src/api.js';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanum', () => {
    const tokens = tokenizeStrings('Hello, World! foo-bar');
    assert.deepEqual(tokens, ['hello', 'world', 'foo', 'bar']);
  });
  it('drops stopwords + 1-char tokens', () => {
    const tokens = tokenizeStrings('a quick brown fox jumps over the lazy dog');
    assert.deepEqual(tokens, ['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog']);
  });
  it('preserves CJK runs as tokens', () => {
    const tokens = tokenizeStrings('foo 你好 bar');
    assert.equal(tokens.length, 3);
    assert.equal(tokens[1], '你好');
  });
  it('reports positions', () => {
    const toks = tokenize('foo bar baz');
    assert.equal(toks[0].start, 0);
    assert.equal(toks[1].start, 4);
    assert.equal(toks[2].start, 8);
  });
});

describe('editDistance', () => {
  it('identical strings', () => assert.equal(editDistance('foo', 'foo', 3), 0));
  it('single insertion', () => assert.equal(editDistance('foo', 'fooo', 3), 1));
  it('single deletion', () => assert.equal(editDistance('foo', 'fo', 3), 1));
  it('single substitution', () => assert.equal(editDistance('foo', 'fxo', 3), 1));
  it('transposition counts as 1 (Damerau)', () => {
    assert.equal(editDistance('foo', 'ofo', 3), 1);
  });
  it('beyond max returns max+1', () => {
    assert.equal(editDistance('foo', 'xyzzy', 1), 2);
  });
});

describe('nearTerms', () => {
  it('finds close terms in a dictionary', () => {
    const dict = ['cat', 'cats', 'bat', 'rat', 'dog'];
    const near = nearTerms('cat', dict, 1);
    assert.deepEqual(near.map((n) => n.term).sort(), ['bat', 'cat', 'cats', 'rat']);
  });
});

describe('buildIndex / search', () => {
  function corpus() {
    return [
      { id: 'd1', title: 'Encryption',
        body: 'AES-GCM encryption protects notebook data with a passphrase.' },
      { id: 'd2', title: 'Mounts',
        body: 'Disk folders are mounted at /mnt/<name>. Mounts are per-machine.' },
      { id: 'd3', title: 'VFS',
        body: 'The virtual filesystem unifies notebook storage across surfaces.' },
    ];
  }
  it('exact term match returns matching doc', () => {
    const idx = buildIndex({ docs: corpus(),
      fields: { title: { boost: 3 }, body: { boost: 1 } } });
    const r = search(idx, 'encryption');
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'd1');
    assert.ok(r[0].score > 0);
  });
  it('title boost ranks title hit above body hit', () => {
    const corp = [
      { id: 'a', title: 'Mounts', body: 'unrelated text.' },
      { id: 'b', title: 'Storage', body: 'we have mounts of data.' },
    ];
    const idx = buildIndex({ docs: corp,
      fields: { title: { boost: 3 }, body: { boost: 1 } } });
    const r = search(idx, 'mounts');
    assert.equal(r[0].id, 'a');
  });
  it('multi-term query unions docs', () => {
    const idx = buildIndex({ docs: corpus(),
      fields: { title: { boost: 3 }, body: { boost: 1 } } });
    const r = search(idx, 'mount filesystem');
    assert.ok(r.length >= 2);
  });
  it('fuzzy match catches single typo', () => {
    const idx = buildIndex({ docs: corpus() });
    const r = search(idx, 'encrytion', { fuzzy: 1 });   // missing 'p'
    assert.equal(r[0].id, 'd1');
  });
  it('prefix match catches partial words', () => {
    const idx = buildIndex({ docs: corpus() });
    const r = search(idx, 'encr', { fuzzy: 0 });
    assert.equal(r[0].id, 'd1');
  });
  it('synonyms expand the query', () => {
    const idx = buildIndex({
      docs: corpus(),
      synonyms: { 'vfs': ['filesystem'] },
    });
    const r = search(idx, 'vfs', { fuzzy: 0 });
    assert.ok(r.some((h) => h.id === 'd3'));
  });
  it('snippet around match', () => {
    const idx = buildIndex({ docs: corpus() });
    const r = search(idx, 'passphrase');
    assert.ok(r[0].snippet.includes('passphrase')
      || r[0].snippet.includes('<mark>'));
  });
});

describe('suggest (did you mean)', () => {
  it('returns a near match when exact is missing', () => {
    const idx = buildIndex({
      docs: [{ id: 'a', title: 'Encryption' }],
    });
    // 'encrytion' is one transposition away from 'encryption'.
    assert.equal(suggest(idx, 'encrytion'), 'encryption');
  });
  it('passes through known terms unchanged', () => {
    const idx = buildIndex({
      docs: [{ id: 'a', title: 'Encryption Mounts' }],
    });
    assert.equal(suggest(idx, 'encryption'), 'encryption');
  });
});

describe('serialize / deserialize round-trip', () => {
  it('preserves search results', () => {
    const docs = [
      { id: 'a', title: 'Foo', body: 'lorem ipsum dolor' },
      { id: 'b', title: 'Bar', body: 'sit amet consectetur' },
    ];
    const idx1 = buildIndex({ docs });
    const json = serialize(idx1);
    const idx2 = deserialize(JSON.stringify(json));
    const r1 = search(idx1, 'lorem');
    const r2 = search(idx2, 'lorem');
    assert.equal(r1.length, r2.length);
    assert.equal(r1[0].id, r2[0].id);
  });
});

describe('Librarian (public API)', () => {
  it('exposes the core functions', () => {
    assert.equal(typeof Librarian.index, 'function');
    assert.equal(typeof Librarian.search, 'function');
    assert.equal(typeof Librarian.suggest, 'function');
    assert.equal(typeof Librarian.serialize, 'function');
    assert.equal(typeof Librarian.deserialize, 'function');
    assert.equal(typeof Librarian.merge, 'function');
  });
  it('end-to-end indexing + search', () => {
    const idx = Librarian.index({
      docs: [
        { id: 'p1', title: 'Reactive cells', body: 'cells re-run when inputs change' },
        { id: 'p2', title: 'Manual cells',   body: 'manual cells need Ctrl+Enter' },
      ],
    });
    const r = Librarian.search(idx, 'manual');
    assert.equal(r[0].id, 'p2');
  });
});

describe('merge', () => {
  it('combines multiple indexes', () => {
    const a = buildIndex({ docs: [{ id: 'a1', body: 'foo bar' }] });
    const b = buildIndex({ docs: [{ id: 'b1', body: 'baz qux' }] });
    const merged = mergeIndexes([a, b]);
    assert.equal(merged.stats.totalDocs, 2);
    assert.equal(search(merged, 'foo')[0].id, 'a1');
    assert.equal(search(merged, 'baz')[0].id, 'b1');
  });
});

describe('scan path (buildBlob / scan)', () => {
  function corp() {
    return [
      { id: 'd1', title: 'Encryption', body: 'AES-GCM encryption protects notebook data.' },
      { id: 'd2', title: 'Mounts', body: 'Disk folders mounted at /mnt/<name>. Mounts are per-machine.' },
      { id: 'd3', title: 'VFS', body: 'The virtual filesystem unifies notebook storage.' },
    ];
  }
  it('buildBlob folds non-id string fields, lowercased, with an offset table', () => {
    const b = buildBlob(corp());
    assert.equal(b.N, 3);
    assert.equal(b.starts.length, 4);                  // N + 1 (sentinel)
    assert.deepEqual(b.ids, ['d1', 'd2', 'd3']);
    assert.ok(b.blob.includes('encryption'));          // lowercased
    assert.ok(!b.blob.includes('Encryption'));
    assert.ok(b.starts[3] >= b.blob.length);           // sentinel past the end
  });
  it('exact scan finds a substring and maps it to the right doc', () => {
    const b = buildBlob(corp());
    const r = scan(b, 'notebook');
    const ids = r.map((h) => h.id).sort();
    assert.deepEqual(ids, ['d1', 'd3']);               // both mention "notebook"
  });
  it('exact scan matches mid-token / partial words (not tokenised)', () => {
    const b = buildBlob(corp());
    const r = scan(b, 'encry');                          // partial word, no fuzzy
    assert.equal(r[0].id, 'd1');
  });
  it('exact scan ranks by occurrence count', () => {
    const b = buildBlob(corp());
    const r = scan(b, 'mounts');                         // appears twice in d2
    assert.equal(r[0].id, 'd2');
    assert.ok(r[0].score >= 2);
  });
  it('exact scan returns [] for an absent needle', () => {
    const b = buildBlob(corp());
    assert.deepEqual(scan(b, 'quantumchromodynamics'), []);
  });
  it('empty / whitespace query returns []', () => {
    const b = buildBlob(corp());
    assert.deepEqual(scan(b, '   '), []);
    assert.deepEqual(scan(b, ''), []);
  });
  it('fuzzy scan tolerates a typo (bitap)', () => {
    const b = buildBlob(corp());
    const r = scan(b, 'encruption', { fuzzy: 2 });       // substitution
    assert.ok(r.some((h) => h.id === 'd1'));
  });
  it('fuzzy scan tolerates a missing char', () => {
    const b = buildBlob(corp());
    const r = scan(b, 'filesytem', { fuzzy: 1 });        // dropped 's'
    assert.ok(r.some((h) => h.id === 'd3'));
  });
  it('scan handles CJK substrings', () => {
    const b = buildBlob([{ id: 'c1', body: 'foo 你好世界 bar' }]);
    const r = scan(b, '好世');
    assert.equal(r[0].id, 'c1');
  });
  it('respects the limit', () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, body: 'common token here' }));
    const b = buildBlob(docs);
    assert.equal(scan(b, 'common', { limit: 4 }).length, 4);
  });
  it('exposed on the Librarian namespace', () => {
    assert.equal(typeof Librarian.buildBlob, 'function');
    assert.equal(typeof Librarian.scan, 'function');
  });
});
