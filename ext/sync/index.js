// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/sync — Peer-to-peer state convergence over a swappable carrier. A transport-agnostic channel seam + a two-lane, values-first merge (set-union of opaque bundles + a content-verified blob lane). Carriers (Trystero, WebRTC, PeerJS, chirp) are channel factories. Extracted from hopper; the shared sync layer under ars, federated collab, and multi-window Works.

// ── src/address.js ──

// @gcu/sync — content addressing for the blob lane. Pure, zero-dep (deliberately
// self-contained — same b64url output as @gcu/capsule, but no dependency, so the
// package stays a leaf). `crypto` is the Web Crypto global (browsers + Node ≥ 20).
//
// Lifted from hopper's records/address.js (the sync-relevant subset).

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Unpadded, URL-safe base64 of a byte sequence.
function bytesToB64Url(input) {
  const b = new Uint8Array(input);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const rem = b.length - i;
    const n = (b[i] << 16) | ((rem > 1 ? b[i + 1] : 0) << 8) | (rem > 2 ? b[i + 2] : 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (rem > 1) out += B64URL[(n >> 6) & 63];
    if (rem > 2) out += B64URL[n & 63];
  }
  return out;
}

// Inverse of bytesToB64Url. Tolerates the unpadded URL-safe form.
function b64UrlToBytes(s) {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 ? '='.repeat(4 - (std.length % 4)) : '';
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// `sha256-<b64url>` — the content address of a blob. The hash IS the integrity
// check: the blob lane re-derives this on receipt and drops any mismatch.
async function contentAddress(bytes) {
  return 'sha256-' + bytesToB64Url(await sha256(bytes));
}

// ── src/session.js ──

// @gcu/sync — the transport-agnostic merge protocol. Given any reliable, ordered
// message **channel**, two peers run a **two-lane, values-first** sync:
//
//   Lane 1 (values): each sends its `exportBundle`, the other `importBundle`s it →
//     set-union, signature-verified, idempotent, conflict-free.
//   Lane 2 (blobs): then each requests the attachment hashes it now references but
//     lacks (`missingBlobs`); the peer streams those bytes, chunked; each received blob
//     is **content-verified** (its hash *is* the integrity check) before it's stored.
//
// Symmetric — both peers do the same thing. The channel is the only transport coupling
// (`{ send, onMessage, onClose, close }`, string messages), so WebRTC / Trystero /
// PeerJS / chirp are channel FACTORIES, not rewrites. The bundle is OPAQUE to the
// session: the store owns the merge semantics (set-union / CRDT / event-DAG). A single
// message handler with both lanes' state live avoids any handler-swap race (ordered
// delivery puts lane-2 messages after lane-1).
//
// STORE CONTRACT (the consumer implements):
//   exportBundle()        → bundle           (serializable; shipped opaquely)
//   importBundle(bundle)  → result           (merge the peer's bundle; return a summary)
//   missingBlobs()        → string[]         (referenced blob hashes this store lacks)
//   getBlob(hash)         → bytes | null     (Uint8Array/ArrayBuffer)
//   saveBlob(bytes)       → void             (already content-verified by the session)
//
// Lifted from hopper's sync/session.js.


const SYNC_TIMEOUT = 30000;
const CHUNK = 48 * 1024;   // bytes/chunk → ~64 KB base64 message, safely under the DataChannel cap

function chunkBytes(u8) {
  const out = [];
  for (let i = 0; i < u8.length; i += CHUNK) out.push(u8.subarray(i, i + CHUNK));
  if (!out.length) out.push(u8.subarray(0, 0));   // 0-byte blob → one empty chunk
  return out;
}
function concatBytes(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function syncSession(channel, store) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn) => { if (finished) return; finished = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('sync timed out'))), SYNC_TIMEOUT);
    const fail = (e) => finish(() => reject(e));
    const send = (o) => channel.send(JSON.stringify(o));

    let vReceived = null, vSent = null;                       // lane 1: import results both ways
    let blobsStarted = false, myBlobsDone = false, peerBlobsDone = false, bReceived = 0, bSent = 0;
    const incoming = new Map();                                // hash → { total, parts }

    const startBlobsIfReady = async () => {
      if (blobsStarted || !(vReceived && vSent)) return;       // lane 2 begins once lane 1 is done both ways
      blobsStarted = true;
      send({ t: 'want', hashes: await store.missingBlobs() });
    };
    const tryFinish = () => {
      if (vReceived && vSent && blobsStarted && myBlobsDone && peerBlobsDone)
        finish(() => resolve({ received: vReceived, sent: vSent, blobs: { received: bReceived, sent: bSent } }));
    };

    channel.onClose(() => finish(() => reject(new Error('peer closed before sync completed'))));
    // Serialize handling: each message is fully processed (incl. its awaits — import,
    // blob save) before the next. Otherwise an awaiting `blob-chunk` handler races the
    // following `blobs-done`, finishing the session before the blob is stored.
    let chain = Promise.resolve();
    channel.onMessage((raw) => { chain = chain.then(() => handle(raw)).catch(fail); });

    async function handle(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      {
        if (m.t === 'bundle') {
          vReceived = await store.importBundle(m.bundle);
          send({ t: 'vresult', result: vReceived });
          await startBlobsIfReady();
        } else if (m.t === 'vresult') {
          vSent = m.result;
          await startBlobsIfReady();
        } else if (m.t === 'want') {                           // serve the peer the blobs it lacks (that I have)
          for (const hash of m.hashes || []) {
            const bytes = await store.getBlob(hash);
            if (!bytes) continue;
            const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const parts = chunkBytes(u8);
            send({ t: 'blob-begin', hash, total: parts.length });
            for (let i = 0; i < parts.length; i++) send({ t: 'blob-chunk', hash, seq: i, b64: bytesToB64Url(parts[i]) });
            bSent += 1;
          }
          send({ t: 'blobs-done' });
          myBlobsDone = true; tryFinish();
        } else if (m.t === 'blob-begin') {
          incoming.set(m.hash, { total: m.total, parts: new Array(m.total).fill(null) });   // dense — .every() skips holes
        } else if (m.t === 'blob-chunk') {
          const e = incoming.get(m.hash); if (!e) return;
          e.parts[m.seq] = b64UrlToBytes(m.b64);
          if (e.parts.every(Boolean) || e.total === 0) {
            incoming.delete(m.hash);
            const bytes = concatBytes(e.parts);
            if ((await contentAddress(bytes)) === m.hash) { await store.saveBlob(bytes); bReceived += 1; }
            // else: corrupt / tampered (hash mismatch) → dropped, stays "missing"
          }
        } else if (m.t === 'blobs-done') {
          peerBlobsDone = true; tryFinish();
        }
      }
    }

    Promise.resolve(store.exportBundle()).then((b) => send({ t: 'bundle', bundle: b })).catch(fail);
  });
}

