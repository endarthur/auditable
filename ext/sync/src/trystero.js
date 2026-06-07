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

export function trysteroChannel(room, opts = {}) {
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
