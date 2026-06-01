// @gcu/librarian v2 — unified CSR engine.
//
// The gate (per spec_inbox/librarian-search-spec.md RESOLUTION): the unified
// engine, with storeText + multi-field + positions ON (the defaults), must
// reproduce v1's behaviour. This file (a) re-runs v1's exact test assertions
// against the CSR engine, (b) checks head-to-head score parity v1 vs CSR on a
// shared corpus, (c) adds a CJK regression, and (d) covers the lean (folded /
// no-text / no-positions) path that v1 never had.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex } from '../ext/librarian/src/index.js';      // v1 (reference)
import { buildCsrIndex } from '../ext/librarian/src/csr.js';     // v2 (unified)
import { search, suggest } from '../ext/librarian/src/search.js'; // dispatches on _csr

// ── (a) v1's assertions, re-run against the CSR engine ───────────────────────

describe('CSR engine — v1 parity (buildIndex/search assertions)', () => {
  function corpus() {
    return [
      { id: 'd1', title: 'Encryption', body: 'AES-GCM encryption protects notebook data with a passphrase.' },
      { id: 'd2', title: 'Mounts', body: 'Disk folders are mounted at /mnt/<name>. Mounts are per-machine.' },
      { id: 'd3', title: 'VFS', body: 'The virtual filesystem unifies notebook storage across surfaces.' },
    ];
  }
  it('exact term match returns matching doc', () => {
    const idx = buildCsrIndex({ docs: corpus(), fields: { title: { boost: 3 }, body: { boost: 1 } } });
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
    const idx = buildCsrIndex({ docs: corp, fields: { title: { boost: 3 }, body: { boost: 1 } } });
    assert.equal(search(idx, 'mounts')[0].id, 'a');
  });
  it('multi-term query unions docs', () => {
    const idx = buildCsrIndex({ docs: corpus(), fields: { title: { boost: 3 }, body: { boost: 1 } } });
    assert.ok(search(idx, 'mount filesystem').length >= 2);
  });
  it('fuzzy match catches single typo', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.equal(search(idx, 'encrytion', { fuzzy: 1 })[0].id, 'd1');
  });
  it('prefix match catches partial words', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.equal(search(idx, 'encr', { fuzzy: 0 })[0].id, 'd1');
  });
  it('synonyms expand the query', () => {
    const idx = buildCsrIndex({ docs: corpus(), synonyms: { vfs: ['filesystem'] } });
    assert.ok(search(idx, 'vfs', { fuzzy: 0 }).some((h) => h.id === 'd3'));
  });
  it('snippet around match', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    const r = search(idx, 'passphrase');
    assert.ok(r[0].snippet.includes('passphrase') || r[0].snippet.includes('<mark>'));
  });
  it('suggest returns a near match when exact is missing', () => {
    const idx = buildCsrIndex({ docs: [{ id: 'a', title: 'Encryption' }] });
    assert.equal(suggest(idx, 'encrytion'), 'encryption');
  });
  it('suggest passes through known terms unchanged', () => {
    const idx = buildCsrIndex({ docs: [{ id: 'a', title: 'Encryption Mounts' }] });
    assert.equal(suggest(idx, 'encryption'), 'encryption');
  });
  it('meta keys are preserved on hits', () => {
    const idx = buildCsrIndex({ docs: [{ id: 'x', title: 'Foo', anchor: 'sec-1', file: 'a.md' }] });
    const r = search(idx, 'foo');
    assert.equal(r[0].doc.anchor, 'sec-1');
    assert.equal(r[0].doc.file, 'a.md');
  });
});

// ── (b) head-to-head: identical ranked ids + scores, v1 vs CSR ──────────────

describe('CSR engine — head-to-head score parity with v1', () => {
  const corpus = [
    { id: 'd1', title: 'Encryption keys', body: 'AES-GCM encryption protects notebook data with a passphrase and a recovery key.' },
    { id: 'd2', title: 'Mounts and folders', body: 'Disk folders are mounted at a path. Mounts are per-machine and persist.' },
    { id: 'd3', title: 'Virtual filesystem', body: 'The virtual filesystem unifies notebook storage and data across surfaces.' },
    { id: 'd4', title: 'Data', body: 'notebook data data data — encryption of data at rest.' },
  ];
  const fields = { title: { boost: 4 }, body: { boost: 1 } };
  const v1 = buildIndex({ docs: corpus, fields });
  const v2 = buildCsrIndex({ docs: corpus, fields });   // default multi + storeText + positions

  for (const q of ['encryption', 'data', 'notebook data', 'mount filesystem', 'storage', 'encrytion', 'fil']) {
    it(`query "${q}" → identical ranking + scores`, () => {
      const r1 = search(v1, q, { fuzzy: 1, limit: 10 });
      const r2 = search(v2, q, { fuzzy: 1, limit: 10 });
      assert.deepEqual(r2.map((h) => h.id), r1.map((h) => h.id), 'same ranked ids');
      for (let i = 0; i < r1.length; i++) {
        assert.ok(Math.abs(r1[i].score - r2[i].score) < 1e-9, `score[${i}] ${r1[i].score} vs ${r2[i].score}`);
      }
    });
  }
});

// ── (c) CJK regression ──────────────────────────────────────────────────────

