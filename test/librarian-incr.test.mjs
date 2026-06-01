// @gcu/librarian v2 — incremental lifecycle (addDoc / removeDoc / compact).
// Gate: adds appear, removes vanish, re-add updates, compact yields identical
// results with a smaller footprint — without a full rebuild.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCsrIndex } from '../ext/librarian/src/csr.js';
import { search } from '../ext/librarian/src/search.js';
import { addDoc, removeDoc, compact, pendingCompaction } from '../ext/librarian/src/incremental.js';

function corpus() {
  return [
    { id: 'd1', title: 'Encryption', body: 'aes-gcm encryption protects notebook data' },
    { id: 'd2', title: 'Mounts', body: 'disk folders mounted at a path' },
    { id: 'd3', title: 'Filesystem', body: 'the virtual filesystem unifies storage' },
  ];
}
const ids = (r) => r.map((h) => h.id);

describe('incremental — addDoc', () => {
  it('a newly added doc appears in results (no rebuild)', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.deepEqual(ids(search(idx, 'kriging')), []);
    addDoc(idx, { id: 'd4', title: 'Kriging', body: 'ordinary kriging estimates grade' });
    assert.deepEqual(ids(search(idx, 'kriging')), ['d4']);
  });
  it('added doc is ranked together with the base', () => {
    const idx = buildCsrIndex({ docs: corpus(), fields: { title: { boost: 4 }, body: { boost: 1 } } });
    addDoc(idx, { id: 'd4', title: 'Encryption keys', body: 'key rotation' });
    const r = search(idx, 'encryption');
    assert.ok(ids(r).includes('d1') && ids(r).includes('d4'));
  });
  it('several adds between searches are O(1) each (one rebuild on search)', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    for (let i = 0; i < 20; i++) addDoc(idx, { id: 'x' + i, body: 'widget gadget ' + i });
    assert.equal(search(idx, 'widget', { limit: 50 }).length, 20);
  });
});

describe('incremental — removeDoc', () => {
  it('removing a base doc drops it from results', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.deepEqual(ids(search(idx, 'encryption')), ['d1']);
    assert.equal(removeDoc(idx, 'd1'), true);
    assert.deepEqual(ids(search(idx, 'encryption')), []);
  });
  it('removing a delta doc drops it', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    addDoc(idx, { id: 'd4', body: 'kriging variogram' });
    assert.deepEqual(ids(search(idx, 'variogram')), ['d4']);
    removeDoc(idx, 'd4');
    assert.deepEqual(ids(search(idx, 'variogram')), []);
  });
  it('removing an unknown id is a no-op returning false', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.equal(removeDoc(idx, 'nope'), false);
  });
});

describe('incremental — re-add updates (last write wins)', () => {
  it('re-adding an id replaces its content', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    addDoc(idx, { id: 'd2', title: 'Mounts', body: 'totally different replacement text quokka' });
    assert.deepEqual(ids(search(idx, 'quokka')), ['d2']);
    // old base body term should no longer match d2
    assert.ok(!ids(search(idx, 'mounted')).includes('d2'));
  });
});

describe('incremental — pendingCompaction signal', () => {
  it('reports live delta + tombstone counts', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    assert.deepEqual(pendingCompaction(idx), { delta: 0, tombstones: 0, ratio: 0 });
    addDoc(idx, { id: 'd4', body: 'foo' });
    addDoc(idx, { id: 'd5', body: 'bar' });
    removeDoc(idx, 'd1');
    const p = pendingCompaction(idx);
    assert.equal(p.delta, 2);
    assert.equal(p.tombstones, 1);
    assert.ok(p.ratio > 0);
  });
});

describe('incremental — compact', () => {
  // The correctness invariant: a compacted index is byte-for-byte equivalent to
  // a from-scratch build over the live docs (in compact order: base-live, then
  // delta-live). Scores *do* shift vs the pre-compact merged search — that read
  // scores base and delta as separately-normalized segments (segment-local idf,
  // standard for the segment model); compaction reconciles to global stats.
  const live = [
    { id: 'd1', title: 'Encryption', body: 'aes-gcm encryption protects notebook data' },
    { id: 'd3', title: 'Filesystem', body: 'the virtual filesystem unifies storage' },
    { id: 'd4', title: 'Kriging', body: 'ordinary kriging estimates grade and data' },
    { id: 'd5', title: 'Variogram', body: 'the variogram models spatial data' },
  ];
  for (const cfg of [
    { name: 'multi (storeText+positions)', opts: { fields: { title: { boost: 4 }, body: { boost: 1 } } } },
    { name: 'folded (lean)', opts: { mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false } },
  ]) {
    it(`compact == fresh build over live docs, smaller footprint — ${cfg.name}`, () => {
      const idx = buildCsrIndex({ docs: corpus(), ...cfg.opts });
      addDoc(idx, { id: 'd4', title: 'Kriging', body: 'ordinary kriging estimates grade and data' });
      addDoc(idx, { id: 'd5', title: 'Variogram', body: 'the variogram models spatial data' });
      removeDoc(idx, 'd2');
      const nBefore = idx.N;

      compact(idx);

      // Footprint: tombstoned d2 gone; base holds the 4 live docs; delta cleared.
      assert.equal(idx.N, 4, 'compacted base holds only live docs');
      assert.equal(idx._deltaDocs.length, 0, 'delta cleared after compact');
      assert.ok(!ids(search(idx, 'mounted')).includes('d2'));

      // Equivalence to a fresh build over the same live docs in compact order.
      const fresh = buildCsrIndex({ docs: live, ...cfg.opts });
      for (const q of ['encryption', 'data', 'kriging', 'variogram', 'filesystem', 'storage']) {
        const a = search(idx, q, { fuzzy: 1, limit: 10 });
        const b = search(fresh, q, { fuzzy: 1, limit: 10 });
        assert.deepEqual(ids(a), ids(b), `ids match fresh for "${q}"`);
        for (let j = 0; j < a.length; j++) {
          assert.ok(Math.abs(a[j].score - b[j].score) < 1e-9, `score matches fresh for "${q}"[${j}]`);
        }
      }
    });
  }

  it('compact is idempotent on a clean index', () => {
    const idx = buildCsrIndex({ docs: corpus() });
    compact(idx);
    assert.equal(idx.N, 3);
    assert.deepEqual(ids(search(idx, 'encryption')), ['d1']);
  });
});