// ── src/trystero.js ──

// @gcu/sync — Trystero carrier. Adapt a Trystero room to the syncSession channel
// contract ({ send, onMessage, onClose, close }), so two devices reconcile by joining
// a room by id: no QR, no camera, no same-network requirement. A convenience carrier
// over public signaling (BitTorrent / Nostr / MQTT). The merge protocol, set-union, and
// blob lane are unchanged: this is a channel FACTORY, not a rewrite.
//
// `trysteroChannel(room)` takes a JOINED room — joinRoom(config, roomId)'s return,
// `{ makeAction, onPeerJoin, onPeerLeave, leave }` — and resolves to a 1:1 channel once
// a peer is present (locking onto the first joiner; others ignored for v1). The room is
// INJECTED, so this is unit-testable with a mock and independent of any vendored bundle;
// production wiring imports the vendored `joinRoom` and hands it in.
//
// Lifted from hopper's sync/trystero.js.

const PEER_TIMEOUT = 60000;          // a minute to get the second device into the room
const SYNC_ACTION = 'hsync';         // ≤12 bytes — Trystero's action-name cap

function trysteroChannel(room, opts = {}) {
  const timeoutMs = opts.timeout ?? PEER_TIMEOUT;
  const [sendSync, getSync] = room.makeAction(SYNC_ACTION);
  return new Promise((resolve, reject) => {
    let peer = null, onMsg = null, onClose = null, settled = false;
    const buffer = [];                                          // messages that beat onMessage registration
    const timer = timeoutMs ? setTimeout(() => {
      if (!settled) { settled = true; try { room.leave(); } catch {} reject(new Error('no peer joined the room')); }
    }, timeoutMs) : null;

    getSync((payload, fromId) => {
      if (peer && fromId !== peer) return;                      // 1:1 — ignore other peers
      if (onMsg) onMsg(payload); else buffer.push(payload);
    });
    room.onPeerLeave((id) => { if (id === peer && onClose) onClose(); });
    room.onPeerJoin((id) => {
      if (peer) return;                                         // lock onto the first peer
      peer = id;
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      resolve({
        peerId: peer,
        send: (msg) => sendSync(msg, peer),
        onMessage: (cb) => { onMsg = cb; const pending = buffer.splice(0); for (const m of pending) cb(m); },
        onClose: (cb) => { onClose = cb; },
        close: () => { try { room.leave(); } catch {} },
      });
    });
  });
}

// ── src/main.js ──

// @gcu/sync — module manifest. Peer-to-peer state convergence over a swappable
// carrier: a transport-agnostic channel seam + a two-lane, values-first merge
// (set-union of opaque bundles + a content-verified blob lane). Carriers (Trystero,
// WebRTC/QR, PeerJS, chirp) are channel factories over the same seam.

export {
  bytesToB64Url,
  b64UrlToBytes,
  sha256,
  contentAddress,
  syncSession,
  trysteroChannel,
};
