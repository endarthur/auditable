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
export const MSG = Object.freeze({
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

export const MODE = Object.freeze({
  FUNCTION:        'function',
  MODULE_CALL:     'module-call',
  SERVICE:         'module-service',
  INLINE_SERVICE:  'inline-service',
});

export const STATE = Object.freeze({
  RUNNING: 'running',
  DONE:    'done',
  KILLED:  'killed',
  ERROR:   'error',
  TIMEOUT: 'timeout',
});

export const EXIT = Object.freeze({
  OK:      0,
  ERROR:   1,
  TIMEOUT: 124,
  INT:     130,   // 128 + SIGINT
  KILL:    137,   // 128 + SIGKILL
});

// Process IDs are unique per ProcessManager, monotonically increasing.
export function makePidGen(start = 1) {
  let next = start;
  return () => next++;
}

// Serialize an Error to a plain object so it survives postMessage cleanly
// across both browser and Node. The browser structured-clones Error fine;
// Node's worker_threads sometimes drops stack frames. Going through
// {message, stack} keeps both consistent.
export function serializeError(err) {
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
export function deserializeError(obj) {
  if (!obj) return new Error('unknown error');
  const e = new Error(obj.message || 'unknown error');
  if (obj.stack) e.stack = obj.stack;
  if (obj.name) e.name = obj.name;
  return e;
}

// Auto-detect transferable buffers in an array of values. Mirrors the
// existing worker() builtin's behavior: ArrayBuffers and TypedArrays are
// transferred zero-copy unless the caller already specified transfer.
export function detectTransfer(values) {
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
export function attachMessage(target, handler) {
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