describe('CSR engine — CJK regression', () => {
  it('indexes and finds CJK terms (per-char tokens)', () => {
    const idx = buildCsrIndex({ docs: [
      { id: 'c1', title: '你好', body: 'foo 世界 bar' },
      { id: 'c2', title: 'hello', body: 'plain english only' },
    ] });
    const r = search(idx, '世界', { fuzzy: 0 });
    assert.ok(r.some((h) => h.id === 'c1'));
    assert.ok(!r.some((h) => h.id === 'c2'));
  });
  it('CJK parity with v1', () => {
    const docs = [{ id: 'c1', body: '你好 世界 你好' }, { id: 'c2', body: '世界 和平' }];
    const v1 = buildIndex({ docs });
    const v2 = buildCsrIndex({ docs });
    const r1 = search(v1, '你好', { fuzzy: 0 });
    const r2 = search(v2, '你好', { fuzzy: 0 });
    assert.deepEqual(r2.map((h) => h.id), r1.map((h) => h.id));
  });
});

// ── prefix + filter search options (weir §5) ────────────────────────────────

describe('CSR engine — prefix option', () => {
  const docs = [
    { id: 'd1', title: 'Encryption', body: 'aes encryption' },
    { id: 'd2', title: 'Mounts', body: 'disk encryption folders' },
    { id: 'd3', title: 'Storage', body: 'plain text' },
  ];
  const idx = buildCsrIndex({ docs, fields: { title: { boost: 4 }, body: { boost: 1 } } });
  const ids = (r) => r.map((h) => h.id).sort();

  it('prefix is on by default — a partial word matches', () => {
    assert.deepEqual(ids(search(idx, 'encr', { fuzzy: 0 })), ['d1', 'd2']);
  });
  it('prefix:false matches whole terms only', () => {
    assert.deepEqual(search(idx, 'encr', { fuzzy: 0, prefix: false }), []);
    // the exact term still matches with prefix off
    assert.deepEqual(ids(search(idx, 'encryption', { fuzzy: 0, prefix: false })), ['d1', 'd2']);
  });
});

describe('CSR engine — filter (scoped search)', () => {
  const docs = [
    { id: 'a1', body: 'shared term', folder: 'x' },
    { id: 'a2', body: 'shared term', folder: 'y' },
    { id: 'a3', body: 'shared term', folder: 'x' },
  ];
  const idx = buildCsrIndex({ docs });
  const ids = (r) => r.map((h) => h.id).sort();

  it('restricts results to docs passing the predicate (by external id)', () => {
    const r = search(idx, 'shared', { filter: (id) => id !== 'a2' });
    assert.deepEqual(ids(r), ['a1', 'a3']);
  });
  it('returns the top-K of the filtered set (filter before limit)', () => {
    const r = search(idx, 'shared', { filter: (id) => id !== 'a1', limit: 1 });
    assert.equal(r.length, 1);
    assert.ok(['a2', 'a3'].includes(r[0].id));   // a1 excluded even though it scores
  });
  it('no filter → all matches', () => {
    assert.deepEqual(ids(search(idx, 'shared')), ['a1', 'a2', 'a3']);
  });
});

// ── (d) lean path (folded / no stored text / no positions) ──────────────────

describe('CSR engine — lean (folded) path', () => {
  const docs = [
    { id: 'd1', title: 'Encryption', author: 'amy', body: 'aes-gcm encryption protects data' },
    { id: 'd2', title: 'Mounts', author: 'bob', body: 'disk folders mounted at a path' },
    { id: 'd3', title: 'Filesystem', author: 'amy', body: 'the virtual filesystem unifies storage' },
  ];
  it('folded mode ranks and finds', () => {
    const idx = buildCsrIndex({ docs, mode: 'folded', fields: { title: { boost: 4 }, author: { boost: 2 }, body: { boost: 1 } }, storeText: false, positions: false });
    assert.equal(idx.mode, 'folded');
    assert.equal(idx.postField, null);   // no field dimension when folded
    assert.equal(idx.pos, null);          // no positions
    assert.equal(idx.docText, null);      // no stored text
    const r = search(idx, 'encryption');
    assert.equal(r[0].id, 'd1');
  });
  it('fields: "folded" string is a mode alias', () => {
    const idx = buildCsrIndex({ docs, fields: 'folded' });
    assert.equal(idx.mode, 'folded');
  });
  it('title boost still ranks title above body (folded)', () => {
    const idx = buildCsrIndex({ docs: [
      { id: 'a', title: 'mounts', body: 'unrelated' },
      { id: 'b', title: 'storage', body: 'we have mounts of data' },
    ], mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false });
    assert.equal(search(idx, 'mounts')[0].id, 'a');
  });
  it('snippet callback supplies text when storeText is off (lean path)', () => {
    // weir holds the body itself and keys snippets by doc id (fieldName is null
    // in folded mode). storeText + positions both off — the real lean config.
    const bodyById = { d1: 'aes-gcm encryption protects data', d2: 'disk folders mounted', d3: 'virtual filesystem storage' };
    const idx = buildCsrIndex({
      docs, mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } },
      storeText: false, positions: false,
      snippet: (docId) => bodyById[docId] || '',
    });
    const r = search(idx, 'encryption');
    assert.equal(r[0].id, 'd1');
    assert.ok(r[0].snippet.includes('<mark>encryption</mark>'));
  });
  it('lean index drops the per-doc text memory line', () => {
    const idx = buildCsrIndex({ docs, mode: 'folded', storeText: false, positions: false });
    const r = search(idx, 'amy');
    // author is a field; folded search still finds it, but _publicDoc carries
    // no field text (storeText off) — only id + meta.
    assert.ok(r.length >= 1);
    assert.equal(r[0].doc.body, undefined);
  });
});
