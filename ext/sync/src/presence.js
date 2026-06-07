// @gcu/sync — presence: N-way EPHEMERAL shared state over a room.
//
// The other half of the federation story from syncSession (which is 1:1 + persistent
// + merged). Presence is the opposite shape: many peers, no persistence, no merge —
// each peer broadcasts its OWN small state ("I'm here, I'm called X, I'm on cell N")
// and you display everyone else's. Nothing a peer sends is ever applied to your own
// state or executed — it's cosmetic display only — which is exactly why a presence
// consumer is benign by construction (a malicious peer can show a fake ghost; that's
// the whole blast radius).
//
// Takes a Trystero-shaped room ({ makeAction, onPeerJoin, onPeerLeave, leave }) —
// INJECTED, so this is pure + unit-testable with a mock and free of any vendored lib.

export function roomPresence(room, opts = {}) {
  const [send, get] = room.makeAction(opts.action || 'pres');
  const peers = new Map();          // peerId → their last broadcast state (opaque to us)
  const listeners = new Set();
  let self = null;

  const fire = () => { for (const cb of listeners) cb(peers); };

  get((state, fromId) => { peers.set(fromId, state); fire(); });
  // Greet a newly-arrived peer with our current state so they see us immediately
  // (broadcasts only reach peers present at send time).
  room.onPeerJoin((id) => { if (self != null) send(self, id); });
  room.onPeerLeave((id) => { if (peers.delete(id)) fire(); });

  return {
    // Set + broadcast our own presence state (call again to update).
    set(state) { self = state; send(state); },
    // Live map of peerId → their state. Read-only display data.
    peers: () => peers,
    // Subscribe to any change (peer joined/updated/left). Returns an unsubscribe.
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    leave() { try { room.leave(); } catch {} peers.clear(); fire(); },
  };
}
