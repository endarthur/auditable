// The A-Bus broker — every surface and every shell-side peer connects here.
// The shell *is* the broker (a-bus-spec §6); it lives in the shell realm.

import { createBroker } from '#abus';
import { WKS } from './state.js';

export function setupBus() {
  WKS.broker = createBroker();
  // Capability-security §4: the first real gate. Inspect.Snapshot returns the
  // whole broker topology — peers, names, subscriptions, AND the capability
  // grants — so it's privileged; until now any connected surface could read it.
  // Gate just that interface (VFS/Shell/Updates stay open — no big bang); the
  // shell grants the trusted built-in inspector surface at spawn (surfaces.js).
  WKS.broker.gate('works', { interfaces: ['Inspect'] });
}
