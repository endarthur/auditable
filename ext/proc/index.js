// @gcu/proc — process model for the browser (Phase A: function / module-call / module-service modes)
// Auto-generated from ext/proc/src/ — do not edit directly

// -- protocol.js --

// @gcu/proc — wire protocol constants and helpers.
//
// Pure module: zero imports, safe in any JS environment (browser, worker,
// Node). All other proc modules build on this.

// Wire-protocol version. Kept module-internal (not exported via the package
// footer) because @gcu/abus also has a top-level PROTOCOL_VERSION; the works
// build inlines both libs into the terminal surface and a top-level identifier
// collision was a SyntaxError. If a downstream needs to read this, expose it
// under a namespaced name later (e.g. PROC_PROTOCOL_VERSION).
const PROC_PROTOCOL_VERSION = '0.1';

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
  FUNCTION:        'function',
  MODULE_CALL:     'module-call',
  SERVICE:         'module-service',
  INLINE_SERVICE:  'inline-service',
  SHELL:           'shell-service',
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
// VFS (Phase B / 0.2.0): when the init message carries vfsConfig, the
// bootstrap builds a worker-side VFS from the supplied mount table and
// either injects it as the last fn arg (function/module-call modes with
// opts.vfs === true) or hangs it off ctx.vfs (service modes). Mounts
// flagged 'direct' get a real backend instance (e.g. IDBBackend) talking
// to the same storage; mounts flagged 'proxy' get a ProxyBackend that
// RPCs every operation back to the main thread via _proc_vfs_call /
// _proc_vfs_reply messages.
//
// The bootstrap also uses string-MSG-types directly (rather than
// importing protocol.js) because workers can't reach the registry's
// import map — and even if they could, embedding the constants by hand
// keeps the bootstrap fully self-contained.

