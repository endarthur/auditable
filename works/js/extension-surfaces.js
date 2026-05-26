// Surface contributions from .gcupkg extensions — EXTENSION_SPEC §3.8.
//
// Called from the shell-side `window.auditable.registerExtension` (set
// up in extension-loader.js) whenever an extension's works.js declares
// a manifest with `surfaces: [...]`. For each entry we:
//
//   1. Resolve the gcupkg's /lib/<pkg>/ root.
//   2. Read the surface HTML from the workspace VFS.
//   3. Run it through processSurfaceHtml (lib inlining + theme tokens
//      + theme-init script). Same machinery built-in surfaces use, but
//      applied at spawn time rather than build time.
//   4. Create a blob URL, stash it in the surface registry's blob map.
//   5. Register the kind with its routing metadata (extensions list,
//      detect callback, requires list). Slice 2's kindForPath consumes
//      these via kindsForRouting().
//
// Unregister mirrors: revoke blob URL, drop kind, drop openAction
// context-menu entry.

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

  if (owned.size > 0) _activeKinds.set(manifest.name, owned);
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
