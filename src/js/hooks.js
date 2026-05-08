// ── HOOK BUS ──
//
// Synchronous event bus for intra-notebook lifecycle events.
// Replaces the ad-hoc window._x callbacks (_dagStart, _beforeExec, _afterExec,
// _mcpOnLock, _mcpOnUnlock, _mcpNotifyExecComplete, _cryptoSyncTrigger,
// _notifyDirty, _syncFs, _fsPanelRefresh).
//
// Sync emit returns nothing; emitAsync awaits each handler in registration
// order. Errors in one handler are logged but do not stop subsequent handlers.
//
// Pure module — zero DOM imports. Tested in test/hooks.test.mjs without a
// browser shim.
//
// For cross-realm coordination (Auditable Works panels/iframes), use A-Bus
// (spec_inbox/a-bus-spec.md) — different problem, different solution.

const _listeners = new Map();  // event → Set<fn>

export function on(event, fn) {
  if (typeof event !== 'string' || !event) {
    throw new Error('hooks.on: event must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new Error('hooks.on: fn must be a function');
  }
  let set = _listeners.get(event);
  if (!set) { set = new Set(); _listeners.set(event, set); }
  set.add(fn);
  return () => set.delete(fn);  // unsubscribe handle
}

export function once(event, fn) {
  const off = on(event, (...args) => { off(); fn(...args); });
  return off;
}

export function off(event, fn) {
  const set = _listeners.get(event);
  if (set) set.delete(fn);
}

export function emit(event, ...args) {
  const set = _listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(...args); }
    catch (e) { console.error(`[hooks] handler for "${event}" threw:`, e); }
  }
}

export async function emitAsync(event, ...args) {
  const set = _listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { await fn(...args); }
    catch (e) { console.error(`[hooks] async handler for "${event}" threw:`, e); }
  }
}

export function listenerCount(event) {
  return _listeners.get(event)?.size || 0;
}

// Test-only — not exposed via window.auditable.hooks.
export function _clearAll() {
  _listeners.clear();
}

// ── DAG cell interceptor ──
//
// Special case: goto needs to redirect DAG execution by returning a jump
// target index from `dag:cell:after-exec`. A pure pubsub bus doesn't return
// values to its emitter, so the interceptor lives in a single-slot override
// alongside (but separate from) the bus. Goto sets it, exec.js reads it.
//
// Returns -1 to continue normally, or a target cell index to jump to.

let _dagCellInterceptor = null;

export function setDagCellInterceptor(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('setDagCellInterceptor: fn must be a function or null');
  }
  _dagCellInterceptor = fn;
}

export function getDagCellInterceptor() {
  return _dagCellInterceptor;
}
