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
// Why a string-template and not a separate file? Because Phase A is a
// concat-build like the other ext/* packages. Writing the bootstrap as a
// string in source means the build doesn't need a separate emit step.
//
// The bootstrap also uses string-MSG-types directly (rather than
// importing protocol.js) because workers can't reach the registry's
// import map — and even if they could, embedding the constants by hand
// keeps the bootstrap fully self-contained.

export const BOOTSTRAP_SOURCE = `
// @gcu/proc bootstrap — runs inside every spawned worker
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
    // Best-effort close. In Node worker_threads, returning from the top
    // module is enough — the worker_threads runtime closes the worker.
    if (typeof close === 'function') {
      try { close(); } catch (_) {}
    }
  }

  function ctxStdout(text) { _post({ type: '_proc_stdout', data: String(text) }); }
  function ctxStderr(text) { _post({ type: '_proc_stderr', data: String(text) }); }

  // ── transfer auto-detection ──
  function autoTransfer(value) {
    if (value instanceof ArrayBuffer) return [value];
    if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer) {
      return [value.buffer];
    }
    return [];
  }

  // ── INT handling: kill messages fire the AbortController ──
  _onMsg(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === '_proc_kill') {
      intReceived = true;
      try { ABORT.abort(); } catch (_) {}
      // Function and module-call modes don't observe the signal; they're
      // synchronous-ish from the bootstrap's POV. If they're done already
      // this is a no-op; if they're still running, they'll be torn down by
      // the host's KILL escalation after the grace period.
      return;
    }
    if (msg.type === '_proc_init') {
      await dispatchInit(msg);
      return;
    }
    if (msg.type === '_proc_msg') {
      // Routed to service-mode handlers via the per-mode dispatcher.
      if (SERVICE_HANDLERS.length === 0) {
        // Buffer until the service handler subscribes.
        SERVICE_BUFFER.push(msg.data);
      } else {
        for (const h of SERVICE_HANDLERS) {
          try { h(msg.data); } catch (e) { _post({ type: '_proc_stderr', data: String(e && e.message || e) + '\\n' }); }
        }
      }
      return;
    }
    if (msg.type === '_proc_stdin') {
      // Buffered for service-mode ctx.stdin consumers.
      if (STDIN_WAITERS.length) {
        const w = STDIN_WAITERS.shift();
        w({ value: msg.data, done: !!msg.eof });
      } else {
        STDIN_BUFFER.push({ value: msg.data, done: !!msg.eof });
      }
      return;
    }
  });

  // Service-mode handler registry (filled when service entrypoint calls
  // ctx.on()). Buffer for messages that arrive before subscription.
  const SERVICE_HANDLERS = [];
  const SERVICE_BUFFER = [];
  const STDIN_WAITERS = [];
  const STDIN_BUFFER = [];

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
        // Replay buffered messages so subscribers don't miss anything
        // that arrived before subscription.
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

  // ── mode dispatch ──
  async function dispatchInit(msg) {
    try {
      if (msg.mode === 'function') {
        // Reconstruct the function from its serialized source.
        // The expression form is wrapped in parens so 'function(){...}'
        // parses as an expression, not a statement.
        const src = msg.source;
        const fn = (0, eval)('(' + src + ')');
        const args = Array.isArray(msg.args) ? msg.args : [];
        const result = await fn.apply(null, args);
        // Auto-transfer ArrayBuffer / TypedArray results.
        const t = autoTransfer(result);
        _post({ type: '_proc_result', value: result }, t);
        if (msg.keepalive) {
          // Pool worker — stay alive, wait for next init.
          return;
        }
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
        const ctx = makeServiceCtx();
        try {
          await entry(ctx);
          // Honor cooperative-INT exit code (130) if a kill was received
          // while the entry was running, otherwise a clean 0.
          if (!exited) exit(intReceived ? 130 : 0);
        } catch (err) {
          if (!exited) {
            _post({ type: '_proc_error', error: { message: err && err.message || String(err), stack: err && err.stack, name: err && err.name } });
            exit(1);
          }
        }
        return;
      }
      throw new Error('proc: unknown mode "' + msg.mode + '"');
    } catch (err) {
      _post({ type: '_proc_error', error: { message: err && err.message || String(err), stack: err && err.stack, name: err && err.name } });
      exit(1);
    }
  }

  // Announce we're alive and waiting for init.
  _post({ type: '_proc_ready' });
})();
`;
