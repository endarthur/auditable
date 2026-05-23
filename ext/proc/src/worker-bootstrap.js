// @gcu/proc — worker-side bootstrap.
//
// This module exports a single string, BOOTSTRAP_SOURCE, which is the
// source code that runs *inside* every spawned worker. Manager builds a
// Worker (browser blob URL or node-worker-shim) over this source.
//
// The source itself has to be standalone — it cannot import anything from
// outside, because workers boot with no module graph. So we ship it as a
// string and inline it. It works in both browser workers and Node
// worker_threads via a small runtime detect at the top.
//
// Modes the bootstrap dispatches:
//   - function:        eval the serialized fn source, run, terminate.
//   - module-call:     await import(url), call exports[fn], terminate.
//   - module-service:  await import(url), call default(ctx), keep alive.
//   - inline-service:  wait for the inlined user code to call
//                      _procRegisterEntry(fn), then run fn(ctx).
//
// The inline-service mode exists for environments that block cross-blob
// dynamic imports — primarily Chromium under `file://`, where every blob
// URL gets a unique opaque origin and module-mode workers can't
// import(anotherBlobUrl). Manager concatenates the user's module source
// into the same blob as the bootstrap; inlined user code calls
// globalThis._procRegisterEntry(fn) at top level, and the bootstrap
// awaits that registration before running.
//
// The bootstrap also uses string-MSG-types directly (rather than
// importing protocol.js) because workers can't reach the registry's
// import map — and even if they could, embedding the constants by hand
// keeps the bootstrap fully self-contained.

