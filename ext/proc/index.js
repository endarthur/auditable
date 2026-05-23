// @gcu/proc — process model for the browser (Phase A: function / module-call / module-service modes)
// Auto-generated from ext/proc/src/ — do not edit directly

// -- protocol.js --

// @gcu/proc — wire protocol constants and helpers.
//
// Pure module: zero imports, safe in any JS environment (browser, worker,
// Node). All other proc modules build on this.

const PROTOCOL_VERSION = '0.1';

// Reserved namespace for proc lifecycle messages. User-protocol messages
// ride on MSG.MSG (wrapped via proc.send/ctx.send) so they can never
// collide with proc's own messages. See SPEC.md §4.
const MSG = Object.freeze({
  // Host → worker
  INIT:   '_proc_init',
  STDIN:  '_proc_stdin',
  KILL:   '_proc_kill',
  // Worker → host
  READY:  '_proc_ready',
  RESULT: '_proc_result',
  ERROR:  '_proc_error',
  EXIT:   '_proc_exit',
  STDOUT: '_proc_stdout',
  STDERR: '_proc_stderr',
  // Bidirectional (custom protocol wrapper)
  MSG:    '_proc_msg',
});

const MODE = Object.freeze({
  FUNCTION:    'function',
  MODULE_CALL: 'module-call',
  SERVICE:     'module-service',
});

const STATE = Object.freeze({
  RUNNING: 'running',
  DONE:    'done',
  KILLED:  'killed',
  ERROR:   'error',
  TIMEOUT: 'timeout',
});

const EXIT = Object.freeze({
  OK:      0,
  ERROR:   1,
  TIMEOUT: 124,
  INT:     130,   // 128 + SIGINT
  KILL:    137,   // 128 + SIGKILL
});

// Process IDs are unique per ProcessManager, monotonically increasing.
function makePidGen(start = 1) {
  let next = start;
  return () => next++;
}

// Serialize an Error to a plain object so it survives postMessage cleanly
// across both browser and Node. The browser structured-clones Error fine;
// Node's worker_threads sometimes drops stack frames. Going through
// {message, stack} keeps both consistent.
function serializeError(err) {
  if (err == null) return { message: String(err) };
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  if (typeof err === 'object') {
    return { message: err.message || String(err), stack: err.stack };
  }
  return { message: String(err) };
}

// Reconstruct an Error from a serialized form.
function deserializeError(obj) {
  if (!obj) return new Error('unknown error');
  const e = new Error(obj.message || 'unknown error');
  if (obj.stack) e.stack = obj.stack;
  if (obj.name) e.name = obj.name;
  return e;
}

// Auto-detect transferable buffers in an array of values. Mirrors the
// existing worker() builtin's behavior: ArrayBuffers and TypedArrays are
// transferred zero-copy unless the caller already specified transfer.
function detectTransfer(values) {
  if (!Array.isArray(values)) return [];
  const transfer = [];
  for (const v of values) {
    if (v instanceof ArrayBuffer) {
      transfer.push(v);
    } else if (v && typeof v === 'object' && v.buffer instanceof ArrayBuffer) {
      transfer.push(v.buffer);
    }
  }
  return transfer;
}

// Worker-side message-listener attach (browser Worker / worker_threads
// shim both expose addEventListener after the shim layer). Returns an
// unsubscribe.
function attachMessage(target, handler) {
  if (typeof target.addEventListener === 'function') {
    const wrapped = (e) => handler(e && 'data' in e ? e.data : e);
    target.addEventListener('message', wrapped);
    return () => target.removeEventListener('message', wrapped);
  }
  if (typeof target.on === 'function') {
    const wrapped = (data) => handler(data);
    target.on('message', wrapped);
    return () => target.off && target.off('message', wrapped);
  }
  throw new Error('proc: target has no message-listener surface');
}

// -- channel.js --

// @gcu/proc — I/O channels.
//
// ReadablePort and WritablePort are thin wrappers around the worker's
// message channel. Each Process owns one ReadablePort each for stdout
// and stderr, and one WritablePort for stdin.
//
// Internally they're not real MessagePort instances — they're shims over
// the worker's main message channel, multiplexed by message type (see
// MSG.STDOUT / MSG.STDERR / MSG.STDIN in protocol.js). This is simpler
// than minting a MessageChannel per stream and works the same on browser
// and Node.


