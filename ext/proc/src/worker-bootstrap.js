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
  let _workerPrincipal = null;    // 0.5.1+: principal sandbox metadata for inspection

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
      // 0.5.1+: principal sandbox metadata. Host enforces; this is
      // just exposed via ctx.principal for daemons that want to
      // re-check requests against the caller's principal.
      if (msg.principal != null) _workerPrincipal = msg.principal;
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
      principal: _workerPrincipal,    // read-only inspect; host enforces
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
          // Second arg gives daemons the caller's metadata (so far just
          // principal). Keeps the primary req shape clean while letting
          // daemons re-check operations against the caller's permissions.
          const meta = data.principal != null ? { principal: data.principal } : {};
          Promise.resolve()
            .then(() => handler(data.req, meta))
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
