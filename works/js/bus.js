// The A-Bus broker — every surface and every shell-side peer connects here.
// The shell *is* the broker (a-bus-spec §6); it lives in the shell realm.

import { createBroker } from '#abus';
import { WKS } from './state.js';

export function setupBus() {
  WKS.broker = createBroker();
}
