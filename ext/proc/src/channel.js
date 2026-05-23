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

import { MSG } from './protocol.js';

// A readable stream of chunks. Chunks arrive via _deliver(chunk) from
// the owning Process, and consumers read them via onData(), text(), or
// async iteration. Closed by _close() when the process exits.
export class ReadablePort {
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
export class WritablePort {
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