// A readable stream of chunks. Chunks arrive via _deliver(chunk) from
// the owning Process, and consumers read them via onData(), text(), or
// async iteration. Closed by _close() when the process exits.
class ReadablePort {
  constructor() {
    this._closed = false;
    this._buffer = [];               // chunks arrived before a consumer
    this._listeners = new Set();     // onData callbacks
    this._waiters = [];              // pending async iterator readers
  }

  // Subscribe to streaming chunks. Returns an unsubscribe function.
  onData(callback) {
    if (typeof callback !== 'function') throw new TypeError('onData(callback)');
    // Replay any buffered chunks to the new listener first so it doesn't
    // miss data that arrived before subscription.
    for (const chunk of this._buffer) {
      try { callback(chunk); } catch { /* swallow listener errors */ }
    }
    this._buffer.length = 0;
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  // Collect everything to EOF.
  async text() {
    if (this._closed) {
      const out = this._buffer.join('');
      this._buffer.length = 0;
      return out;
    }
    const chunks = [...this._buffer];
    this._buffer.length = 0;
    return await new Promise((resolve) => {
      const unsub = this.onData((chunk) => chunks.push(chunk));
      this._waiters.push(() => {
        unsub();
        resolve(chunks.join(''));
      });
    });
  }

  // Async iterator — yields chunks until close.
  async *[Symbol.asyncIterator]() {
    const queue = [];
    let notify = null;
    let done = false;

    const unsub = this.onData((chunk) => {
      queue.push(chunk);
      if (notify) { const n = notify; notify = null; n(); }
    });

    const closeWaiter = () => {
      done = true;
      if (notify) { const n = notify; notify = null; n(); }
    };
    if (this._closed) closeWaiter();
    else this._waiters.push(closeWaiter);

    try {
      while (true) {
        if (queue.length) {
          yield queue.shift();
        } else if (done) {
          return;
        } else {
          await new Promise((r) => { notify = r; });
        }
      }
    } finally {
      unsub();
    }
  }

  // Internal — called by the Process when a chunk arrives.
  _deliver(chunk) {
    if (this._closed) return;
    if (this._listeners.size === 0) {
      this._buffer.push(chunk);
    } else {
      for (const cb of this._listeners) {
        try { cb(chunk); } catch { /* swallow */ }
      }
    }
  }

  // Internal — called by the Process on exit.
  _close() {
    if (this._closed) return;
    this._closed = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      try { w(); } catch { /* swallow */ }
    }
  }
}

// A writable stream. Writes go out as MSG.STDIN messages to the worker.
// In Phase A only module-service workers actually read from stdin; the
// function/module-call bootstraps don't consume it.
class WritablePort {
  constructor(send) {
    this._send = send;
    this._closed = false;
  }

  write(data) {
    if (this._closed) throw new Error('proc: stdin closed');
    this._send({ type: MSG.STDIN, data });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._send({ type: MSG.STDIN, eof: true });
  }
}

// -- worker-bootstrap.js --

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

