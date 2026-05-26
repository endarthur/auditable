// Context-menu contributions from .gcupkg extensions — EXTENSION_SPEC §3.8.2.
//
// An extension's manifest.contextMenu items appear in the tree's right-click
// menu, scoped to file/folder/project nodes and optionally gated by a
// filter(path) predicate. The action runs in the shell's JS context, not
// the surface iframe.
//
// The registry is intentionally import-dependency-free — it does NOT
// import the dialog/bus/spawn modules itself. The caller (tree.js) builds
// the ctx object passed to dispatch(item, path, ctx). Keeps this module
// unit-testable in plain Node without resolving '#dialog' import-map aliases.

// Every contributed item, in registration order. Each row holds the
// originating manifest name so unregister can reverse-look it up.
const _items = [];   // [{ manifestName, label, scope, filter, action, icon, section }]

// Synthesized "Open in <label>" entries from openAction: true surfaces —
// same shape as items[] but kept in a separate map keyed by kind so
// unregisterExtensionSurfaces can drop them when the surface is gone.
const _openActions = new Map();   // kind → entry

// Return the items that apply to a given (path, type) node — items
// whose scope matches the type AND whose filter (if any) returns
// truthy. Result is in registration order; tree.js inserts them as a
// separate section under the built-in menu items. filter errors are
// caught and the item is hidden — a broken filter is no reason to
// swallow the entire right-click.
export function itemsForNode(path, type) {
  const out = [];
  // Surface openAction: true entries first — they're the most discoverable
  // ("Open in <Data Grid>" is the obvious top-of-section item).
  for (const [kind, entry] of _openActions) {
    if (entry.scope !== type) continue;
    if (entry.filter) {
      let ok = false;
      try { ok = !!entry.filter(path); } catch { ok = false; }
      if (!ok) continue;
    }
    out.push({ key: `_openin:${kind}`, label: entry.label, item: entry });
  }
  for (let i = 0; i < _items.length; i++) {
    const it = _items[i];
    if (it.scope && it.scope !== type) continue;
    if (it.filter) {
      let ok = false;
      try { ok = !!it.filter(path); } catch { ok = false; }
      if (!ok) continue;
    }
    out.push({ key: `_extmenu:${i}`, label: it.label, item: it });
  }
  return out;
}

// Invoke one item's action with the provided ctx (built by the caller).
// Returns the action's return value, or undefined on error after logging.
export async function dispatch(item, path, ctx) {
  try {
    return await item.action(path, ctx);
  } catch (e) {
    console.error(`[works] contextMenu action "${item.label}":`, e);
    if (ctx && typeof ctx.setStatus === 'function') {
      ctx.setStatus(`"${item.label}" failed: ${(e && e.message) || e}`);
    }
  }
}

export function registerExtensionContextMenu(manifest) {
  if (!Array.isArray(manifest.contextMenu) || manifest.contextMenu.length === 0) return;
  for (const it of manifest.contextMenu) {
    _items.push({
      manifestName: manifest.name,
      label:   it.label,
      scope:   it.scope || 'file',
      filter:  typeof it.filter === 'function' ? it.filter : null,
      action:  it.action,
      icon:    it.icon || null,
      section: it.section || null,
    });
  }
}

export function unregisterExtensionContextMenu(manifest) {
  for (let i = _items.length - 1; i >= 0; i--) {
    if (_items[i].manifestName === manifest.name) _items.splice(i, 1);
  }
}

// openAction: true on a surface contribution auto-injects an
// "Open in <label>" entry. extension-surfaces.js calls this after the
// surface has been registered, since openAction depends on the surface
// kind being live.
export function registerOpenActionForSurface(kind, surfaceDef) {
  if (!surfaceDef.openAction) return;
  const label = `Open in ${surfaceDef.label || kind}`;
  const exts  = Array.isArray(surfaceDef.extensions) ? surfaceDef.extensions.map(s => s.toLowerCase()) : [];
  _openActions.set(kind, {
    manifestName: surfaceDef._manifestName || null,
    label,
    scope:  'file',
    // Synchronous predicate — runs on every right-click. detect()
    // callbacks aren't consulted here; users wanting magic-byte routing
    // through the right-click menu can declare a manual contextMenu
    // entry.
    filter: (path) => {
      const base = String(path).split(/[\\/]/).pop().toLowerCase();
      return exts.some(ext => base.endsWith(ext));
    },
    action: (path, ctx) => ctx.spawnSurface(kind, { path }),
  });
}

export function unregisterOpenActionForSurface(kind) {
  _openActions.delete(kind);
}

// Install the cell-types.js hooks. Call once during shell boot.
export function installHooks() {
  window._worksRegisterExtensionContextMenu   = registerExtensionContextMenu;
  window._worksUnregisterExtensionContextMenu = unregisterExtensionContextMenu;
}

// Test-only helper to wipe state between describe() blocks. Not part
// of the public API — production callers go through (un)register.
export function _resetForTests() {
  _items.length = 0;
  _openActions.clear();
}
