// GeasClient — the main-thread facade around a worker-hosted shell.
//
//   const client = createGeasClient({
//     worker,                          // Worker-like: postMessage + onmessage / addEventListener
//     vfs,                             // @gcu/vfs instance (lives on main)
//     env, cwd,                        // initial shell env / cwd
//     onStdout, onStderr, onBlock,     // optional output sinks (defaults log to console)
//   });
//
//   await client.ready();              // resolves once the worker has init-done'd
//   const { exitCode } = await client.exec('ls /home | grep arthur');
//   await client.terminate();          // tears the worker down
//
// The client owns the VFS service-side of the RPC. It manages exec IDs so
// concurrent exec calls can be tracked (the worker serialises them one at
// a time — concurrency is a future concern; for v0 a second exec() while
// one's in flight queues client-side).

import { serveVFS } from './vfs-proxy.js';

export function createGeasClient(opts) {
  const {
    worker,
    vfs,
    env = {},
    cwd = '/',
    onStdout = (t) => { /* default: drop */ },
    onStderr = (t) => { /* default: drop */ },
    onBlock  = (b) => { /* default: render text fallback */ onStdout(b.text); },
  } = opts;
  if (!worker) throw new Error('createGeasClient: opts.worker is required');

  // Start serving VFS over the worker channel.
  const stopServe = vfs ? serveVFS(worker, vfs) : (() => {});

  // Track pending exec promises by id.
  let nextExecId = 0;
  const pendingExecs = new Map();
  let initReady = null;
  let initResolve = null;
  let initPromise = new Promise((r) => { initResolve = r; });

  const handler = (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init-done':
        initReady = true;
        initResolve();
        return;
      case 'stdout':
        onStdout(msg.text || '');
        return;
      case 'stderr':
        onStderr(msg.text || '');
        return;
      case 'block':
        onBlock({ kind: msg.kind, value: msg.value, text: msg.text });
        return;
      case 'done': {
        const slot = pendingExecs.get(msg.id);
        if (!slot) return;
        pendingExecs.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error));
        else slot.resolve({ exitCode: msg.exitCode });
        return;
      }
      // vfs-call is handled by serveVFS's own listener attached above.
    }
  };
  _wcAttach(worker, handler);

  // Kick off init.
  worker.postMessage({ type: 'init', env, cwd });

  // Serialise execs: queue them client-side so the worker only sees one at
  // a time. Simpler than expecting the worker to maintain a queue.
  let execChain = Promise.resolve({ exitCode: 0 });
  let terminated = false;

  return {
    ready: () => initPromise,

    exec(source) {
      if (terminated) return Promise.reject(new Error('geas: client terminated'));
      const next = execChain.then(async () => {
        // Re-check after awaiting the prior exec — terminate may have fired
        // while we were queued, in which case we should reject rather than
        // post a message that nothing is listening for.
        if (terminated) throw new Error('geas: client terminated');
        await initPromise;
        if (terminated) throw new Error('geas: client terminated');
        const id = nextExecId++;
        const p = new Promise((resolve, reject) => {
          pendingExecs.set(id, { resolve, reject });
        });
        worker.postMessage({ type: 'exec', id, source });
        return p;
      });
      // Chain so the next exec waits for this one to finish — but don't
      // propagate errors through the chain (an individual failure shouldn't
      // poison subsequent execs).
      execChain = next.catch(() => ({ exitCode: 1 }));
      return next;
    },

    input(text) { if (!terminated) worker.postMessage({ type: 'input', text }); },
    resize(cols, rows) { if (!terminated) worker.postMessage({ type: 'resize', cols, rows }); },

    async terminate() {
      terminated = true;
      stopServe();
      _wcDetach(worker, handler);
      if (typeof worker.terminate === 'function') {
        try { await worker.terminate(); } catch { /* ignore */ }
      }
      // Reject any execs that have already registered themselves so callers
      // don't hang waiting for a reply that will never arrive.
      for (const [, slot] of pendingExecs) {
        slot.reject(new Error('geas: client terminated'));
      }
      pendingExecs.clear();
    },
  };
}

// ── transport helpers (same shape as vfs-proxy.js) ──
function _wcAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('createGeasClient: worker has no message-listener surface');
  }
}
function _wcDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
}
