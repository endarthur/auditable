# @gcu/sync

Peer-to-peer state convergence over a swappable carrier — the shared sync layer
under ars (scene/object sync), federated collab (the signed event-DAG), and
multi-window Works. Extracted from [hopper](https://github.com/gentropic/hopper)'s
proven sync (set-union merge + serverless WebRTC, smoke-verified there).

Two seams; everything else composes around them.

## The channel contract (transport)

A reliable, ordered, string-message duplex pipe:

```js
{ send(str), onMessage(cb), onClose(cb), close() }
```

WebRTC, Trystero, PeerJS, an in-process pipe, even audio (chirp) are all **channel
factories** — they produce one of these. `@gcu/sync` ships `trysteroChannel(room)`
(join a room by id — no QR, no camera, no same-network); bring your own for anything
else.

## The store contract (state)

```js
{
  exportBundle()       → bundle        // serializable; shipped OPAQUELY
  importBundle(bundle) → result        // merge a peer's bundle; return a summary
  missingBlobs()       → string[]      // referenced blob hashes this store lacks
  getBlob(hash)        → bytes | null
  saveBlob(bytes)      → void          // already content-verified by the session
}
```

The bundle is **opaque to sync** — the store owns the merge semantics. This is
conflict-free for **grow-only / set-union / CRDT / append-only** state (records, a
signed event-DAG, a scene-object stream). It is **not** a co-editing engine: concurrent
text edits need OT/a text-CRDT, which is the store's problem, not this layer's.

## Usage

```js
import { syncSession, trysteroChannel } from '@gcu/sync';

const channel = await trysteroChannel(room);   // or any { send, onMessage, onClose, close }
const result  = await syncSession(channel, store);
// → { received, sent, blobs: { received, sent } }
```

`syncSession` runs the two lanes symmetrically: **values first** (each side exports →
the other imports → set-union, idempotent), then **blobs** (each requests the hashes it
now references but lacks; the peer streams them chunked; each is content-verified — its
hash IS the integrity check — before `saveBlob`). The channel is the only transport
coupling, so a new carrier is a factory, never a rewrite.

## Roadmap (carriers to lift from hopper)

- **WebRTC via QR handshake** (`handshake.js` — SDP compacted into a `q:` capsule QR);
- **chirp** — data over audio (ggwave-style positional codec);
- **PeerJS** — a channel factory over the same seam.

`@gcu/build`-bundled; zero runtime deps (content addressing is self-contained).
