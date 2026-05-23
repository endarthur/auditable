// @gcu/proc ↔ @gcu/geas adapter.
//
// Bridges proc's Process / module-service shape to the Worker-shape that
// setupGeasWorker (worker side) and createGeasClient (main side) already
// expect. Two helpers — both small enough that the worker-side one is
// expected to be called from an inline wrapper around the geas bundle.
//
// Main side:
//   const proc = await pm.spawn({ module: workerBlobUrl, mode: 'service' });
//   const worker = procToWorker(proc);
//   const client = createGeasClient({ worker, vfs, ... });
//
// Worker side (inside the module-service entrypoint):
//   export default geasProcEntry({ createShell, isTyped, setupGeasWorker });
//
// (The dependencies of geasProcEntry are passed in because the
// module-service entrypoint runs INSIDE the inlined-bundle scope where
// createShell/isTyped/setupGeasWorker are local bindings, not imports.)

// Wrap a proc Process as a Worker-shaped object. The result quacks like a
// browser Worker (postMessage / addEventListener('message') / terminate),
// which is the interface createGeasClient consumes.
export function procToWorker(proc) {
  return {
    postMessage(msg) { proc.send(msg); },
    addEventListener(type, fn) {
      if (type === 'message') {
        proc.on((data) => fn({ data }));
      }
      // 'error' / 'messageerror' currently not forwarded — proc's lifecycle
      // surface (proc.state, proc.error, proc.wait()) covers those.
    },
    removeEventListener() {
      // proc.on returns an unsubscribe; we don't track it here because
      // createGeasClient calls removeEventListener once on teardown
      // immediately followed by proc.kill — terminate cleans up the
      // listeners regardless.
    },
    terminate() {
      try { proc.kill('KILL'); } catch (_) { /* ignore */ }
    },
  };
}

// Build a default-export entrypoint for a geas worker that runs under
// proc's module-service mode. The returned function takes the proc ctx
// (with stdin/stdout/stderr/signal/send/on/exit), builds a Worker-shaped
// target around it, hands that to setupGeasWorker, and parks on the
// signal until killed.
//
// deps: { createShell, isTyped, setupGeasWorker } — passed in because
// this module is bundled separately from the inlined geas bundle that
// owns those symbols.
export function geasProcEntry(deps) {
  const { createShell, isTyped, setupGeasWorker } = deps;
  if (typeof setupGeasWorker !== 'function') {
    throw new Error('geasProcEntry: setupGeasWorker is required');
  }
  if (typeof createShell !== 'function') {
    throw new Error('geasProcEntry: createShell is required');
  }
  return async function geasEntrypoint(ctx) {
    const target = {
      postMessage(msg) { ctx.send(msg); },
      addEventListener(type, fn) {
        if (type === 'message') {
          ctx.on((data) => fn({ data }));
        }
      },
      removeEventListener() { /* no-op — proc tears down on exit */ },
    };
    setupGeasWorker(target, { createShell, isTyped });
    // Park until killed. setupGeasWorker registered all its handlers
    // already; nothing to do here except keep the entrypoint alive so
    // proc doesn't post EXIT prematurely.
    if (ctx.signal.aborted) return;
    await new Promise((resolve) => {
      ctx.signal.addEventListener('abort', resolve);
    });
  };
}
