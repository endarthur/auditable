// @gcu/abus — a D-Bus-shaped coordination bus for Auditable Works panels,
// notebooks, and workers.
//
// Module manifest:
//   protocol.js — wire constants, name/path validation, AbusError, helpers
//   broker.js   — createBroker(): the name registry + pure synchronous router
//   client.js   — connect(): the peer-facing bus (calls, signals, expose, …)

export * from './protocol.js';
export * from './broker.js';
export * from './client.js';
