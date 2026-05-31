// Worker shim — run this inside the worker scope after geas is loaded.
//
// Sets up the message protocol that pairs with GeasClient on the main side.
// Owns the long-lived shell instance for this worker; survives across exec
// calls so env mutations / cwd / function definitions persist.
//
// Usage (real worker):
//
//   import { setupGeasWorker } from '@gcu/geas/worker/shim';
//   setupGeasWorker(self);
//
// Usage (in-process / tests):
//
//   setupGeasWorker(loopback.workerSide);
//
// The shim doesn't import the geas API symbols directly here — they're
// passed via the `opts.createShell` factory so the same shim works whether
// geas was bundled or imported piecewise. (Inside the runnable worker
// entry, you'd pass `createShell` from the bundle.)

import { createVfsClient } from './vfs-proxy.js';
import { createHostClient } from './host-proxy.js';

export function setupGeasWorker(target, opts) {
  const { createShell, isTyped } = opts;
  if (typeof createShell !== 'function') {
    throw new Error('setupGeasWorker: opts.createShell is required');
  }
  const vfs = createVfsClient(target);
  // Host-RPC bridge: a function (member, args) → Promise that round-trips to
  // the host realm. Harmless when the host doesn't serve host-call (the call
  // just never resolves) — registry-aware builtins only use it when present
  // and the host wired it, so this is safe to always create.
  const host = createHostClient(target);
  let shell = null;

  // Interactive read state. Each pending read has a unique id; the
  // main side answers with `input-line` / `input-eof` / `input-timeout`
  // tagged by requestId. Lines that arrive ahead of any read request
  // queue in `inputBuffer` (so `client.input("hello\n")` from a test
  // harness or programmatic driver works without an adapter loop).
  let nextReadId = 0;
  const pendingReads = new Map();
  const inputBuffer = [];
  const readLine = (lineOpts) => {
    if (inputBuffer.length > 0) {
      return Promise.resolve({ line: inputBuffer.shift() });
    }
    const id = ++nextReadId;
    return new Promise((resolve, reject) => {
      pendingReads.set(id, { resolve, reject });
      target.postMessage({ type: 'want-input', requestId: id, opts: lineOpts || {} });
    });
  };

  // Forward writes from the shell out to the main side. Typed values get
  // their own message kind so the client can route them to writeBlock.
  const stdoutFn = (v) => {
    if (v && typeof v === 'object' && v.__geas_typed === true) {
      target.postMessage({
        type: 'block',
        kind: v.kind,
        value: v.value,
        text: String(v),
      });
    } else {
      target.postMessage({ type: 'stdout', text: typeof v === 'string' ? v : String(v ?? '') });
    }
  };
  const stderrFn = (text) => {
    target.postMessage({ type: 'stderr', text: typeof text === 'string' ? text : String(text ?? '') });
  };

  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init': {
        shell = createShell({
          vfs,
          // Only expose the host bridge when the client reported it serves
          // host-call; otherwise a host() call would hang forever.
          host: msg.host ? host : null,
          env: msg.env || {},
          cwd: msg.cwd || '/',
          stdout: stdoutFn,
          stderr: stderrFn,
          readLine,
        });
        target.postMessage({ type: 'init-done' });
        return;
      }
      case 'exec': {
        if (!shell) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: 'shell not initialised',
          });
          return;
        }
        try {
          const r = await shell.exec(msg.source);
          // Report the post-exec cwd so the client can render a
          // working-directory-aware prompt without a separate query.
          target.postMessage({ type: 'done', id: msg.id, exitCode: r.exitCode ?? 0, cwd: shell.cwd });
        } catch (err) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: err && err.message ? err.message : String(err),
            cwd: shell.cwd,
          });
        }
        return;
      }
      // Programmatic input: text becomes a "line." If a `read` is
      // waiting, resolve the oldest one; otherwise queue ahead so the
      // next `read` finds it.
      case 'input': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (pendingReads.size > 0) {
          const firstId = pendingReads.keys().next().value;
          const slot = pendingReads.get(firstId);
          pendingReads.delete(firstId);
          slot.resolve({ line: text });
        } else {
          inputBuffer.push(text);
        }
        return;
      }
      // Adapter-mediated input. Matches a specific pending read by id
      // and resolves it. Three reply kinds: a successful line, EOF
      // (Ctrl+D with empty buffer), or timeout (-t expiry).
      case 'input-line': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ line: typeof msg.line === 'string' ? msg.line : '' });
        }
        return;
      }
      case 'input-eof': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ eof: true });
        }
        return;
      }
      case 'input-timeout': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ timeout: true });
        }
        return;
      }
      case 'resize':
        return;
    }
  };
  _wsAttach(target, handler);
}

function _wsAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('setupGeasWorker: target has no message-listener surface');
  }
}
