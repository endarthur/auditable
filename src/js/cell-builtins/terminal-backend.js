// Terminal backend interface for ui.terminal().
//
// A backend creates a terminal instance mounted in a container DOM element
// and returns a *handle* satisfying the canonical surface below. Cells that
// stick to the canonical surface are backend-portable; cells that reach
// through `handle.native` (or the proxy fall-through) accept backend
// coupling.
//
// ─── Backend factory ─────────────────────────────────────────────────────
//   create(options, container) → handle
//     options:   { rows?, cols?, ...backend-specific }
//     container: HTMLElement; the backend mounts its DOM inside.
//     handle:    Proxy that exposes the canonical surface AND falls through
//                to the native object for anything not in the surface.
//
// ─── Canonical handle surface ────────────────────────────────────────────
// Every backend's handle MUST provide these. Cells that use only these
// methods/properties are portable across backends.
//
//   write(data: string | Uint8Array)        — push bytes/text in
//   onInput(handler: (string) => void)      — user input out (returns unsub)
//   onResize(handler: ({rows, cols}) => v)  — dimensions changed (returns unsub)
//   focus()                                  — focus the input target
//   clear()                                  — clear visible screen
//   reset()                                  — full state reset (ESC c)
//   resize(rows, cols)                       — change dimensions
//   dispose()                                — full teardown; idempotent
//   readonly rows: number
//   readonly cols: number
//   readonly backendType: string             — e.g. "gcu-term", "xterm"
//   readonly native: object                  — escape hatch (backend instance)
//
// ─── Backend registry ────────────────────────────────────────────────────
// Backends register themselves at module init via `registerBackend`. The
// default backend is `gcu-term`; switch globally via `setDefaultBackend`,
// or per-call via `ui.terminal({ backend: 'xterm', ... })`.

const _backends = Object.create(null);
let _defaultBackend = 'gcu-term';

export function registerBackend(name, createFn) {
  if (typeof createFn !== 'function') {
    throw new Error(`registerBackend: createFn must be a function for ${name}`);
  }
  _backends[name] = createFn;
}

export function getBackend(name) {
  const create = _backends[name];
  if (!create) {
    throw new Error(`unknown terminal backend: ${name} (registered: ${Object.keys(_backends).join(', ')})`);
  }
  return create;
}

export function setDefaultBackend(name) {
  if (!(name in _backends)) {
    throw new Error(`unknown terminal backend: ${name}`);
  }
  _defaultBackend = name;
}

export function getDefaultBackend() {
  return _defaultBackend;
}

// Wrap a canonical-surface object and its native backend instance in a
// Proxy that prefers canonical methods but falls through to native for
// backend-specific access. Used by every backend's create().
export function makeHandle(canonical, native) {
  return new Proxy(canonical, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      const v = native[prop];
      if (typeof v === 'function') return v.bind(native);
      return v;
    },
    set(target, prop, value, receiver) {
      if (prop in target) return Reflect.set(target, prop, value, receiver);
      native[prop] = value;
      return true;
    },
    has(target, prop) {
      return prop in target || prop in native;
    },
  });
}
