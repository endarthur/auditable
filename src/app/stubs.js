// ── CM6 / EDITOR STUBS ──
// No-op replacements for CM6 and editor functions that the app runtime doesn't need.

function refreshTaggedLanguages() {}
function getEditor() { return null; }
function createEditor() { return null; }
function setEditorAutocomplete() {}
function setEditorSearchDecorations() {}
function clearEditorSearchDecorations() {}
function clearAllSearchDecorations() {}

const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';

// ── HOOK BUS STUB ──
// Tiny in-app substitute for src/js/hooks.js (which the app runtime doesn't bundle).
// Same shape as window.auditable.hooks so cell-builtins and cell-context can talk to it.
const __appHookListeners = new Map();
function on(event, fn) {
  let s = __appHookListeners.get(event);
  if (!s) { s = new Set(); __appHookListeners.set(event, s); }
  s.add(fn);
  return () => s.delete(fn);
}
function emit(event, ...args) {
  const s = __appHookListeners.get(event);
  if (!s) return;
  for (const fn of s) { try { fn(...args); } catch (e) { console.error(e); } }
}
function off() {}
function once(event, fn) {
  const u = on(event, (...a) => { u(); fn(...a); });
  return u;
}
function emitAsync(event, ...args) { emit(event, ...args); return Promise.resolve(); }
function listenerCount(event) { return __appHookListeners.get(event)?.size || 0; }
let __appDagInterceptor = null;
function setDagCellInterceptor(fn) { __appDagInterceptor = fn; }
function getDagCellInterceptor() { return __appDagInterceptor; }
const hooks = { on, off, once, emit, emitAsync, listenerCount, setDagCellInterceptor, getDagCellInterceptor };

// ── FS / NOTEBOOK STUBS ──
// Exported apps don't have the notebook filesystem.
function fsRead() { throw new Error('notebook.fs is not available in exported apps'); }
function createNotebookFs() {
  return {
    list: () => [],
    read: () => { throw new Error('notebook.fs is not available in exported apps'); },
    write: () => { throw new Error('notebook.fs is not available in exported apps'); },
    delete: () => false,
    exists: () => false,
  };
}

// ── SIDEACT STUBS ──
// Reactive primitives — pass-through no-ops in app target so cells that
// imported them don't crash at parse time. Cells that actually USE them
// will malfunction; pyskit / other extension authors using sr.state should
// not export to "app" mode.
function signal(initial) { let v = initial; const s = () => v; s.set = (x) => { v = x; }; s._signal = true; return s; }
function computed(fn) { return fn; }
function effect(fn) { try { fn(); } catch {} }
function batch(fn) { return fn(); }
function h() { return null; }
function each() { return null; }
function render() {}
