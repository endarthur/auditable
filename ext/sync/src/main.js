// @gcu/sync — module manifest. Peer-to-peer state convergence over a swappable
// carrier: a transport-agnostic channel seam + a two-lane, values-first merge
// (set-union of opaque bundles + a content-verified blob lane). Carriers (Trystero,
// WebRTC/QR, PeerJS, chirp) are channel factories over the same seam.

export * from './address.js';
export * from './session.js';
export * from './trystero.js';
export * from './presence.js';
