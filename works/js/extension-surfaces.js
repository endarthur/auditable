// Surface contributions from .gcupkg extensions — EXTENSION_SPEC §3.8.
//
// An extension's index.js (loaded via `load("@gcu/<pkg>")`) calls
// `auditable.registerExtension({ surfaces: [...] })`. cell-types.js fires
// the `window._worksRegisterExtensionSurfaces` hook installed by this
// module's installHooks(). We:
//
//   1. Look up the package's /lib/<pkg>/ root via the lockfile, so each
//      surface entry's `file` path resolves cleanly.
//   2. Read the surface HTML from the workspace VFS.
//   3. Run it through processSurfaceHtml (lib inlining + theme tokens
//      + theme-init script). Same machinery built-in surfaces use, but
//      applied at spawn time rather than build time.
//   4. Create a blob URL, stash it in the surface registry's blob map.
//   5. Register the kind with its routing metadata (extensions list,
//      detect callback, requires list). Slice 2's kindForPath consumes
//      these via kindsForRouting().
//
// Unregister mirrors: revoke blob URL, drop kind, drop extension entry.

import { WKS } from './state.js';
import {
  registerKind, unregisterKind, registerExtensionSurface,
  processSurfaceHtml, setSurfaceBlob,
} from './surface-registry.js';
import {
  registerOpenActionForSurface, unregisterOpenActionForSurface,
} from './context-menu-registry.js';