const BOOTSTRAP_SOURCE = `
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

// ── VFS-RPC state ──
// Outgoing _proc_vfs_call messages are correlated to their replies by id.
// _vfsPending holds {resolve, reject} per inflight RPC. Filled by
// ProxyBackend instances when they make a call; drained by the
// _proc_vfs_reply handler in the dispatcher loop below.
let _vfsNextId = 0;
const _vfsPending = new Map();

// Factory: returns a ProxyBackend class bound to the given Backend
// superclass. We can't reference Backend at the top of the bootstrap
// because it isn't in scope until @gcu/vfs is either inlined ahead of
// this script or dynamically imported (vfsModuleUrl). So we defer
// instantiation to buildWorkerVfs, which calls the factory at the right
// point in time.
function _makeProxyBackend(BackendCls) {
  return class ProxyBackend extends BackendCls {
    constructor(mountPath, send) {
      super();
      this._mountPath = mountPath;
      this._send = send;
    }
    _call(method, args) {
      const id = _vfsNextId++;
      const promise = new Promise((res, rej) => _vfsPending.set(id, { res, rej }));
      this._send({
        type: '_proc_vfs_call',
        id,
        mountPath: this._mountPath,
        method,
        args: args || [],
      });
      return promise;
    }
    readFile(...a)  { return this._call('readFile',  a); }
    writeFile(...a) { return this._call('writeFile', a); }
    readdir(...a)   { return this._call('readdir',   a); }
    stat(...a)      { return this._call('stat',      a); }
    mkdir(...a)     { return this._call('mkdir',     a); }
    unlink(...a)    { return this._call('unlink',    a); }
    rmdir(...a)     { return this._call('rmdir',     a); }
    rename(...a)    { return this._call('rename',    a); }
    glob(...a)      { return this._call('glob',      a); }
    exists(...a)    { return this._call('exists',    a); }
    cp(...a)        { return this._call('cp',        a); }
    lstat(...a)     { return this._call('lstat',     a); }
    touch(...a)     { return this._call('touch',     a); }
  };
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
  let _workerVfs = null;
  let _workerTty = null;          // Phase C: ctx.tty proxy (service modes only)
  let _workerPm = null;           // Phase D: ctx.pm proxy (service-mode-only)

  // Phase D: ctx.pm wire state. Reply correlation map and pid → waiter
  // queue (we may have multiple awaiters for the same remote process).
  let _pmNextRpcId = 0;
  const _pmPending = new Map();     // id → {res, rej}
  const _pmWaitWaiters = new Map(); // pid → array of resolvers
  const _ttyKeyQueue = [];        // backlog for keys() iterator
  const _ttyKeyWaiters = [];      // pending promise resolvers
  const _ttyMouseQueue = [];
  const _ttyMouseWaiters = [];
  const _ttyResizeListeners = [];
  let _ttySize = { rows: 24, cols: 80 };

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
      // VFS construction happens BEFORE dispatchInit so the entry point
      // sees a fully-wired _workerVfs.
      if (msg.vfsConfig) {
        try {
          await buildWorkerVfs(msg);
        } catch (err) {
          _post({ type: '_proc_error', error: { message: 'proc: VFS init failed: ' + (err && err.message || String(err)), stack: err && err.stack } });
          exit(1);
          return;
        }
      }
      // Phase C: seed initial size + build the ctx.tty proxy before
      // dispatchInit so the entry sees ctx.tty if requested.
      if (msg.tty) {
        if (msg.ttySize) _ttySize = msg.ttySize;
        _workerTty = buildWorkerTty();
      }
      // Phase D: build ctx.pm. Always available in service-mode workers
      // so they can spawn / manage host-side processes via RPC. No host
      // opt-in flag — the proxy doesn't itself do anything; the host's
      // Process simply rejects the RPC if no manager is set.
      _workerPm = buildWorkerPm();
      await dispatchInit(msg);
      return;
    }
    if (msg.type === '_proc_vfs_reply') {
      const slot = _vfsPending.get(msg.id);
      if (!slot) return;
      _vfsPending.delete(msg.id);
      if (msg.ok) {
        slot.res(msg.value);
      } else {
        const err = new Error((msg.error && msg.error.message) || 'vfs proxy: unknown error');
        if (msg.error && msg.error.code) err.code = msg.error.code;
        if (msg.error && msg.error.path) err.path = msg.error.path;
        slot.rej(err);
      }
      return;
    }
    // Phase D: ctx.pm RPC replies.
    if (msg.type === '_proc_pm_reply') {
      const slot = _pmPending.get(msg.id);
      if (!slot) return;
      _pmPending.delete(msg.id);
      if (msg.ok) slot.res(msg.value);
      else slot.rej(new Error((msg.error && msg.error.message) || 'pm proxy: unknown error'));
      return;
    }
    if (msg.type === '_proc_pm_exit') {
      // A remote process the worker is waiting on has exited. Fan out to
      // all queued waiters for that pid.
      const waiters = _pmWaitWaiters.get(msg.pid);
      if (waiters) {
        _pmWaitWaiters.delete(msg.pid);
        for (const r of waiters) {
          try { r(msg.exitCode); } catch (_) {}
        }
      }
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
    // Phase C TTY proxy: host forwards keystrokes, mouse events, and
    // resize notifications. Each becomes an async-iterable item (keys /
    // mouse) or a subscriber callback fanout (resize).
    if (msg.type === '_proc_tty_key') {
      if (_ttyKeyWaiters.length) {
        _ttyKeyWaiters.shift()(msg.key);
      } else {
        _ttyKeyQueue.push(msg.key);
      }
      return;
    }
    if (msg.type === '_proc_tty_mouse') {
      if (_ttyMouseWaiters.length) {
        _ttyMouseWaiters.shift()(msg.event);
      } else {
        _ttyMouseQueue.push(msg.event);
      }
      return;
    }
    if (msg.type === '_proc_tty_resize') {
      _ttySize = { rows: msg.rows || 24, cols: msg.cols || 80 };
      for (const cb of _ttyResizeListeners) {
        try { cb(_ttySize); } catch (_) {}
      }
      return;
    }
  });

  // Build the worker-side VFS from the mount table description the
  // ProcessManager serialized at spawn time. Source of @gcu/vfs is one of:
  //   - already in scope (manager passed vfsBundleSource, concatenated
  //     ahead of this bootstrap by _actuallySpawn);
  //   - dynamically imported (manager passed vfsModuleUrl).
  async function buildWorkerVfs(initMsg) {
    let vfsMod;
    if (typeof VFS === 'function' && typeof BACKEND_TYPES === 'object') {
      // Inline mode — top-level bindings exist (the bundle was prepended).
      vfsMod = {
        VFS,
        Backend,
        BACKEND_TYPES,
      };
    } else if (initMsg.vfsModuleUrl) {
      vfsMod = await import(initMsg.vfsModuleUrl);
      if (!vfsMod.VFS) throw new Error('proc: vfsModuleUrl did not export VFS');
      if (!vfsMod.Backend) throw new Error('proc: vfsModuleUrl did not export Backend');
      if (!vfsMod.BACKEND_TYPES) throw new Error('proc: vfsModuleUrl did not export BACKEND_TYPES');
    } else {
      throw new Error('proc: vfsConfig present but neither inlined VFS nor vfsModuleUrl available');
    }

    const ProxyBackend = _makeProxyBackend(vfsMod.Backend);
    const vfs = new vfsMod.VFS();
    for (const mount of initMsg.vfsConfig) {
      let backend;
      if (mount.mode === 'direct') {
        const type = mount.config && mount.config.type;
        const Cls = type && vfsMod.BACKEND_TYPES[type];
        if (!Cls) throw new Error('proc: unknown backend type "' + type + '" — register it in @gcu/vfs BACKEND_TYPES');
        backend = new Cls(mount.config);
        if (typeof backend.init === 'function') await backend.init();
      } else {
        // 'proxy' (default for unknown modes)
        backend = new ProxyBackend(mount.path, _post);
      }
      vfs._mounts.set(mount.path, backend);
    }
    _workerVfs = vfs;
  }

  // Build the worker-side tty proxy. Caller-provided host tty events
  // (key, mouse, resize) arrive via _proc_tty_* messages and are drained
  // into the queues + waiter callbacks above; .write() posts a
  // _proc_tty_write back to the host. Size is cached, no round-trip.
  function buildWorkerTty() {
    async function* makeIter(queue, waiters) {
      while (true) {
        if (queue.length) {
          yield queue.shift();
        } else {
          yield await new Promise((r) => waiters.push(r));
        }
      }
    }
    return {
      write(data) { _post({ type: '_proc_tty_write', data }); },
      size() { return { rows: _ttySize.rows, cols: _ttySize.cols }; },
      keys() { return makeIter(_ttyKeyQueue, _ttyKeyWaiters); },
      mouse() { return makeIter(_ttyMouseQueue, _ttyMouseWaiters); },
      onResize(cb) {
        if (typeof cb !== 'function') return () => {};
        _ttyResizeListeners.push(cb);
        return () => {
          const i = _ttyResizeListeners.indexOf(cb);
          if (i >= 0) _ttyResizeListeners.splice(i, 1);
        };
      },
    };
  }

  // Phase D: worker-side ProcessManager proxy. Sends _proc_pm_* RPCs to
  // the host, gets back replies or exit-notifications. Spawns return a
  // RemoteProcess stand-in with pid + wait() + kill().
  function buildWorkerPm() {
    const rpc = (method, args) => {
      const id = _pmNextRpcId++;
      const promise = new Promise((res, rej) => _pmPending.set(id, { res, rej }));
      _post({ type: '_proc_pm_call', id, method, args: args || [] });
      return promise;
    };
    const makeRemoteProc = (pid) => ({
      pid,
      wait() {
        return new Promise((resolve) => {
          let arr = _pmWaitWaiters.get(pid);
          if (!arr) { arr = []; _pmWaitWaiters.set(pid, arr); }
          arr.push(resolve);
          // Also nudge the host: it might already be exited.
          _post({ type: '_proc_pm_call', id: _pmNextRpcId++, method: 'subscribeExit', args: [pid] });
        });
      },
      kill(signal) {
        _post({ type: '_proc_pm_call', id: _pmNextRpcId++, method: 'kill', args: [pid, signal || 'INT'] });
      },
    });
    return {
      // payload: a string (shell command) or a function (serialized).
      // opts: { args?, shell?, vfs?, tty? } passed through to host pm.spawn.
      async spawn(payload, opts) {
        const result = await rpc('spawn', [
          // Serialize the payload — strings go as-is, fns as source.
          typeof payload === 'function' ? { __fn__: payload.toString() } : payload,
          opts || {},
        ]);
        // result = { pid }
        return makeRemoteProc(result.pid);
      },
      async list() { return rpc('list', []); },
      kill(pid, signal) {
        return rpc('kill', [pid, signal || 'INT']);
      },
    };
  }

  function makeServiceCtx() {
    return {
      signal: ABORT.signal,
      stdout: ctxStdout,
      stderr: ctxStderr,
      vfs: _workerVfs,
      tty: _workerTty,
      pm:  _workerPm,
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
      // Phase E: sugar over ctx.on for the request/reply pattern that
      // pm.request uses. Handler receives the request body; whatever it
      // returns (or its thrown error) gets sent back as the reply.
      onRequest: (handler) => {
        const sub = (data) => {
          if (!data || typeof data !== 'object' || data.type !== 'request') return;
          const id = data.id;
          Promise.resolve()
            .then(() => handler(data.req))
            .then(
              (value) => _post({ type: '_proc_msg', data: { type: 'reply', id, ok: true, value } }),
              (err) => _post({ type: '_proc_msg', data: { type: 'reply', id, ok: false, error: { message: err && err.message || String(err) } } })
            );
        };
        SERVICE_HANDLERS.push(sub);
        while (SERVICE_BUFFER.length) {
          const d = SERVICE_BUFFER.shift();
          try { sub(d); } catch (_) {}
        }
        return () => {
          const i = SERVICE_HANDLERS.indexOf(sub);
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

  // Phase D: shell-service mode. Loads a shell library (inlined or URL),
  // instantiates a shell instance via the named factory, and either runs
  // one command (oneShot) or sits in a loop dispatching exec messages
  // from the host. The shell's stdout/stderr are wired to ctx.stdout /
  // ctx.stderr so the host's onStdout/onStderr callbacks see the output.
  async function dispatchShellInit(msg) {
    // Resolve the shell library. Either inlined ahead of the bootstrap
    // (manager passed shellBundleSource → top-level symbols available)
    // or imported by URL.
    let factory = null;
    const factoryName = msg.shellFactoryName || 'createShell';
    // Three resolution paths:
    //   1. globalThis[name] — classic-worker top-level fns attach here.
    //   2. Direct eval(name) — module-mode workers (Node ESM) keep
    //      top-level function declarations module-scoped; direct eval
    //      can still resolve names that are reachable from the calling
    //      scope, which includes the enclosing module body.
    //   3. await import(url) — explicit URL-mode delivery.
    if (typeof globalThis !== 'undefined' && typeof globalThis[factoryName] === 'function') {
      factory = globalThis[factoryName];
    } else {
      try {
        // eslint-disable-next-line no-eval
        const candidate = eval(factoryName);
        if (typeof candidate === 'function') factory = candidate;
      } catch (_) { /* name not in lexical scope */ }
    }
    if (!factory && msg.shellModuleUrl) {
      const mod = await import(msg.shellModuleUrl);
      factory = mod[factoryName];
    }
    if (typeof factory !== 'function') {
      throw new Error('proc: shell factory "' + factoryName + '" not found (provide shellBundleSource or shellModuleUrl)');
    }

    // Build the shell. Inject the proc-side bits (vfs, tty, pm, stdout,
    // stderr) on top of factoryOpts. The shell library is free to ignore
    // unknown keys; the contract here is "the shell uses what it needs."
    const collectedStdout = [];
    const collectedStderr = [];
    const captureStdout = (text) => {
      const s = typeof text === 'string' ? text : String(text == null ? '' : text);
      collectedStdout.push(s);
      ctxStdout(s);
    };
    const captureStderr = (text) => {
      const s = typeof text === 'string' ? text : String(text == null ? '' : text);
      collectedStderr.push(s);
      ctxStderr(s);
    };
    const factoryOpts = Object.assign({}, msg.shellFactoryOpts || {}, {
      vfs:    _workerVfs,
      tty:    _workerTty,
      pm:     _workerPm,
      stdout: captureStdout,
      stderr: captureStderr,
    });

    let shell;
    try { shell = factory(factoryOpts); }
    catch (err) {
      _post({ type: '_proc_error', error: { message: 'shell factory threw: ' + (err && err.message || err), stack: err && err.stack } });
      exit(1);
      return;
    }
    if (!shell || typeof shell.exec !== 'function') {
      _post({ type: '_proc_error', error: { message: 'proc: shell factory must return an object with .exec(command)' } });
      exit(1);
      return;
    }

    // Helper: run a single command, collect output, return the
    // {exitCode, stdout, stderr} triple.
    const runOne = async (source) => {
      collectedStdout.length = 0;
      collectedStderr.length = 0;
      let exitCode = 0;
      try {
        const r = await shell.exec(source);
        exitCode = (r && typeof r.exitCode === 'number') ? r.exitCode : 0;
      } catch (err) {
        if (!collectedStderr.length) captureStderr((err && err.message || String(err)) + '\\n');
        exitCode = 1;
      }
      return { exitCode, stdout: collectedStdout.join(''), stderr: collectedStderr.join('') };
    };

    if (msg.shellOneShot) {
      // One-shot: pm.spawn(string) — run the command, post result,
      // terminate. Result is the shape {exitCode, stdout, stderr}; host's
      // proc.result picks it up via the existing _proc_result message.
      const result = await runOne(msg.shellCommand);
      _post({ type: '_proc_result', value: result });
      exit(result.exitCode === 0 ? 0 : (intReceived ? 130 : 1));
      return;
    }

    // Long-running (pm.shell): if shellCommand was supplied for the
    // initial exec, run it first (most uses don't set it). Then dispatch
    // shell:exec messages from the host.
    if (msg.shellCommand) {
      const result = await runOne(msg.shellCommand);
      _post({ type: '_proc_msg', data: { type: 'shell:done', id: 0, ...result } });
    }
    // Park on incoming exec messages. Custom-channel dispatch via ctx.on.
    const ctx = makeServiceCtx();
    ctx.on(async (msg2) => {
      if (!msg2 || typeof msg2 !== 'object') return;
      if (msg2.type === 'shell:exec') {
        const result = await runOne(msg2.source || '');
        ctx.send({ type: 'shell:done', id: msg2.id, ...result });
        return;
      }
    });
    // Live until killed.
    await new Promise((resolve) => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener('abort', resolve);
    });
    if (!exited) exit(intReceived ? 130 : 0);
  }

  async function dispatchInit(msg) {
    try {
      if (msg.mode === 'function') {
        const src = msg.source;
        const fn = (0, eval)('(' + src + ')');
        const args = Array.isArray(msg.args) ? msg.args.slice() : [];
        if (msg.vfs && _workerVfs) args.push(_workerVfs);
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
        const args = Array.isArray(msg.args) ? msg.args.slice() : [];
        if (msg.vfs && _workerVfs) args.push(_workerVfs);
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
      if (msg.mode === 'shell-service') {
        await dispatchShellInit(msg);
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

// -- process.js --

// @gcu/proc — Process class.
//
// One Process per worker. Owns the worker handle, state machine, I/O
// channels, and the wire-protocol routing. The ProcessManager creates
// these; consumers receive them from pm.spawn().


class Process {
  constructor({ pid, mode, worker, cleanup, command, vfs, tty, manager }) {
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
    this._vfs = vfs || null;        // host VFS for _proc_vfs_call dispatch
    this._tty = tty || null;        // host tty for _proc_tty_* event forwarding
    this._ttyUnsubs = [];           // event-subscription cleanup fns
    this._manager = manager || null; // host ProcessManager for _proc_pm_call dispatch (Phase D)
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

    // Phase C TTY proxy: if a host tty was supplied, subscribe to its
    // input events and forward them to the worker as _proc_tty_* messages.
    // Worker→host writes are handled in _onMessage's _proc_tty_write case.
    if (this._tty) this._wireTty(this._tty);
  }

  _wireTty(tty) {
    const post = (m) => this._post(m);
    if (typeof tty.onKey === 'function') {
      try {
        const u = tty.onKey((key) => post({ type: '_proc_tty_key', key }));
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) { /* host onKey threw — skip */ }
    }
    if (typeof tty.onMouse === 'function') {
      try {
        const u = tty.onMouse((event) => post({ type: '_proc_tty_mouse', event }));
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) {}
    }
    if (typeof tty.onResize === 'function') {
      try {
        const u = tty.onResize((sz) => {
          const rows = (sz && sz.rows) || 24;
          const cols = (sz && sz.cols) || 80;
          post({ type: '_proc_tty_resize', rows, cols });
        });
        if (typeof u === 'function') this._ttyUnsubs.push(u);
      } catch (_) {}
    }
  }

  // Send a custom-protocol message to the worker. Available in any
  // service-flavored mode (module-service, inline-service, shell-service).
  send(data, transfer) {
    if (this.mode !== MODE.SERVICE && this.mode !== MODE.INLINE_SERVICE && this.mode !== MODE.SHELL) {
      throw new Error('proc.send() requires a service mode (module-service, inline-service, or shell-service)');
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
      case '_proc_vfs_call':
        // Phase B VFS proxy: the worker is asking us to run a method on
        // a host-side backend. Dispatch async; reply with the result or
        // a serialized error.
        this._handleVfsCall(msg);
        return;
      case '_proc_tty_write':
        // Phase C TTY proxy: worker is asking the host tty to render data
        // (bytes, escape sequences, etc). Fire-and-forget; no reply.
        if (this._tty && typeof this._tty.write === 'function') {
          try { this._tty.write(msg.data); } catch { /* swallow */ }
        }
        return;
      case '_proc_pm_call':
        // Phase D: worker is asking the host ProcessManager to do
        // something (spawn, list, kill, subscribeExit). Dispatch async,
        // reply with the result or a serialized error.
        this._handlePmCall(msg);
        return;
      default:
        // Unknown lifecycle messages are ignored — gives the protocol
        // room to grow.
        return;
    }
  }

  async _handlePmCall(msg) {
    const reply = (payload) => {
      try { this._post({ type: '_proc_pm_reply', id: msg.id, ...payload }); }
      catch (_) { /* worker may already be gone */ }
    };
    if (!this._manager) {
      reply({ ok: false, error: { message: 'proc: process has no host ProcessManager configured' } });
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    const args = Array.isArray(msg.args) ? msg.args : [];
    try {
      if (method === 'spawn') {
        let [payload, opts] = args;
        // Function payloads come over the wire as { __fn__: source }; we
        // can't reconstruct an actual function here (we'd need eval, and
        // the function's closures wouldn't survive anyway). Reject with
        // a helpful error — string commands (the geas `&` case) are the
        // supported path for Phase D.
        if (payload && typeof payload === 'object' && typeof payload.__fn__ === 'string') {
          reply({ ok: false, error: { message: 'proc: ctx.pm.spawn(fn) is not supported in Phase D — pass a string command (with opts.shell) or a {module, mode} object' } });
          return;
        }
        // Need shellConfig inherited from this Process's spawn so the
        // sub-process can find a shell. Caller can also override via opts.
        const subProc = await this._manager.spawn(payload, opts || {});
        reply({ ok: true, value: { pid: subProc.pid } });
        return;
      }
      if (method === 'list') {
        reply({ ok: true, value: this._manager.list() });
        return;
      }
      if (method === 'kill') {
        const [pid, signal] = args;
        this._manager.kill(pid, signal || 'INT');
        reply({ ok: true, value: null });
        return;
      }
      if (method === 'subscribeExit') {
        // Worker is awaiting a sub-process. When the target Process exits,
        // we send _proc_pm_exit so the worker's wait() resolves.
        const pid = args[0];
        const target = this._manager.get(pid);
        if (!target) {
          reply({ ok: true, value: null });
          // Fire an immediate exit event so the worker doesn't hang.
          try { this._post({ type: '_proc_pm_exit', pid, exitCode: -1 }); } catch (_) {}
          return;
        }
        if (target.state !== STATE.RUNNING) {
          reply({ ok: true, value: null });
          try { this._post({ type: '_proc_pm_exit', pid, exitCode: target.exitCode }); } catch (_) {}
          return;
        }
        target.wait().then((exitCode) => {
          try { this._post({ type: '_proc_pm_exit', pid, exitCode }); } catch (_) {}
        });
        reply({ ok: true, value: null });
        return;
      }
      reply({ ok: false, error: { message: 'proc: unknown ctx.pm method "' + method + '"' } });
    } catch (err) {
      reply({ ok: false, error: { message: err && err.message ? err.message : String(err) } });
    }
  }

  async _handleVfsCall(msg) {
    const reply = (payload) => {
      try { this._post({ type: '_proc_vfs_reply', id: msg.id, ...payload }); }
      catch (_) { /* worker may already be gone */ }
    };
    if (!this._vfs || !this._vfs._mounts) {
      reply({ ok: false, error: { message: 'proc: process has no host VFS configured' } });
      return;
    }
    const backend = this._vfs._mounts.get(msg.mountPath);
    if (!backend) {
      reply({ ok: false, error: { message: 'proc: no mount at "' + msg.mountPath + '"', code: 'ENOENT', path: msg.mountPath } });
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (typeof backend[method] !== 'function') {
      reply({ ok: false, error: { message: 'proc: backend has no method "' + method + '"', code: 'ENOTSUP', path: msg.mountPath } });
      return;
    }
    try {
      const args = Array.isArray(msg.args) ? msg.args : [];
      const value = await backend[method](...args);
      reply({ ok: true, value });
    } catch (err) {
      const errPayload = {
        message: err && err.message ? err.message : String(err),
      };
      if (err && err.code) errPayload.code = err.code;
      if (err && err.path) errPayload.path = err.path;
      reply({ ok: false, error: errPayload });
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

    // Phase C: drop our tty event subscriptions so the host tty doesn't
    // keep firing into a dead Process.
    for (const u of this._ttyUnsubs) {
      try { u(); } catch { /* swallow */ }
    }
    this._ttyUnsubs = [];

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





// Default browser worker creation — blob URL + new Worker(url).
//
// Classic worker (no { type: 'module' }) so we can spawn from blob:file://
// origins. Chromium blocks module-mode workers loaded from blob URLs that
// originate on file:// — the surface iframes in Auditable Works run from
// blob:file://*/uuid, and a module worker there fails to load entirely.
//
// The bootstrap source is structured to work as a classic script: no
// top-level await, no top-level import statements, no export — runtime
// detection and any user-module imports happen inside an async IIFE,
// where dynamic import() is supported in both classic and module workers.
function defaultCreateWorker(source) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    throw new Error('proc: no Worker/Blob/URL globals — pass opts.createWorker (e.g. createNodeWorker)');
  }
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return {
    worker,
    cleanup: () => { try { URL.revokeObjectURL(url); } catch (_) {} },
  };
}

class ProcessManager {
  constructor(opts = {}) {
    // Hard errors for not-yet-implemented features. See SPEC.md §12.
    if (opts.coreutils !== undefined) {
      throw new Error('proc: { coreutils } requires @gcu/proc Phase D (not in 0.2.x)');
    }

    // VFS proxy (Phase B, since 0.2.0). When a VFS instance is provided,
    // spawned workers can access it: function/module-call modes get vfs
    // as the last arg when opts.vfs is true at spawn-time; module-service
    // mode always sees ctx.vfs. The worker needs to load @gcu/vfs to
    // instantiate the worker-side VFS — caller picks the deployment shape:
    //   - vfsBundleSource: inlined into the worker blob (file:// friendly).
    //   - vfsModuleUrl:    awaited via import(url) in the worker (HTTP).
    // Exactly one of the two must be supplied with vfs.
    if (opts.vfs !== undefined) {
      if (!opts.vfsBundleSource && !opts.vfsModuleUrl) {
        throw new Error('proc: { vfs } requires either { vfsBundleSource } (inline) or { vfsModuleUrl } (URL) so the worker can load @gcu/vfs');
      }
      if (opts.vfsBundleSource && opts.vfsModuleUrl) {
        throw new Error('proc: pass either vfsBundleSource OR vfsModuleUrl, not both');
      }
      if (!opts.vfs._mounts || typeof opts.vfs._mounts.entries !== 'function') {
        throw new Error('proc: { vfs } must be a @gcu/vfs VFS instance (with _mounts)');
      }
    }
    this._vfs = opts.vfs || null;
    this._vfsBundleSource = opts.vfsBundleSource || null;
    this._vfsModuleUrl = opts.vfsModuleUrl || null;

    this._createWorker = opts.createWorker || defaultCreateWorker;
    this._maxProcesses = opts.maxProcesses || (
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ) || 4;
    this._killGrace = opts.killGrace || 1000;
    this._nextPid = makePidGen(1);
    this._processes = new Map();    // pid → Process
    this._queue = [];                // queued spawns waiting on slot
    this._shutdown = false;

    // Phase E: service registry. Each entry: {
    //   name, opts, process, restartCount, lastStartTime, restartTimer,
    //   stopped, failed,
    // }
    this._services = new Map();
  }

  // Walk the configured VFS's mount table and produce a serializable
  // description the worker can use to reconstruct a peer VFS:
  //   [{ path, mode: 'direct', config }, { path, mode: 'proxy' }, ...]
  // Backends that override toConfig() to return a {type, ...opts} object
  // get the 'direct' treatment — the worker instantiates the same class
  // pointing at the same underlying storage. Backends whose toConfig()
  // returns null get 'proxy' — every operation RPCs to the main thread.
  _buildVfsMountTable() {
    if (!this._vfs) return null;
    const out = [];
    for (const [mountPath, backend] of this._vfs._mounts) {
      let config = null;
      try { config = backend.toConfig && backend.toConfig(); }
      catch (_) { config = null; }
      if (config && typeof config === 'object' && typeof config.type === 'string') {
        out.push({ path: mountPath, mode: 'direct', config });
      } else {
        out.push({ path: mountPath, mode: 'proxy' });
      }
    }
    return out;
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

    // Hard errors for out-of-scope inputs.
    if (opts.remote !== undefined) {
      throw new Error('proc: { remote } requires @gcu/proc Phase F (not in 0.4.x)');
    }
    // String payload now routes to shell-service mode (Phase D, 0.4.0+).
    // Validation happens in _buildInitMessage.

    // Phase C TTY proxy: only honored in service modes (module-service /
    // inline-service) — function/module-call modes return a value and
    // terminate; interactive TUI semantics don't apply there.
    if (opts.tty !== undefined) {
      if (typeof payload === 'function') {
        throw new Error('proc: { tty } is not supported in function mode — use module-service or inline-service');
      }
      if (payload && typeof payload === 'object' && payload.module && payload.fn) {
        throw new Error('proc: { tty } is not supported in module-call mode — use module-service or inline-service');
      }
      // Sanity-check the shape — caller-provided host tty must at least
      // have write, size, and onKey.
      if (typeof opts.tty.write !== 'function' ||
          typeof opts.tty.size !== 'function' ||
          typeof opts.tty.onKey !== 'function') {
        throw new TypeError('proc: opts.tty must implement write(data), size(), and onKey(cb)');
      }
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

  // Phase D: long-running shell process. Sugar over service-mode spawn
  // with the shell-service entry pre-wired. opts:
  //   - shell: { bundleSource | moduleUrl, factoryName, factoryOpts }
  //   - tty?, vfs? — forwarded into spawn
  // Returns a Process with extra .exec(cmd) and .execStream(cmd, {onStdout,
  // onStderr}) methods.
  async shell(opts = {}) {
    if (!opts.shell) throw new TypeError('pm.shell: opts.shell is required ({ bundleSource | moduleUrl, factoryName })');
    const initPayload = { shellCommand: '' };
    // Long-running: not one-shot. The bootstrap parks on incoming
    // shell:exec messages instead of running a single command.
    const proc = await this.spawn(initPayload, {
      ...opts,
      shellOneShot: false,
    });
    // Attach .exec / .execStream sugar.
    let nextId = 0;
    const pending = new Map();
    proc.on((data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'shell:done') {
        const slot = pending.get(data.id);
        if (!slot) return;
        pending.delete(data.id);
        slot.resolve({ exitCode: data.exitCode, stdout: data.stdout, stderr: data.stderr });
      }
    });
    proc.exec = (command) => {
      if (proc.state !== STATE.RUNNING) return Promise.reject(new Error('pm.shell: process ' + proc.state));
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      proc.send({ type: 'shell:exec', id, source: command });
      return promise;
    };
    proc.execStream = async (command, { onStdout, onStderr } = {}) => {
      // Subscribe to the proc's own stdout/stderr (the bootstrap pipes
      // the shell's captured output through ctx.stdout/ctx.stderr too).
      // Note: outputs from concurrent .exec calls are interleaved on the
      // shared ctx — execStream is best used one-command-at-a-time.
      const unsubs = [];
      if (typeof onStdout === 'function') unsubs.push(proc.stdout.onData(onStdout));
      if (typeof onStderr === 'function') unsubs.push(proc.stderr.onData(onStderr));
      try {
        const r = await proc.exec(command);
        return r.exitCode;
      } finally {
        for (const u of unsubs) try { u(); } catch (_) {}
      }
    };
    return proc;
  }

  // ── Phase E: daemons + service registry ────────────────────────────

  // Register (or adopt) a named long-running service. The payload follows
  // the normal pm.spawn shape but must be a service-mode payload
  // (module/inline/shell). On exit, the daemon is auto-restarted per
  // opts.restart (default 'on-crash'). Re-registering an already-alive
  // daemon silently returns the existing one.
  async daemon(name, opts = {}) {
    if (this._shutdown) throw new Error('proc: manager is shut down');
    if (typeof name !== 'string' || !name) throw new TypeError('pm.daemon(name, opts): name must be a non-empty string');

    // If a healthy service with this name exists, adopt it.
    const existing = this._services.get(name);
    if (existing && existing.process && existing.process.state === STATE.RUNNING) {
      return existing.process;
    }

    const policy = opts.restart || 'on-crash';
    if (policy !== 'never' && policy !== 'on-crash' && policy !== 'always') {
      throw new TypeError('pm.daemon: opts.restart must be one of "never" | "on-crash" | "always"');
    }
    const maxRestarts   = (opts.maxRestarts   == null) ? 5     : opts.maxRestarts;
    const restartWindow = (opts.restartWindow == null) ? 60000 : opts.restartWindow;

    const record = existing || { name, opts, process: null, restartCount: 0, lastStartTime: 0, restartTimer: null, stopped: false, failed: false };
    record.opts = opts;
    record.policy = policy;
    record.maxRestarts = maxRestarts;
    record.restartWindow = restartWindow;
    record.stopped = false;
    record.failed = false;
    this._services.set(name, record);

    await this._startService(record);
    return record.process;
  }

  // Snapshot of registered services.
  services() {
    const now = Date.now();
    const out = [];
    for (const r of this._services.values()) {
      const p = r.process;
      const state = r.stopped ? 'stopped'
        : r.failed ? 'failed'
        : (p ? p.state : 'pending');
      out.push({
        name: r.name,
        pid: p ? p.pid : null,
        state,
        uptime: (p && r.lastStartTime) ? (now - r.lastStartTime) : 0,
        restarts: r.restartCount,
      });
    }
    return out;
  }

  service(name) {
    const r = this._services.get(name);
    return r ? (r.process || null) : null;
  }

  // Permanently stop a service: kill the running instance and exclude
  // from auto-restart. Subsequent pm.daemon(name, opts) calls re-start.
  async stopService(name) {
    const r = this._services.get(name);
    if (!r) return;
    r.stopped = true;
    if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null; }
    if (r.process && r.process.state === STATE.RUNNING) {
      r.process.kill('INT');
    }
  }

  // Send a request to a named daemon and await its reply. Uses proc.send
  // / proc.on with a {type:'request'|'reply', id, ...} convention layered
  // on _proc_msg. Daemon must be running; throws if it isn't.
  async request(name, message, opts = {}) {
    const proc = this.service(name);
    if (!proc) throw new Error('pm.request: no service named "' + name + '"');
    if (proc.state !== STATE.RUNNING) throw new Error('pm.request: service "' + name + '" is ' + proc.state);
    // Cache the next-id counter + pending map on the Process so multiple
    // concurrent requests against the same daemon don't collide.
    if (!proc._daemonNextId) {
      proc._daemonNextId = 0;
      proc._daemonPending = new Map();
      proc.on((data) => {
        if (!data || typeof data !== 'object' || data.type !== 'reply') return;
        const slot = proc._daemonPending.get(data.id);
        if (!slot) return;
        proc._daemonPending.delete(data.id);
        if (data.ok) slot.resolve(data.value);
        else slot.reject(new Error((data.error && data.error.message) || 'daemon error'));
      });
    }
    const id = ++proc._daemonNextId;
    const timeoutMs = opts.timeout || 0;
    const promise = new Promise((resolve, reject) => {
      proc._daemonPending.set(id, { resolve, reject });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (proc._daemonPending.has(id)) {
            proc._daemonPending.delete(id);
            reject(new Error('pm.request: timeout after ' + timeoutMs + 'ms'));
          }
        }, timeoutMs);
      }
    });
    proc.send({ type: 'request', id, req: message });
    return promise;
  }

  // ── Internals — service supervisor ──

  async _startService(record) {
    record.lastStartTime = Date.now();
    // Strip our daemon-specific opts before delegating to spawn.
    const spawnOpts = { ...record.opts };
    delete spawnOpts.restart;
    delete spawnOpts.maxRestarts;
    delete spawnOpts.restartWindow;

    // Construct the payload. Daemon opts can supply either a separate
    // `payload` field (preferred) or have the spawn shape merged into opts.
    const payload = record.opts.payload != null ? record.opts.payload : record.opts;

    try {
      const proc = await this.spawn(payload, spawnOpts);
      record.process = proc;
      // Watch for exit so we can decide whether to restart.
      proc.wait().then((code) => this._onServiceExit(record, code));
    } catch (err) {
      record.failed = true;
      throw err;
    }
  }

  _onServiceExit(record, exitCode) {
    if (record.stopped || this._shutdown) return;

    const cleanExit = exitCode === EXIT.OK;
    const policy = record.policy;
    let shouldRestart = false;
    if (policy === 'never') shouldRestart = false;
    else if (policy === 'always') shouldRestart = true;
    else if (policy === 'on-crash') shouldRestart = !cleanExit;

    if (!shouldRestart) return;

    // Reset the restart counter if the service ran for > restartWindow.
    const uptime = Date.now() - record.lastStartTime;
    if (uptime > record.restartWindow) {
      record.restartCount = 0;
    }
    record.restartCount += 1;

    if (record.restartCount > record.maxRestarts) {
      record.failed = true;
      return;
    }

    // Exponential backoff: 100ms × 2^(n-1), capped at 30s.
    const backoff = Math.min(30000, 100 * Math.pow(2, record.restartCount - 1));
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      if (record.stopped || this._shutdown) return;
      this._startService(record).catch(() => {
        // _startService already marked failed=true on spawn error.
      });
    }, backoff);
  }

  // Phase D: one-shot command execution. Spawns a shell, runs ONE
  // command, terminates the shell, returns { exitCode, stdout, stderr }.
  // Heavy worker-spawn cost per call (~tens of ms) — use pm.shell for
  // anything that runs many commands.
  async exec(command, opts = {}) {
    if (typeof command !== 'string') throw new TypeError('pm.exec(command, opts): command must be a string');
    if (!opts.shell) throw new TypeError('pm.exec: opts.shell is required');
    const proc = await this.spawn(command, { ...opts, shellOneShot: true });
    const code = await proc.wait();
    if (code !== EXIT.OK && proc.error) {
      // Shell returned non-zero AND threw — propagate the error.
      throw proc.error;
    }
    // proc.result is the {exitCode, stdout, stderr} triple posted by
    // the bootstrap's runOne.
    return proc.result || { exitCode: code, stdout: '', stderr: '' };
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
    // Cancel any pending daemon restart timers.
    for (const r of this._services.values()) {
      if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null; }
      r.stopped = true;
    }
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

    // VFS injection: callers opt in per-spawn with opts.vfs === true. Only
    // legal when the manager was constructed with a vfs. Module-service
    // mode always gets ctx.vfs regardless of opts.vfs (handled in the
    // bootstrap, not gated here).
    const vfsRequested = opts.vfs === true;
    if (vfsRequested && !this._vfs) {
      throw new Error('proc.spawn: opts.vfs is true but ProcessManager was constructed without a vfs');
    }
    const vfsExtras = this._vfs
      ? {
          vfs: vfsRequested,                                // arg-injection for fn/module-call
          vfsConfig: this._buildVfsMountTable(),            // mount table description
          vfsModuleUrl: this._vfsModuleUrl || undefined,    // where to import @gcu/vfs from in the worker
        }
      : {};

    // TTY proxy: caller-provided host tty. Embed the initial size in the
    // init message so the worker's ctx.tty.size() has a value before any
    // resize event arrives.
    const ttyExtras = opts.tty
      ? { tty: true, ttySize: (() => {
          try { return opts.tty.size() || { rows: 24, cols: 80 }; }
          catch (_) { return { rows: 24, cols: 80 }; }
        })() }
      : {};

    if (typeof payload === 'function') {
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.FUNCTION,
          source: payload.toString(),
          args: opts.args || [],
          keepalive: !!opts.keepalive,
          ...vfsExtras,
        },
        transfer,
        mode: MODE.FUNCTION,
        command: payload.name || '<fn>',
      };
    }

    // Shell-service mode: string payload OR { shellCommand, shell, ... }
    // object payload. Caller must supply opts.shell with bundleSource|
    // moduleUrl + factoryName (e.g. 'createShell'). The worker imports the
    // shell library, calls factoryName with factoryOpts merged with the
    // injected ctx (vfs / tty), and runs the exec protocol.
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && typeof payload.shellCommand === 'string')) {
      const shellCfg = opts.shell;
      if (!shellCfg || typeof shellCfg !== 'object') {
        throw new TypeError('proc.spawn(string): opts.shell is required ({ bundleSource | moduleUrl, factoryName, factoryOpts? })');
      }
      if (!shellCfg.bundleSource && !shellCfg.moduleUrl) {
        throw new TypeError('proc.spawn(string): opts.shell needs either bundleSource (inline) or moduleUrl (URL)');
      }
      const command = typeof payload === 'string' ? payload : payload.shellCommand;
      const oneShot = opts.shellOneShot !== false;   // default: spawn-and-exec-and-exit
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SHELL,
          shellModuleUrl:    shellCfg.moduleUrl || undefined,
          shellFactoryName:  shellCfg.factoryName || 'createShell',
          shellFactoryOpts:  shellCfg.factoryOpts || {},
          shellCommand:      command,
          shellOneShot:      oneShot,
          ...vfsExtras,
          ...ttyExtras,
        },
        transfer: [],
        mode: MODE.SHELL,
        command: '$ ' + command.slice(0, 60),
        shellBundleSource: shellCfg.bundleSource || null,
      };
    }

    if (payload && typeof payload === 'object' && typeof payload.module === 'string') {
      const explicitMode = payload.mode || opts.mode;
      // Default: module + fn → module-call. module alone → service.
      const mode = explicitMode
        ? (explicitMode === 'service' ? MODE.SERVICE : MODE.MODULE_CALL)
        : (payload.fn ? MODE.MODULE_CALL : MODE.SERVICE);

      if (mode === MODE.MODULE_CALL) {
        // VFS-path module loading is a future feature (would require a
        // VFS-RPC import that doesn't exist yet — could land later in
        // 0.2.x). Keep rejecting for now.
        if (payload.module.startsWith('/')) {
          throw new Error('proc: VFS-path modules not supported yet — pass a URL or data: URI for the module.');
        }
        return {
          wire: {
            type: MSG.INIT,
            mode: MODE.MODULE_CALL,
            url: payload.module,
            fn: payload.fn || 'default',
            args: payload.args || opts.args || [],
            ...vfsExtras,
          },
          transfer,
          mode: MODE.MODULE_CALL,
          command: payload.module + ' ' + (payload.fn || 'default'),
        };
      }

      // service mode
      if (payload.module.startsWith('/')) {
        throw new Error('proc: VFS-path modules not supported yet — pass a URL or data: URI for the module.');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.SERVICE,
          url: payload.module,
          ...vfsExtras,
          ...ttyExtras,
        },
        transfer: [],
        mode: MODE.SERVICE,
        command: payload.module,
      };
    }

    // Inline-source mode: caller hands us the worker module source as a
    // string. We concatenate it into the bootstrap blob so there is no
    // cross-blob import — needed for Chromium under file:// where every
    // blob URL has a unique opaque origin and module-mode workers can't
    // import(anotherBlobUrl). Wire mode: 'inline-service'. The inlined
    // user code must call _procRegisterEntry(fn) at module top level.
    if (payload && typeof payload === 'object' && typeof payload.inlineSource === 'string') {
      const explicitMode = payload.mode || opts.mode;
      if (explicitMode && explicitMode !== 'service') {
        throw new Error('proc: inlineSource is only supported with mode: "service" in 0.1.x');
      }
      return {
        wire: {
          type: MSG.INIT,
          mode: MODE.INLINE_SERVICE,
          ...vfsExtras,
          ...ttyExtras,
        },
        transfer: [],
        mode: MODE.INLINE_SERVICE,
        command: payload.command || '<inline>',
        inlineSource: payload.inlineSource,
      };
    }

    throw new TypeError('proc.spawn: payload must be a function, { module, ... } object, or { inlineSource, ... } object');
  }

  async _actuallySpawn(initMsg, opts, payload) {
    const pid = this._nextPid();
    // Build the worker source. Three things can get concatenated onto the
    // bootstrap, in this order:
    //   1. The @gcu/vfs bundle source — needed if the manager was created
    //      with { vfs, vfsBundleSource }. Concatenated FIRST so its
    //      classes are top-level by the time the bootstrap and user code
    //      reference them.
    //   2. The bootstrap itself.
    //   3. The user's inline-service source, if any.
    let bootstrap = '';
    if (this._vfsBundleSource) {
      // Strip any trailing `export { ... }` from the bundle — it'd be a
      // syntax error in a classic worker.
      const stripped = this._vfsBundleSource.replace(/export\s*\{[^}]*\};?\s*$/, '');
      bootstrap += stripped + '\n;\n';
    }
    if (initMsg.shellBundleSource) {
      // Phase D: inline a shell library (e.g. the geas bundle). Same
      // strip-the-export-footer treatment so the library's symbols land
      // at top level.
      const stripped = initMsg.shellBundleSource.replace(/export\s*\{[^}]*\};?\s*$/, '');
      bootstrap += stripped + '\n;\n';
    }
    bootstrap += BOOTSTRAP_SOURCE;
    if (initMsg.inlineSource) {
      bootstrap += '\n;\n' + initMsg.inlineSource + '\n';
    }
    const { worker, cleanup } = this._createWorker(bootstrap);

    const proc = new Process({
      pid,
      mode: initMsg.mode,
      worker,
      cleanup,
      command: initMsg.command,
      vfs: this._vfs,                // for _proc_vfs_call dispatch (Phase B)
      tty: opts.tty || null,         // for _proc_tty_* event forwarding (Phase C)
      manager: this,                 // for _proc_pm_call dispatch (Phase D)
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