export const BOOTSTRAP_SOURCE = `
// @gcu/proc bootstrap — runs inside every spawned worker

// ── inline-service registration hook ──
// Exposed at globalThis (and at the module's top-level binding via the
// concatenation) so inlined user code can register its entrypoint before
// the bootstrap dispatches the init message. Resolves the readiness
// promise the dispatcher awaits.
let _procInlineEntry = null;
let _procResolveInlineReady;
const _procInlineReady = new Promise((r) => { _procResolveInlineReady = r; });
function _procRegisterEntry(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('_procRegisterEntry(fn): fn must be a function');
  }
  _procInlineEntry = fn;
  if (_procResolveInlineReady) {
    _procResolveInlineReady();
    _procResolveInlineReady = null;
  }
}
// Expose on globalThis too so the inlined user code can call it as either
// _procRegisterEntry (top-level binding) or globalThis._procRegisterEntry.
if (typeof globalThis !== 'undefined') {
  globalThis._procRegisterEntry = _procRegisterEntry;
}

(async () => {
  // ── runtime detection ──
  let _post, _onMsg;
  if (typeof self !== 'undefined' && typeof postMessage === 'function') {
    // Browser worker (DedicatedWorkerGlobalScope)
    _post = (m, t) => self.postMessage(m, t || []);
    _onMsg = (fn) => self.addEventListener('message', (e) => fn(e.data));
  } else {
    // Node worker_threads ES module
    const wt = await import('node:worker_threads');
    _post = (m, t) => wt.parentPort.postMessage(m, t || []);
    _onMsg = (fn) => wt.parentPort.on('message', fn);
  }

  // ── shared state ──
  const ABORT = new AbortController();
  let exited = false;
  let intReceived = false;

  function exit(code = 0) {
    if (exited) return;
    exited = true;
    _post({ type: '_proc_exit', code });
    if (typeof close === 'function') {
      try { close(); } catch (_) {}
    }
  }

  function ctxStdout(text) { _post({ type: '_proc_stdout', data: String(text) }); }
  function ctxStderr(text) { _post({ type: '_proc_stderr', data: String(text) }); }

  function autoTransfer(value) {
    if (value instanceof ArrayBuffer) return [value];
    if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer) {
      return [value.buffer];
    }
    return [];
  }

  // Service-mode handler registry (filled when service entrypoint calls
  // ctx.on()). Buffer for messages that arrive before subscription.
  const SERVICE_HANDLERS = [];
  const SERVICE_BUFFER = [];
  const STDIN_WAITERS = [];
  const STDIN_BUFFER = [];

  _onMsg(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === '_proc_kill') {
      intReceived = true;
      try { ABORT.abort(); } catch (_) {}
      return;
    }
    if (msg.type === '_proc_init') {
      await dispatchInit(msg);
      return;
    }
    if (msg.type === '_proc_msg') {
      if (SERVICE_HANDLERS.length === 0) {
        SERVICE_BUFFER.push(msg.data);
      } else {
        for (const h of SERVICE_HANDLERS) {
          try { h(msg.data); } catch (e) { _post({ type: '_proc_stderr', data: String(e && e.message || e) + '\\n' }); }
        }
      }
      return;
    }
    if (msg.type === '_proc_stdin') {
      if (STDIN_WAITERS.length) {
        const w = STDIN_WAITERS.shift();
        w({ value: msg.data, done: !!msg.eof });
      } else {
        STDIN_BUFFER.push({ value: msg.data, done: !!msg.eof });
      }
      return;
    }
  });

  function makeServiceCtx() {
    return {
      signal: ABORT.signal,
      stdout: ctxStdout,
      stderr: ctxStderr,
      send: (data, transfer) => {
        _post({ type: '_proc_msg', data }, transfer || autoTransfer(data));
      },
      on: (handler) => {
        SERVICE_HANDLERS.push(handler);
        while (SERVICE_BUFFER.length) {
          const d = SERVICE_BUFFER.shift();
          try { handler(d); } catch (_) {}
        }
        return () => {
          const i = SERVICE_HANDLERS.indexOf(handler);
          if (i >= 0) SERVICE_HANDLERS.splice(i, 1);
        };
      },
      stdin: {
        async read() {
          if (STDIN_BUFFER.length) return STDIN_BUFFER.shift();
          return await new Promise((r) => STDIN_WAITERS.push(r));
        },
        [Symbol.asyncIterator]: function () { return this._asyncIter(); },
        async *_asyncIter() {
          while (true) {
            const { value, done } = await this.read();
            if (value !== undefined) yield value;
            if (done) return;
          }
        },
      },
      exit,
    };
  }

  async function runServiceEntry(entry) {
    const ctx = makeServiceCtx();
    try {
      await entry(ctx);
      if (!exited) exit(intReceived ? 130 : 0);
    } catch (err) {
      if (!exited) {
        _post({ type: '_proc_error', error: { message: err && err.message || String(err), stack: err && err.stack, name: err && err.name } });
        exit(1);
      }
    }
  }

  async function dispatchInit(msg) {
    try {
      if (msg.mode === 'function') {
        const src = msg.source;
        const fn = (0, eval)('(' + src + ')');
        const args = Array.isArray(msg.args) ? msg.args : [];
        const result = await fn.apply(null, args);
        const t = autoTransfer(result);
        _post({ type: '_proc_result', value: result }, t);
        if (msg.keepalive) return;
        exit(0);
        return;
      }
      if (msg.mode === 'module-call') {
        const mod = await import(msg.url);
        const fnName = msg.fn || 'default';
        const fn = mod[fnName];
        if (typeof fn !== 'function') {
          throw new Error('proc: module ' + msg.url + ' has no exported function "' + fnName + '"');
        }
        const args = Array.isArray(msg.args) ? msg.args : [];
        const result = await fn.apply(null, args);
        const t = autoTransfer(result);
        _post({ type: '_proc_result', value: result }, t);
        exit(0);
        return;
      }
      if (msg.mode === 'module-service') {
        const mod = await import(msg.url);
        const entry = mod.default;
        if (typeof entry !== 'function') {
          throw new Error('proc: module ' + msg.url + ' has no default export entrypoint');
        }
        await runServiceEntry(entry);
        return;
      }
      if (msg.mode === 'inline-service') {
        // Inlined user code calls _procRegisterEntry(fn) at module top
        // level; we wait briefly for that registration. If it never
        // happens, the worker bailed: surface a helpful error.
        await Promise.race([
          _procInlineReady,
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('proc: inline-service worker did not call _procRegisterEntry(fn) within 5000ms')),
            5000,
          )),
        ]);
        await runServiceEntry(_procInlineEntry);
        return;
      }
      throw new Error('proc: unknown mode "' + msg.mode + '"');
    } catch (err) {
      _post({ type: '_proc_error', error: { message: err && err.message || String(err), stack: err && err.stack, name: err && err.name } });
      exit(1);
    }
  }

  _post({ type: '_proc_ready' });
})();
`;
