// Host-RPC proxy: lets a worker-hosted geas command call back into the host
// realm — the surface that owns the A-Bus connection — to run operations the
// worker can't (e.g. install a code extension whose surfaces must register in
// the shell). Symmetric with vfs-proxy.js: `serveHost(target, handler)` on the
// owning side, `createHostClient(target)` in the worker.
//
// `handler(member, args) → value` decides what a call means; the terminal
// surface forwards it to the `works` Shell over A-Bus (safelisted members).
//
// Message shapes (own namespace, won't collide with vfs/exec/stdout):
//
//   client → server:  { type: 'host-call', id, member, args }
//   server → client:  { type: 'host-reply', id, ok: true, value }
//                  |  { type: 'host-reply', id, ok: false, error: string }

// Run on the side that owns the host capability (the surface). Listens for
// host-call, dispatches to `handler`, replies. Returns a stop() function.
export function serveHost(target, handler) {
  const h = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'host-call') return;
    try {
      const value = await handler(msg.member, msg.args || []);
      target.postMessage({ type: 'host-reply', id: msg.id, ok: true, value });
    } catch (err) {
      target.postMessage({ type: 'host-reply', id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
    }
  };
  _hpAttach(target, h);
  return () => _hpDetach(target, h);
}

// Run in the worker. Returns `host(member, args) → Promise<value>`. If the
// host doesn't serve host-call (no handler wired), the promise simply never
// resolves — callers should treat a missing host bridge as "unavailable"
// before calling (ctx.host is null in those contexts).
export function createHostClient(target) {
  let nextId = 0;
  const pending = new Map();
  _hpAttach(target, (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'host-reply') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error));
  });
  return (member, args = []) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.postMessage({ type: 'host-call', id, member, args });
    });
  };
}

// ── transport helpers (same shape as vfs-proxy.js) ──
function _hpAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('host-proxy: target has no message-listener surface');
  }
}

function _hpDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
}
