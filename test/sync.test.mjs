// @gcu/sync — the transport-agnostic merge protocol + the Trystero carrier.
// Tests the protocol against the STORE CONTRACT (a tiny mock store), not any
// concrete store — set-union merge, idempotence, the content-verified blob lane,
// and a Trystero-room round-trip over a mock net.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncSession } from '../ext/sync/src/session.js';
import { trysteroChannel } from '../ext/sync/src/trystero.js';
import { contentAddress } from '../ext/sync/src/address.js';

// A minimal store implementing the contract: records unioned by id, blobs by hash.
function makeStore() {
  const records = new Map();
  const blobs = new Map();
  const liars = new Map(); // hash → wrong bytes (forces a content-verify failure)
  return {
    records, blobs,
    add(rec) { records.set(rec.id, rec); return this; },
    async addBlob(bytes) { const h = await contentAddress(bytes); blobs.set(h, bytes); return h; },
    lie(hash, bytes) { liars.set(hash, bytes); },
    async exportBundle() { return { records: [...records.values()] }; },
    async importBundle(b) {
      let n = 0;
      for (const r of (b.records || [])) if (!records.has(r.id)) { records.set(r.id, r); n++; }
      return { records: n };
    },
    async missingBlobs() {
      const refd = new Set();
      for (const r of records.values()) if (r.blob) refd.add(r.blob);
      return [...refd].filter((h) => !blobs.has(h));
    },
    async getBlob(h) { return liars.has(h) ? liars.get(h) : (blobs.get(h) || null); },
    async saveBlob(bytes) { blobs.set(await contentAddress(bytes), bytes); },
  };
}

// In-memory channel pair: { send, onMessage, onClose, close }, async delivery.
function pipe() {
  const ends = [{ h: {} }, { h: {} }];
  const wire = (self, peer) => Object.assign(self, {
    send: (m) => { Promise.resolve().then(() => peer.h.message && peer.h.message(m)); },
    onMessage: (cb) => { self.h.message = cb; },
    onClose: (cb) => { self.h.close = cb; },
    close: () => { Promise.resolve().then(() => peer.h.close && peer.h.close()); },
  });
  wire(ends[0], ends[1]); wire(ends[1], ends[0]);
  return ends;
}

test('syncSession: two peers union their records (set-union, both ways)', async () => {
  const A = makeStore().add({ id: 'a1', v: 'A' });
  const B = makeStore().add({ id: 'b1', v: 'B' });
  const [ca, cb] = pipe();
  const [ra, rb] = await Promise.all([syncSession(ca, A), syncSession(cb, B)]);
  assert.equal(ra.received.records, 1);
  assert.equal(rb.received.records, 1);
  assert.deepEqual([...A.records.keys()].sort(), ['a1', 'b1']);
  assert.deepEqual([...B.records.keys()].sort(), ['a1', 'b1']);
});

test('syncSession: idempotent — re-syncing adds nothing', async () => {
  const A = makeStore().add({ id: 'a1' });
  const B = makeStore().add({ id: 'b1' });
  const [c1a, c1b] = pipe();
  await Promise.all([syncSession(c1a, A), syncSession(c1b, B)]);
  const [c2a, c2b] = pipe();
  const [ra] = await Promise.all([syncSession(c2a, A), syncSession(c2b, B)]);
  assert.equal(ra.received.records, 0, 'nothing new the second time');
  assert.equal(A.records.size, 2);
});

test('syncSession: blob lane streams + content-verifies referenced blobs', async () => {
  const A = makeStore();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const h = await A.addBlob(bytes);
  A.add({ id: 'a1', blob: h });
  const B = makeStore();
  const [ca, cb] = pipe();
  const [ra] = await Promise.all([syncSession(ca, A), syncSession(cb, B)]);
  assert.equal(ra.blobs.sent, 1, 'A served one blob');
  assert.ok(B.blobs.has(h), 'B received the referenced blob');
  assert.deepEqual([...B.blobs.get(h)], [1, 2, 3, 4, 5]);
});

test('syncSession: a blob whose bytes do not match its hash is dropped', async () => {
  const A = makeStore();
  const bytes = new Uint8Array([10, 20, 30]);
  const h = await A.addBlob(bytes);
  A.add({ id: 'a1', blob: h });
  A.lie(h, new Uint8Array([9, 9, 9])); // getBlob(h) returns the wrong bytes
  const B = makeStore();
  const [ca, cb] = pipe();
  await Promise.all([syncSession(ca, A), syncSession(cb, B)]);
  assert.ok(B.records.has('a1'), 'the record still merged');
  assert.ok(!B.blobs.has(h), 'the tampered blob was rejected (hash mismatch)');
});

// A faithful mock of the Trystero room surface trysteroChannel uses.
function mockNet() {
  const peers = new Map();
  const makeRoom = (selfId) => {
    const rec = { getters: {}, joinCbs: [], leaveCbs: [] };
    peers.set(selfId, rec);
    return {
      makeAction(name) {
        const send = (data, target) => {
          for (const [id, r] of peers) {
            if (id === selfId || (target && id !== target)) continue;
            for (const cb of (r.getters[name] || [])) queueMicrotask(() => cb(data, selfId));
          }
        };
        const get = (cb) => { (rec.getters[name] = rec.getters[name] || []).push(cb); };
        return [send, get];
      },
      onPeerJoin(cb) { rec.joinCbs.push(cb); },
      onPeerLeave(cb) { rec.leaveCbs.push(cb); },
      leave() { peers.delete(selfId); for (const [, r] of peers) for (const cb of r.leaveCbs) queueMicrotask(() => cb(selfId)); },
    };
  };
  const announce = () => {
    const ids = [...peers.keys()];
    for (const a of ids) for (const b of ids) if (a !== b) for (const cb of peers.get(a).joinCbs) queueMicrotask(() => cb(b));
  };
  return { makeRoom, announce };
}

test('trysteroChannel: peers union by joining a room (carrier round-trip)', async () => {
  const A = makeStore().add({ id: 'a1' });
  const B = makeStore().add({ id: 'b1' });
  const net = mockNet();
  const pa = trysteroChannel(net.makeRoom('A'), { timeout: 0 });
  const pb = trysteroChannel(net.makeRoom('B'), { timeout: 0 });
  net.announce();
  const [ca, cb] = await Promise.all([pa, pb]);
  await Promise.all([syncSession(ca, A), syncSession(cb, B)]);
  assert.deepEqual([...A.records.keys()].sort(), ['a1', 'b1']);
  assert.deepEqual([...B.records.keys()].sort(), ['a1', 'b1']);
});
