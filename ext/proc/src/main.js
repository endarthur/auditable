// @gcu/proc — a process model for the browser. Phase A.
//
// Module manifest:
//   protocol.js          — wire constants, reserved message types, helpers
//   channel.js           — ReadablePort / WritablePort I/O wrappers
//   process.js           — Process class (lifecycle, state machine, I/O facade)
//   manager.js           — ProcessManager (table, spawn, kill, list)
//   pool.js              — Pool (keepalive workers, free-queue dispatch)
//   worker-bootstrap.js  — exports the bootstrap source string (runs inside workers)
//
// The Node worker_threads adapter lives in node-worker-shim.js, exported
// separately from package.json under the "./node" path so the browser
// bundle doesn't pull in worker_threads.

export * from './protocol.js';
export * from './channel.js';
export * from './process.js';
export * from './manager.js';
export * from './pool.js';
export { BOOTSTRAP_SOURCE } from './worker-bootstrap.js';
