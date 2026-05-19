// VFS-RPC proxy: lets a worker run geas while the actual @gcu/vfs lives
// on the main thread. Every vfs.X(...) call inside the worker round-trips
// through postMessage. Symmetric API — `serveVFS(target, vfs)` on the
// owning side, `createVfsClient(target)` on the consuming side. `target`
// is any object with `postMessage(msg)` and either `addEventListener('message', cb)`
// or settable `onmessage`.
//
// Why proxy (rather than move VFS into the worker): backends that need DOM
// access (auditable's Comment backend reads/writes a comment node) only
// work on the main thread. Proxying keeps a single VFS instance authoritative
// and lets every worker talk to it.
//
// Message shapes:
//
//   client → server:  { type: 'vfs-call', id, method, args }
//   server → client:  { type: 'vfs-reply', id, ok: true, value }
//                  |  { type: 'vfs-reply', id, ok: false, error: string }
//
// IDs are private to each direction so VFS replies can't conflict with
// other in-band messages (exec/done/stdout/etc.).

// Methods we proxy. Limited to the surface geas builtins actually call;
// add as needed.
const VFS_METHODS = [
  'readFile', 'writeFile', 'readdir', 'stat',
  'mkdir', 'unlink', 'rmdir', 'rename',
  'glob', 'exists', 'cp',
];

// Run on the side that OWNS the real VFS. Listens for vfs-call messages
// and dispatches to the real vfs, sending back vfs-reply.
//
// Returns a `stop()` function that removes the listener.
export function serveVFS(target, vfs) {
  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-call') return;
    try {
      if (typeof vfs[msg.method] !== 'function') {
        throw new Error(`vfs: unknown method "${msg.method}"`);
      }
      const value = await vfs[msg.method](...(msg.args || []));
      target.postMessage({ type: 'vfs-reply', id: msg.id, ok: true, value });
    } catch (err) {
      target.postMessage({
        type: 'vfs-reply',
        id: msg.id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  };
  _vpAttach(target, handler);
  return () => _vpDetach(target, handler);
}

// Run on the side that CONSUMES vfs through message-passing (typically
// inside a worker). Returns a vfs-shaped proxy whose every call posts a
// message and awaits its reply.
export function createVfsClient(target) {
  let nextId = 0;
  const pending = new Map();
  _vpAttach(target, (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-reply') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error));
  });

  const proxy = {};
  for (const method of VFS_METHODS) {
    proxy[method] = (...args) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ type: 'vfs-call', id, method, args });
      });
    };
  }
  return proxy;
}

// ── transport helpers ──
// Web Workers use addEventListener('message', cb); Node worker_threads use
// .on('message', cb). Our loopback target uses .addEventListener. Handle
// both shapes transparently.
function _vpAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    // Node worker_threads shape: payload arrives as the bare data, not an event.
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    // Chain so we don't blow away an existing onmessage.
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('vfs-proxy: target has no message-listener surface');
  }
}

function _vpDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
  // For onmessage-style we can't easily detach; the leak is small per worker.
}
