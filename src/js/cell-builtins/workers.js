// worker(fn) / workerPool(fn, n) — offload pure computation to Web Workers.
//
// Backed by @gcu/proc Phase A. The public API surface is unchanged: closures
// are stripped (function source is serialized), TypedArray buffers in args
// and return values are transferred zero-copy, and workers auto-terminate on
// cell re-run via the invalidation hook.

import { ProcessManager } from '#proc';

// One shared manager across all cells. createPool() inside the manager
// gives each worker()/workerPool() call its own keepalive worker set; the
// shared manager just owns the process table and applies maxProcesses
// globally if anyone sets it.
let _sharedManager = null;
function getManager() {
  if (!_sharedManager) _sharedManager = new ProcessManager();
  return _sharedManager;
}

export function makeWorker(cell, ctx) {
  const { invalidation } = ctx;

  return function worker(fn) {
    // worker(fn) is a pool-of-1 with keepalive semantics: one worker stays
    // alive across calls, calls queue if a previous call is in flight.
    const pool = getManager().createPool(1);
    const call = pool.asCallable(fn);
    invalidation.then(() => { try { call.terminate(); } catch (_) {} });
    return call;
  };
}

export function makeWorkerPool(cell, ctx) {
  const { invalidation } = ctx;

  return function workerPool(fn, n) {
    const size = n || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const pool = getManager().createPool(size);
    const call = pool.asCallable(fn);
    invalidation.then(() => { try { call.terminate(); } catch (_) {} });
    return call;
  };
}