// Map an extension manifest's name to its /lib path. Mirrors
// _libPathForName in src/js/gcupkg.js so this stays consistent.
function _libPathFor(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Strip a leading slash + collapse `./` so paths inside manifest.surfaces[].file
// always resolve relative to /lib/<pkg>/ — e.g. './surface.html' and
// 'surface.html' end up at /lib/<pkg>/surface.html.
function _normalizeSurfacePath(libRoot, file) {
  let rel = String(file || '').replace(/^\.\//, '');
  if (rel.startsWith('/')) rel = rel.slice(1);
  return libRoot + '/' + rel;
}

const _activeKinds = new Map();  // manifest.name → Set<kind>  (so unregister can find them)

// Path inside /lib/<pkg>/ holding the JSON-safe declarative snapshot of
// the manifest's surface + contextMenu contributions. Written on every
// successful registerExtensionSurfaces; read at boot to register
// declarative pieces before the extension's index.js has run. Detect
// callbacks + filter/action functions are NOT in the snapshot — they
// upgrade when the extension actually loads (its registerExtension
// re-fires and cell-types.js's "already registered → replace" path
// swaps in the live data).
const SNAPSHOT_FILE = '.works-ext.json';

async function _writeSnapshot(libRoot, manifest) {
  if (!WKS.vfs || typeof WKS.vfs.writeFile !== 'function') return;
  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces.map((s) => ({
    kind:        s.kind,
    label:       s.label,
    icon:        s.icon,
    file:        s.file,
    extensions:  s.extensions || [],
    requires:    s.requires || null,
    openAction:  !!s.openAction,
    // detect is intentionally omitted — function values don't serialize
    // and the live extension will re-bind it on load().
  })) : [];
  const contextMenu = Array.isArray(manifest.contextMenu) ? manifest.contextMenu.map((it) => ({
    label:   it.label,
    scope:   it.scope || 'file',
    icon:    it.icon || null,
    section: it.section || null,
    // filter + action omitted — JS only.
  })) : [];
  const snapshot = {
    version:  1,
    name:     manifest.name,
    surfaces,
    contextMenu,
  };
  try {
    await WKS.vfs.writeFile(libRoot + '/' + SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    // Non-fatal — snapshot is a boot-time optimization, the live path still works.
    console.warn(`[works] extension-surfaces: snapshot write failed for ${manifest.name}:`, e.message);
  }
}

// Register every surface contribution in `manifest.surfaces[]`. Async
// because each entry needs a VFS read + blob construction; cell-types
// fires the hook from registerExtension's contribution loop and ignores
// the returned promise (errors land in console). Callers that need to
// know when a surface is ready can `await` this directly.
export async function registerExtensionSurfaces(manifest) {
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) return;
  if (!WKS.vfs) {
    console.warn('[works] extension-surfaces: VFS not ready, deferring', manifest.name);
    return;
  }
  const libRoot = _libPathFor(manifest.name);
  const owned = _activeKinds.get(manifest.name) || new Set();

  for (const s of manifest.surfaces) {
    if (!s || !s.kind || !s.file) continue;
    const surfacePath = _normalizeSurfacePath(libRoot, s.file);
    let html;
    try {
      html = await WKS.vfs.readFile(surfacePath, 'utf8');
    } catch (e) {
      console.error(`[works] extension-surfaces: cannot read ${surfacePath} for kind "${s.kind}":`, e.message);
      continue;
    }

    // Same pipeline built-ins use — lib inlining + theme substitution.
    let processed;
    try {
      processed = processSurfaceHtml(html, s.kind);
    } catch (e) {
      console.error(`[works] extension-surfaces: processSurfaceHtml failed for kind "${s.kind}":`, e);
      continue;
    }

    const url = URL.createObjectURL(new Blob([processed], { type: 'text/html' }));
    setSurfaceBlob(s.kind, url);

    // The kind def carries routing fields (extensions, detect) so
    // Slice 2's kindForPath can consult them. `isExtension: true`
    // distinguishes these from built-in payloads — surfaces.js uses
    // it to skip the built-in payload assertion on spawn.
    registerKind(s.kind, {
      label:       s.label || s.kind,
      icon:        s.icon  || '■',
      extensions:  s.extensions || [],
      detect:      typeof s.detect === 'function' ? s.detect : null,
      isExtension: true,
      extension: {
        manifest:   manifest.name,
        file:       s.file,
        libPath:    libRoot,
        requires:   Array.isArray(s.requires) ? s.requires.slice() : null,
        openAction: !!s.openAction,
      },
    });
    registerExtensionSurface(s.kind, manifest, s);
    // openAction: true sugar — auto-inject "Open in <label>" into the
    // tree's right-click menu. Strictly extension-driven; built-in
    // surfaces use the tree's own "Open" affordance.
    if (s.openAction) {
      registerOpenActionForSurface(s.kind, {
        label: s.label || s.kind,
        extensions: s.extensions || [],
        _manifestName: manifest.name,
        openAction: true,
      });
    }
    owned.add(s.kind);
  }

  if (owned.size > 0) {
    _activeKinds.set(manifest.name, owned);
    // Persist a declarative snapshot for the next boot — see SNAPSHOT_FILE.
    await _writeSnapshot(libRoot, manifest);
  }
}

// Rehydrate every installed extension's declarative surface metadata at
// shell boot. Walks /lib/<scope>/<pkg>/ + /lib/local/<pkg>/, reads each
// .works-ext.json snapshot, and registers a stub manifest. The full
// JS-backed registration happens later when load("@gcu/<pkg>") fires;
// cell-types.js's "already registered" path replaces the stub cleanly.
export async function rehydrateInstalledExtensions() {
  if (!WKS.vfs) return;
  // Enumerate /lib roots. Scoped packages live at /lib/<scope>/<name>,
  // bare packages at /lib/local/<name>. Walk one level at a time so we
  // don't accidentally pick up unrelated files (the lockfile,
  // node_modules-style nested dirs, etc).
  const libPkgRoots = [];
  let topLevel;
  try { topLevel = await WKS.vfs.readdir('/lib'); } catch { return; }
  for (const ent of topLevel) {
    const top = '/lib/' + ent;
    let stat;
    try { stat = await WKS.vfs.stat(top); } catch { continue; }
    if (!stat || stat.type !== 'directory') continue;
    if (ent.startsWith('@')) {
      // scoped — drill one more level
      let inner;
      try { inner = await WKS.vfs.readdir(top); } catch { continue; }
      for (const sub of inner) {
        const pkgPath = top + '/' + sub;
        const s2 = await WKS.vfs.stat(pkgPath).catch(() => null);
        if (s2 && s2.type === 'directory') libPkgRoots.push(pkgPath);
      }
    } else if (ent === 'local') {
      let inner;
      try { inner = await WKS.vfs.readdir(top); } catch { continue; }
      for (const sub of inner) {
        const pkgPath = top + '/' + sub;
        const s2 = await WKS.vfs.stat(pkgPath).catch(() => null);
        if (s2 && s2.type === 'directory') libPkgRoots.push(pkgPath);
      }
    }
    // Anything else under /lib is ignored (lockfile lives there too).
  }

  for (const pkgPath of libPkgRoots) {
    const snapPath = pkgPath + '/' + SNAPSHOT_FILE;
    let raw;
    try { raw = await WKS.vfs.readFile(snapPath, 'utf8'); }
    catch { continue; }   // no snapshot for this package — extension hasn't contributed surfaces, fine
    let snap;
    try { snap = JSON.parse(raw); }
    catch (e) {
      console.warn(`[works] extension-surfaces: malformed snapshot ${snapPath}:`, e.message);
      continue;
    }
    if (snap.version !== 1 || !snap.name) continue;
    if (Array.isArray(snap.surfaces) && snap.surfaces.length > 0) {
      // Synthesize a stub manifest. The detect callback is null in the
      // snapshot — extension-based routing still works, detect-based
      // routing waits for the JS to load. Same for context-menu actions.
      await registerExtensionSurfaces({
        name:     snap.name,
        version:  '0.0.0',   // placeholder — real version arrives with the live manifest
        surfaces: snap.surfaces,
      });
    }
  }
}

export function unregisterExtensionSurfaces(manifest) {
  const owned = _activeKinds.get(manifest.name);
  if (!owned) return;
  for (const kind of owned) {
    unregisterKind(kind);
    unregisterOpenActionForSurface(kind);
  }
  _activeKinds.delete(manifest.name);
}

// Install the cell-types.js hooks. Call once during shell boot, AFTER
// the VFS is ready — registerExtensionSurfaces reads from WKS.vfs.
export function installHooks() {
  window._worksRegisterExtensionSurfaces   = registerExtensionSurfaces;
  window._worksUnregisterExtensionSurfaces = unregisterExtensionSurfaces;
}
