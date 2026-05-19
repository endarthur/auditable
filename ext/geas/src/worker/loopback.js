// Loopback "worker" — two paired endpoints that route postMessage calls to
// each other's listeners via queueMicrotask. Used for in-process tests so
// node --test can drive the worker harness without spawning real threads.
//
//   const { mainSide, workerSide } = createLoopback();
//   setupGeasWorker(workerSide, { createShell });
//   const client = createGeasClient({ worker: mainSide, vfs, ... });
//
// Both ends expose `addEventListener('message', cb)` / `removeEventListener`
// and `postMessage(msg)`. Messages are structured-cloned via JSON to mirror
// real Worker semantics (no shared refs across the boundary).

export function createLoopback() {
  const mainListeners = new Set();
  const workerListeners = new Set();

  const main = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of workerListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow per-listener */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') mainListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') mainListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  const worker = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of mainListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') workerListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') workerListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  return { mainSide: main, workerSide: worker };
}

// Mimic structured clone: anything JSON-safe round-trips identically;
// anything not (functions, DOM nodes, …) errors at the boundary, matching
// real postMessage semantics. ArrayBuffer / Map / Set get downgraded for v0
// (real structured clone preserves them; loopback's v0 doesn't matter for
// our message shapes which are plain JSON).
function _clone(v) {
  return JSON.parse(JSON.stringify(v));
}