const BOOTSTRAP_SOURCE = `
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

// -- process.js --

// @gcu/proc — Process class.
//
// One Process per worker. Owns the worker handle, state machine, I/O
// channels, and the wire-protocol routing. The ProcessManager creates
// these; consumers receive them from pm.spawn().


class Process {
  constructor({ pid, mode, worker, cleanup, command }) {
    this.pid = pid;
    this.mode = mode;
    this.command = command || '';
    this.state = STATE.RUNNING;
    this.startTime = new Date();
    this.duration = null;
    this.exitCode = null;
    this.result = undefined;
    this.error = null;

    this._worker = worker;
    this._cleanup = cleanup || (() => {});
    this._exitWaiters = [];
    this._msgHandlers = new Set();
    this._readySignal = null;          // resolved by READY message
    this._readyPromise = new Promise((r) => { this._readySignal = r; });
    this._terminated = false;
    this._killTimer = null;
    this._timeoutTimer = null;

    this.stdout = new ReadablePort();
    this.stderr = new ReadablePort();
    this.stdin = new WritablePort((m) => this._post(m));

    this._detachMessage = attachMessage(worker, (msg) => this._onMessage(msg));
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('error', (e) => this._onWorkerError(e));
    } else if (typeof worker.on === 'function') {
      worker.on('error', (e) => this._onWorkerError(e));
    }
  }

  // Send a custom-protocol message to the worker (service mode).
  send(data, transfer) {
    if (this.mode !== MODE.SERVICE) {
      throw new Error('proc.send() requires module-service mode');
    }
    this._post({ type: MSG.MSG, data }, transfer);
  }

  // Subscribe to custom-protocol messages from the worker. Returns an
  // unsubscribe function.
  on(handler) {
    if (typeof handler !== 'function') throw new TypeError('proc.on(handler)');
    this._msgHandlers.add(handler);
    return () => this._msgHandlers.delete(handler);
  }

  // Wait until the worker posts READY (bootstrap loaded). Used by
  // ProcessManager so it can return a Process that's confirmed alive.
  ready() {
    return this._readyPromise;
  }

  // Resolves when the process leaves the running state. Returns exitCode.
  wait() {
    if (this.state !== STATE.RUNNING) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => { this._exitWaiters.push(resolve); });
  }

  // Send a signal. INT is cooperative (fires the worker's AbortController);
  // KILL is forceful (worker.terminate()). Default: INT.
  kill(signal = 'INT') {
    if (this.state !== STATE.RUNNING) return;
    if (signal === 'KILL') {
      this._forceKill();
      return;
    }
    // Cooperative kill — let the worker bail out, escalate to KILL after
    // the grace period.
    try {
      this._post({ type: MSG.KILL, signal });
    } catch { /* worker may already be gone */ }
    if (!this._killTimer) {
      this._killTimer = setTimeout(() => this._forceKill(), this._killGrace || 1000);
    }
  }

  // ── Internals ──

  _post(message, transfer) {
    if (this._terminated) return;
    try {
      this._worker.postMessage(message, transfer || []);
    } catch (err) {
      // postMessage can throw if the worker terminated mid-flight; treat
      // as a clean teardown rather than crashing the manager.
      this._onWorkerError(err);
    }
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case MSG.READY:
        if (this._readySignal) {
          const r = this._readySignal;
          this._readySignal = null;
          r();
        }
        return;
      case MSG.STDOUT:
        this.stdout._deliver(msg.data || '');
        return;
      case MSG.STDERR:
        this.stderr._deliver(msg.data || '');
        return;
      case MSG.RESULT:
        this.result = msg.value;
        return;
      case MSG.ERROR:
        this.error = deserializeError(msg.error);
        return;
      case MSG.EXIT:
        this._finish(msg.code);
        return;
      case MSG.MSG: {
        const data = msg.data;
        for (const h of this._msgHandlers) {
          try { h(data); } catch { /* swallow */ }
        }
        return;
      }
      default:
        // Unknown lifecycle messages are ignored — gives the protocol
        // room to grow.
        return;
    }
  }

  _onWorkerError(err) {
    if (this.state !== STATE.RUNNING) return;
    this.error = err instanceof Error ? err : new Error(String(err && err.message || err));
    this._finish(EXIT.ERROR, STATE.ERROR);
  }

  _forceKill() {
    if (this._terminated) return;
    try { this._worker.terminate(); } catch { /* ignore */ }
    this._finish(EXIT.KILL, STATE.KILLED);
  }

  _finish(code, forcedState) {
    if (this._terminated) return;
    this._terminated = true;

    // Resolve state. If a forced state was passed (timeout, kill, error)
    // honor it; otherwise infer from the exit code.
    if (forcedState) {
      this.state = forcedState;
    } else if (this.error) {
      this.state = STATE.ERROR;
    } else if (code === EXIT.OK) {
      this.state = STATE.DONE;
    } else if (code === EXIT.INT) {
      this.state = STATE.KILLED;
    } else if (code === EXIT.TIMEOUT) {
      this.state = STATE.TIMEOUT;
    } else {
      this.state = STATE.ERROR;
    }
    this.exitCode = code;
    this.duration = Date.now() - this.startTime.getTime();

    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    if (this._timeoutTimer) { clearTimeout(this._timeoutTimer); this._timeoutTimer = null; }

    if (this._detachMessage) {
      try { this._detachMessage(); } catch { /* ignore */ }
    }
    try { this._worker.terminate(); } catch { /* worker may already be dead */ }
    try { this._cleanup(); } catch { /* ignore */ }

    // Close I/O streams so consumers' text() / async iterators resolve.
    this.stdout._close();
    this.stderr._close();

    // Resolve the ready promise so callers awaiting it don't hang.
    if (this._readySignal) {
      const r = this._readySignal;
      this._readySignal = null;
      r();
    }

    // Resolve all wait() callers.
    const waiters = this._exitWaiters;
    this._exitWaiters = [];
    for (const w of waiters) {
      try { w(this.exitCode); } catch { /* ignore */ }
    }
  }
}

// -- pool.js --

// @gcu/proc — Pool.
//
// A pool keeps N workers alive across many task dispatches. Each worker
// boots in function mode with { keepalive: true } so the bootstrap
// doesn't terminate after the first result. Subsequent tasks are sent as
// new _proc_init messages on the same worker.
//
// Dispatch is free-queue, not round-robin: the first free worker takes
// the next task. This avoids dispatching to a busy worker just because
// it's next in rotation.




class Pool {
  constructor(manager, size) {
    this._manager = manager;
    this._size = size;
    this._workers = [];          // PoolWorker objects
    this._free = [];             // currently-idle PoolWorker objects
    this._queue = [];            // { fn, args, opts, resolve, reject }
    this._terminated = false;
    this._spawnPromise = this._spawnAll();
  }

  async _spawnAll() {
    const promises = [];
    for (let i = 0; i < this._size; i++) {
      promises.push(this._spawnOne());
    }
    await Promise.all(promises);
  }

  async _spawnOne() {
    const { worker, cleanup } = this._manager._createWorker(BOOTSTRAP_SOURCE);
    const pid = this._manager._nextPid();
    const proc = new Process({
      pid,
      mode: MODE.FUNCTION,
      worker,
      cleanup,
      command: '<pool>',
    });
    this._manager._processes.set(pid, proc);
    await proc.ready();

    const pw = { proc, busy: false, currentResolve: null, currentReject: null };

    // Intercept RESULT/ERROR/EXIT before Process's default handler so we
    // can recycle the worker for the next task. Process.onMessage's
    // default behavior would mark the worker as exited on RESULT — but in
    // pool mode the worker stays alive after each result.
    const orig = proc._onMessage.bind(proc);
    proc._onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') { orig(msg); return; }

      if (msg.type === MSG.RESULT) {
        const r = pw.currentResolve;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        // Update proc.result for diag (Process's orig() also sets it, but
        // calling orig() with RESULT is fine since RESULT doesn't change
        // state by itself in Process — only EXIT does).
        proc.result = msg.value;
        if (r) r(msg.value);
        this._returnToFree(pw);
        return;
      }

      if (msg.type === MSG.ERROR) {
        const j = pw.currentReject;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        // Capture the error on proc.error for diag, but DON'T let Process
        // transition to ERROR state (we want to keep the worker alive).
        try {
          proc.error = msg.error && msg.error.message
            ? Object.assign(new Error(msg.error.message), { stack: msg.error.stack })
            : new Error('pool worker error');
        } catch (_) {}
        if (j) j(proc.error);
        this._returnToFree(pw);
        return;
      }

      if (msg.type === MSG.EXIT) {
        // Worker died unexpectedly. Reject the current task (if any) and
        // remove from the pool.
        const j = pw.currentReject;
        pw.currentResolve = null;
        pw.currentReject = null;
        pw.busy = false;
        orig(msg);
        if (j) j(new Error('pool worker exited unexpectedly (code ' + msg.code + ')'));
        this._removeWorker(pw);
        return;
      }

      orig(msg);
    };

    this._workers.push(pw);
    this._free.push(pw);
    this._dispatch();
  }

  // Run a function on a free pool worker. Returns the function's result.
  async exec(fn, args = [], opts = {}) {
    if (this._terminated) throw new Error('pool: terminated');
    await this._spawnPromise;
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, args, opts, resolve, reject });
      this._dispatch();
    });
  }

  // Map across an array. Each item is passed as the first arg; extra
  // args from opts.extra are appended.
  async map(items, fn, opts = {}) {
    const extra = opts.extra || [];
    return Promise.all(items.map((item) => this.exec(fn, [item, ...extra], opts)));
  }

  // Replicate auditable's workerPool() builtin shape: callable that
  // takes args and returns the result. Each call goes to a free worker.
  // Used by the legacy worker()/workerPool() compatibility shim.
  asCallable(fn) {
    const call = (...args) => this.exec(fn, args);
    call.map = (arr, ...extra) => this.map(arr, fn, { extra });
    call.terminate = () => this.terminate();
    return call;
  }

  list() {
    return this._workers.map((pw) => ({
      pid: pw.proc.pid,
      busy: pw.busy,
      state: pw.proc.state,
    }));
  }

  terminate() {
    if (this._terminated) return;
    this._terminated = true;
    for (const pw of this._workers) {
      try { pw.proc.kill('KILL'); } catch (_) {}
      if (pw.currentReject) {
        try { pw.currentReject(new Error('pool: terminated')); } catch (_) {}
      }
    }
    this._workers.length = 0;
    this._free.length = 0;
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) {
      try { q.reject(new Error('pool: terminated')); } catch (_) {}
    }
  }

  // ── Internals ──

  _dispatch() {
    while (this._queue.length && this._free.length) {
      const pw = this._free.shift();
      const task = this._queue.shift();
      pw.busy = true;
      pw.currentResolve = task.resolve;
      pw.currentReject = task.reject;
      const transfer = task.opts.transfer && task.opts.transfer.length
        ? task.opts.transfer
        : detectTransfer(task.args);
      try {
        pw.proc._worker.postMessage({
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: task.fn.toString(),
          args: task.args,
          keepalive: true,
        }, transfer);
      } catch (err) {
        pw.busy = false;
        pw.currentResolve = null;
        pw.currentReject = null;
        this._free.push(pw);
        task.reject(err);
      }
    }
  }

  _returnToFree(pw) {
    if (this._terminated) return;
    if (this._workers.indexOf(pw) < 0) return;
    if (this._free.indexOf(pw) < 0) this._free.push(pw);
    this._dispatch();
  }

  _removeWorker(pw) {
    const i = this._workers.indexOf(pw);
    if (i >= 0) this._workers.splice(i, 1);
    const fi = this._free.indexOf(pw);
    if (fi >= 0) this._free.splice(fi, 1);
  }
}

// -- manager.js --

// @gcu/proc — ProcessManager.
//
// Top-level orchestrator. Owns the process table, applies maxProcesses,
// dispatches to createWorker, builds Process instances, applies timeouts.





// Default browser worker creation — blob URL + new Worker(url, { type: 'module' }).
function defaultCreateWorker(source) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    throw new Error('proc: no Worker/Blob/URL globals — pass opts.createWorker (e.g. createNodeWorker)');
  }
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module' });
  return {
    worker,
    cleanup: () => { try { URL.revokeObjectURL(url); } catch (_) {} },
  };
}

class ProcessManager {
  constructor(opts = {}) {
    // Hard errors for not-yet-implemented features. See SPEC.md §12.
    if (opts.vfs !== undefined) {
      throw new Error('proc: { vfs } requires @gcu/proc Phase B (not in 0.1.x)');
    }
    if (opts.coreutils !== undefined) {
      throw new Error('proc: { coreutils } requires @gcu/proc Phase D (not in 0.1.x)');
    }

    this._createWorker = opts.createWorker || defaultCreateWorker;
    this._maxProcesses = opts.maxProcesses || (
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ) || 4;
    this._killGrace = opts.killGrace || 1000;
    this._nextPid = makePidGen(1);
    this._processes = new Map();    // pid → Process
    this._queue = [];                // queued spawns waiting on slot
    this._shutdown = false;
  }

  // Spawn a process. Returns Promise<Process> that resolves once the
  // worker has booted (sent READY).
  //
  // payload shapes:
  //   - function:      spawn(fn, { args, transfer, timeout, killGrace })
  //   - module-call:   spawn({ module, fn, args }, { transfer, timeout })
  //   - module-service:spawn({ module, mode: 'service' }, { timeout })
  spawn(payload, opts = {}) {
    if (this._shutdown) {
      return Promise.reject(new Error('proc: manager is shut down'));
    }

    // Hard errors for Phase A out-of-scope inputs.
    if (typeof payload === 'string') {
      throw new Error('proc: shell mode (string command) requires @gcu/proc Phase D (not in 0.1.x)');
    }
    if (opts.tty !== undefined) {
      throw new Error('proc: { tty } requires @gcu/proc Phase C (not in 0.1.x)');
    }
    if (opts.remote !== undefined) {
      throw new Error('proc: { remote } requires @gcu/proc Phase F (not in 0.1.x)');
    }

    const initMsg = this._buildInitMessage(payload, opts);

    // Queue if over the limit.
    if (this._activeCount() >= this._maxProcesses) {
      return new Promise((resolve, reject) => {
        this._queue.push({ initMsg, opts, resolve, reject, payload });
      });
    }
    return this._actuallySpawn(initMsg, opts, payload);
  }

  // Sugar over function-mode spawn: returns the function's return value
  // (or rethrows its error) instead of a Process.
  async compute(fn, args = [], opts = {}) {
    const proc = await this.spawn(fn, { ...opts, args });
    const code = await proc.wait();
    if (code !== EXIT.OK) {
      if (proc.error) throw proc.error;
      throw new Error('proc.compute: exit code ' + code);
    }
    return proc.result;
  }

  // Create a Pool of `n` keepalive workers. Each task dispatched via
  // pool.exec / pool.map runs on the next free worker (free-queue, not
  // round-robin).
  createPool(n, opts = {}) {
    if (this._shutdown) throw new Error('proc: manager is shut down');
    const size = n || this._maxProcesses;
    return new Pool(this, size);
  }

  list() {
    const out = [];
    for (const p of this._processes.values()) {
      out.push({
        pid: p.pid,
        state: p.state,
        mode: p.mode,
        startTime: p.startTime,
        duration: p.duration,
        command: p.command,
      });
    }
    return out;
  }

  get(pid) {
    return this._processes.get(pid) || null;
  }

  kill(pid, signal = 'INT') {
    const proc = this._processes.get(pid);
    if (proc) proc.kill(signal);
  }

  killAll(signal = 'KILL') {
    for (const p of this._processes.values()) {
      if (p.state === STATE.RUNNING) p.kill(signal);
    }
  }

  async waitAll() {
    const procs = Array.from(this._processes.values());
    await Promise.all(procs.map((p) => p.wait()));
  }

  shutdown() {
    this._shutdown = true;
    // Reject queued spawns.
    for (const q of this._queue) {
      try { q.reject(new Error('proc: manager is shut down')); } catch (_) {}
    }
    this._queue.length = 0;
    this.killAll('KILL');
  }

  // ── Internals ──

  _activeCount() {
    let n = 0;
    for (const p of this._processes.values()) {
      if (p.state === STATE.RUNNING) n++;
    }
    return n;
  }

  _buildInitMessage(payload, opts) {
    const transfer = opts.transfer && opts.transfer.length
      ? opts.transfer
      : detectTransfer(opts.args || []);

    if (typeof payload === 'function') {
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: payload.toString(),
          args: opts.args || [],
          keepalive: !!opts.keepalive,
        },
        transfer,
        mode: MODE.FUNCTION,
        command: payload.name || '<fn>',
      };
    }

    if (payload && typeof payload === 'object' && typeof payload.module === 'string') {
      const explicitMode = payload.mode || opts.mode;
      // Default: module + fn → module-call. module alone → service.
      const mode = explicitMode
        ? (explicitMode === 'service' ? MODE.SERVICE : MODE.MODULE_CALL)
        : (payload.fn ? MODE.MODULE_CALL : MODE.SERVICE);

      if (mode === MODE.MODULE_CALL) {
        // Phase A: URL modules only. Anything that looks like a VFS path
        // (starts with '/') is rejected with a Phase B pointer.
        if (payload.module.startsWith('/')) {
          throw new Error('proc: VFS-path modules require @gcu/proc Phase B (not in 0.1.x). Use a URL or data: URI for now.');
        }
        return {
          wire: {
            type: MSG.INIT,
            mode: MODE.MODULE_CALL,
            url: payload.module,
            fn: payload.fn || 'default',
            args: payload.args || opts.args || [],
          },
          transfer,
          mode: MODE.MODULE_CALL,
          command: payload.module + ' ' + (payload.fn || 'default'),
        };
      }

      // service mode
      if (payload.module.startsWith('/')) {
        throw new Error('proc: VFS-path modules require @gcu/proc Phase B (not in 0.1.x). Use a URL or data: URI for now.');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SERVICE,
          url: payload.module,
        },
        transfer: [],
        mode: MODE.SERVICE,
        command: payload.module,
      };
    }

    throw new TypeError('proc.spawn: payload must be a function or { module, ... } object');
  }

  async _actuallySpawn(initMsg, opts, payload) {
    const pid = this._nextPid();
    const { worker, cleanup } = this._createWorker(BOOTSTRAP_SOURCE);

    const proc = new Process({
      pid,
      mode: initMsg.mode,
      worker,
      cleanup,
      command: initMsg.command,
    });
    proc._killGrace = opts.killGrace || this._killGrace;

    this._processes.set(pid, proc);
    proc.wait().then(() => this._onProcessExit(pid));

    // Optional timeout: schedule INT then KILL.
    if (opts.timeout && opts.timeout > 0) {
      proc._timeoutTimer = setTimeout(() => {
        if (proc.state !== STATE.RUNNING) return;
        // Mark this as a timeout-kill so the final state reflects it.
        proc.kill('INT');
        setTimeout(() => {
          if (proc.state === STATE.RUNNING || proc.state === STATE.KILLED) {
            // Override to TIMEOUT/124 if still alive or just killed via the
            // INT grace path.
            if (proc.state === STATE.RUNNING) proc.kill('KILL');
            // Patch the final state in next tick (after _finish ran from KILL).
            queueMicrotask(() => {
              if (proc.state === STATE.KILLED && proc.exitCode === EXIT.KILL) {
                proc.state = STATE.TIMEOUT;
                proc.exitCode = EXIT.TIMEOUT;
              }
            });
          }
        }, proc._killGrace);
      }, opts.timeout);
    }

    // Wait for READY before resolving so the caller can immediately use the
    // process (post messages, etc.) without races.
    await proc.ready();
    if (proc.state !== STATE.RUNNING) {
      // The worker died during boot. Surface the error.
      if (proc.error) throw proc.error;
      throw new Error('proc: worker exited during boot (pid ' + pid + ', exit ' + proc.exitCode + ')');
    }

    // Post the init message now that the worker is ready.
    try {
      worker.postMessage(initMsg.wire, initMsg.transfer);
    } catch (err) {
      proc._onWorkerError(err);
      throw err;
    }

    return proc;
  }

  _onProcessExit(pid) {
    // Don't remove from the table — list() should still see the entry —
    // but drain the queue.
    if (this._queue.length === 0) return;
    if (this._shutdown) return;
    const next = this._queue.shift();
    this._actuallySpawn(next.initMsg, next.opts, next.payload)
      .then(next.resolve, next.reject);
  }
}
export {
  // protocol.js
  PROTOCOL_VERSION,
  MSG,
  MODE,
  STATE,
  EXIT,
  makePidGen,
  serializeError,
  deserializeError,
  detectTransfer,
  attachMessage,
  // channel.js
  ReadablePort,
  WritablePort,
  // worker-bootstrap.js
  BOOTSTRAP_SOURCE,
  // process.js
  Process,
  // pool.js
  Pool,
  // manager.js
  ProcessManager,
};
