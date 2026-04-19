// @gcu/sideact — signals: reactive primitives (signal, computed, effect, batch)
// Zero dependencies, no DOM. Usable in Node, workers, or any JS environment.

// ── tracking ──

let _tracking = null;
let _batchDepth = 0;
const _pendingEffects = new Set();
let _scheduled = false;

function _flush() {
  _scheduled = false;
  const effects = [..._pendingEffects];
  _pendingEffects.clear();
  for (const e of effects) e._run();
}

function _schedule(e) {
  _pendingEffects.add(e);
  if (!_scheduled) { _scheduled = true; queueMicrotask(_flush); }
}

// ── signal ──

export function signal(initial) {
  let _value = initial;
  const _subs = new Set();

  function read() {
    if (_tracking) _subs.add(_tracking);
    return _value;
  }

  function write(v) {
    const next = typeof v === 'function' ? v(_value) : v;
    if (next === _value) return;
    _value = next;
    for (const s of _subs) {
      if (s._dirty !== undefined) s._dirty = true; // computed
      if (s._effect) _schedule(s); // effect
    }
  }

  return [read, write];
}

// ── computed ──

export function computed(fn) {
  let _value, _dirty = true;
  const _subs = new Set();

  const node = {
    _dirty: true,
    _effect: false,
    _run() {
      const prev = _tracking;
      _tracking = node;
      _value = fn();
      _tracking = prev;
      _dirty = false;
    },
  };

  function read() {
    if (_tracking) _subs.add(_tracking);
    if (_dirty || node._dirty) { node._dirty = false; node._run(); }
    return _value;
  }

  // propagate dirty to downstream
  const origDirty = Object.getOwnPropertyDescriptor(node, '_dirty');
  Object.defineProperty(node, '_dirty', {
    get() { return _dirty; },
    set(v) {
      _dirty = v;
      if (v) for (const s of _subs) {
        if (s._dirty !== undefined) s._dirty = true;
        if (s._effect) _schedule(s);
      }
    },
  });

  // initial computation to register dependencies
  node._run();

  return read;
}

// ── effect ──

export function effect(fn) {
  let _cleanup = null;
  let _disposed = false;
  const _deps = new Set(); // signals/computeds we're subscribed to

  const node = {
    _effect: true,
    _dirty: undefined,
    _run() {
      if (_disposed) return;
      if (typeof _cleanup === 'function') _cleanup();
      const prev = _tracking;
      _tracking = node;
      _cleanup = fn();
      _tracking = prev;
    },
  };

  // initial run
  node._run();

  return function dispose() {
    if (_disposed) return;
    _disposed = true;
    if (typeof _cleanup === 'function') _cleanup();
    _pendingEffects.delete(node);
  };
}

// ── batch ──

export function batch(fn) {
  _batchDepth++;
  try { fn(); } finally {
    _batchDepth--;
    if (_batchDepth === 0 && !_scheduled && _pendingEffects.size > 0) {
      _scheduled = true;
      queueMicrotask(_flush);
    }
  }
}
