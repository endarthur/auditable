// @gcu/librarian v2 — binary persistence (pack / unpack).
// Gate: pack -> unpack round-trips to byte-identical search results, for both
// the multi (storeText+positions) and lean (folded) configs; pending delta is
// folded on pack; the snippet callback re-attaches on unpack.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCsrIndex } from '../ext/librarian/src/csr.js';
import { search } from '../ext/librarian/src/search.js';
import { addDoc, removeDoc } from '../ext/librarian/src/incremental.js';
import { pack, unpack } from '../ext/librarian/src/pack.js';

function corpus() {
  return [
    { id: 'd1', title: 'Encryption', body: 'aes-gcm encryption protects notebook data', file: 'a.md' },
    { id: 'd2', title: 'Mounts', body: 'disk folders mounted at a path', file: 'b.md' },
    { id: 'd3', title: 'Filesystem', body: 'the virtual filesystem unifies storage', file: 'c.md' },
    { id: 'd4', title: 'Kriging', body: 'ordinary kriging estimates grade and data', file: 'd.md' },
  ];
}
const ids = (r) => r.map((h) => h.id);
const queries = ['encryption', 'data', 'kriging', 'storage', 'mount filesystem', 'encrytion'];

function assertSameResults(a, b, q) {
  assert.deepEqual(ids(b), ids(a), `ids match for "${q}"`);
  for (let j = 0; j < a.length; j++) {
    assert.ok(Math.abs(a[j].score - b[j].score) < 1e-12, `score match for "${q}"[${j}]`);
    assert.equal(b[j].doc.id, a[j].doc.id);
  }
}

describe('pack / unpack — round-trip parity', () => {
  for (const cfg of [
    { name: 'multi (storeText+positions)', opts: { fields: { title: { boost: 4 }, body: { boost: 1 } } } },
    { name: 'folded (lean)', opts: { mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false } },
  ]) {
    it(`byte-identical search results — ${cfg.name}`, () => {
      const idx = buildCsrIndex({ docs: corpus(), synonyms: { vfs: ['filesystem'] }, ...cfg.opts });
      const buf = pack(idx);
      assert.ok(buf instanceof ArrayBuffer);
      const idx2 = unpack(buf);
      for (const q of queries) assertSameResults(search(idx, q, { fuzzy: 1, limit: 10 }), search(idx2, q, { fuzzy: 1, limit: 10 }), q);
      // synonym table survived
      assert.deepEqual(ids(search(idx2, 'vfs', { fuzzy: 0 })), ids(search(idx, 'vfs', { fuzzy: 0 })));
    });
  }

  it('preserves meta + stored field text (multi)', () => {
    const idx = buildCsrIndex({ docs: corpus(), fields: { title: { boost: 4 }, body: { boost: 1 } } });
    const idx2 = unpack(pack(idx));
    const r = search(idx2, 'encryption');
    assert.equal(r[0].doc.file, 'a.md');                 // meta
    assert.equal(r[0].doc.body, 'aes-gcm encryption protects notebook data'); // stored text
    assert.ok(r[0].snippet.includes('<mark>'));          // positions -> aligned snippet
  });

  it('snippet callback re-attaches on unpack (lean path)', () => {
    const bodyById = { d1: 'aes-gcm encryption protects notebook data', d4: 'ordinary kriging estimates grade and data' };
    const idx = buildCsrIndex({ docs: corpus(), mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false });
    const idx2 = unpack(pack(idx), { snippet: (docId) => bodyById[docId] || '' });
    const r = search(idx2, 'encryption');
    assert.equal(r[0].id, 'd1');
    assert.ok(r[0].snippet.includes('<mark>encryption</mark>'));
  });

  it('pack folds pending delta + tombstones before serializing', () => {
    const idx = buildCsrIndex({ docs: corpus(), fields: { title: { boost: 4 }, body: { boost: 1 } } });
    addDoc(idx, { id: 'd5', title: 'Variogram', body: 'variogram models spatial data' });
    removeDoc(idx, 'd2');
    const idx2 = unpack(pack(idx));
    assert.equal(idx2.N, 4);                              // d2 dropped, d5 folded in
    assert.equal(idx2._deltaDocs, undefined);            // packed clean (no delta machinery)
    assert.deepEqual(ids(search(idx2, 'variogram')), ['d5']);
    assert.ok(!ids(search(idx2, 'mounted')).includes('d2'));
  });

  it('unpacked index supports further addDoc/search', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    const idx2 = unpack(pack(idx));
    addDoc(idx2, { id: 'd9', body: 'newly added quokka content' });
    assert.deepEqual(ids(search(idx2, 'quokka')), ['d9']);
  });

  it('rejects a buffer with bad magic', () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    assert.throws(() => unpack(bad), /bad magic/);
  });

  it('typed-array sections are zero-copy views over the buffer', () => {
    const idx = buildCsrIndex({ docs: corpus(), mode: 'folded', storeText: false, positions: false });
    const buf = pack(idx);
    const idx2 = unpack(buf);
    assert.equal(idx2.postDocs.buffer, buf);             // view, not a copy
    assert.equal(idx2.termOffset.buffer, buf);
  });

  it('round-trips a larger index with correct results', () => {
    const docs = Array.from({ length: 2000 }, (_, i) => ({ id: 'x' + i, title: 'doc ' + i, body: `token${i % 50} alpha beta gamma payload${i}` }));
    const idx = buildCsrIndex({ docs, mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false });
    const idx2 = unpack(pack(idx));
    for (const q of ['token7', 'alpha', 'payload1234', 'gamma']) {
      assertSameResults(search(idx, q, { limit: 20 }), search(idx2, q, { limit: 20 }), q);
    }
  });
});
