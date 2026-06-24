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
  processSurfaceHtml, setSurfaceBlob, ensureLibSource,
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

// ── Assembled surfaces (notebook-as-package) ───────────────────────────
// A surface entry with `assemble: true` is NOT a static .html payload — it's
// a module-tree package (e.g. @gcu/notebook) whose `assembly.json` lists the
// modules + shared libs + classics + fragments that make up the surface. We
// assemble them into the boot.html shell at registration time: build the
// `_S` registry + import map (the same runtime boot the standalone
// auditable.html uses), substitute the boot.html marker slots, and blob it.
// All parsing happened at pack time; this is mechanical string assembly.

// Build the registry boot block — the runtime half of build.js's
// generateModuleBoot, replicated here. `reg` maps registry name → source;
// `order` is the import order. Module sources get `</script>`-escaped (they
// live inside a <script> tag); classics are spliced raw (minified bundles
// with no literal </script>), matching the standalone.
function _buildRegistryBoot(reg, order) {
  const entries = order.map((n) => {
    let json = JSON.stringify(reg[n]);
    json = json.replace(/<\/script>/gi, '<\\/script>');
    return JSON.stringify(n) + ': ' + json;
  });
  return '(async () => {\n' +
    'const _S = {\n' + entries.join(',\n') + '\n};\n' +
    'const _O = ' + JSON.stringify(order) + ';\n' +
    'const _U = {};\n' +
    'for (const n of _O) {\n' +
    "  _U[n] = URL.createObjectURL(new Blob([_S[n] + '\\n//# sourceURL=auditable/' + n + '.js\\n'], {type: 'application/javascript'}));\n" +
    '}\n' +
    "const _m = document.createElement('script');\n" +
    "_m.type = 'importmap';\n" +
    'const _im = {};\n' +
    "for (const n of _O) _im['#' + n] = _U[n];\n" +
    "_m.textContent = JSON.stringify({imports: _im});\n" +
    'document.body.appendChild(_m);\n' +
    "for (const n of _O) await import(_U[n]);\n" +
    '_m.remove();\n' +
    '})();\n';
}

// Assemble an `assemble: true` surface into its final HTML. Reads the
// package's assembly.json, resolves every entry to a source (own modules from
// the package dir, `lib` entries from the shell via ensureLibSource, `fragment`
// entries by splicing another package's module set), reads boot.html, and
// substitutes the __GCU_CLASSIC_<name>__ / __GCU_REGISTRY__ marker slots.
async function _assembleSurface(libRoot, vfs) {
  const assembly = JSON.parse(await vfs.readFile(libRoot + '/assembly.json', 'utf8'));
  const order = [];
  const reg = {};   // registry name → source

  for (const e of (assembly.entries || [])) {
    if (e.kind === 'module') {
      reg[e.name] = await vfs.readFile(libRoot + '/' + e.file, 'utf8');
      order.push(e.name);
    } else if (e.kind === 'lib') {
      const src = await ensureLibSource(e.name, vfs);
      if (src == null) { const err = new Error(`assemble: lib '${e.name}' not provisioned`); err._depPending = true; throw err; }
      const regName = e.as || e.name;
      reg[regName] = src;
      order.push(regName);
    } else if (e.kind === 'fragment') {
      // Splice the fragment package's module set in at this position. One
      // level only (fragments don't nest) — its assembly.json is modules-only.
      const fragRoot = _libPathFor(e.package);
      const fragAsm = JSON.parse(await vfs.readFile(fragRoot + '/assembly.json', 'utf8'));
      for (const fe of (fragAsm.entries || [])) {
        if (fe.kind !== 'module') continue;
        reg[fe.name] = await vfs.readFile(fragRoot + '/' + fe.file, 'utf8');
        order.push(fe.name);
      }
    }
    // unknown kinds ignored
  }

  // Classic IIFE bundles (cm6, acorn) — resolved from the shell, spliced raw.
  const classics = {};
  for (const c of (assembly.classics || [])) {
    const src = await ensureLibSource(c, vfs);
    if (src == null) { const err = new Error(`assemble: classic '${c}' not provisioned`); err._depPending = true; throw err; }
    classics[c] = src;
  }

  let html = await vfs.readFile(libRoot + '/boot.html', 'utf8');
  for (const c of (assembly.classics || [])) {
    html = html.replace('/*__GCU_CLASSIC_' + c + '__*/', () => classics[c]);
  }
  html = html.replace('/*__GCU_REGISTRY__*/', () => _buildRegistryBoot(reg, order));
  return html;
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

    // Assembled surface (notebook-as-package): build from the package's
    // assembly.json rather than processing a static .html payload.
    let processed;
    if (s.assemble) {
      try {
        processed = await _assembleSurface(libRoot, WKS.vfs);
      } catch (e) {
        // A dep not yet in /lib means we're mid-install, before the dep-closure
        // ran — installEntry re-evaluates this works.js after the closure, when
        // the assemble succeeds. Expected + recovered, so info not error.
        if (e && e._depPending) {
          console.info(`[works] notebook assemble deferred (deps installing): ${e.message}`);
        } else {
          console.error(`[works] extension-surfaces: assemble failed for kind "${s.kind}":`, e);
        }
        continue;
      }
    } else {
      const surfacePath = _normalizeSurfacePath(libRoot, s.file);
      let html;
      try {
        html = await WKS.vfs.readFile(surfacePath, 'utf8');
      } catch (e) {
        console.error(`[works] extension-surfaces: cannot read ${surfacePath} for kind "${s.kind}":`, e.message);
        continue;
      }
      // Ensure the surface's declared lib `requires` are in the lib store
      // before inlining. Baked libs (CORE_LIBS / SHARED_LIBS) are already
      // there; a non-baked require — a provisioned package's lib, or this
      // package's OWN engine shipped as index.js → /lib/<pkg>/source — must
      // be pulled from /lib first, else its bare `@gcu/<name>` import survives
      // uninlined and the surface fails to load. (Built-in surfaces never hit
      // this: all their deps are baked.)
      for (const req of (Array.isArray(s.requires) ? s.requires : [])) {
        try { await ensureLibSource(req, WKS.vfs); } catch { /* a genuinely missing lib surfaces as the uninlined import below */ }
      }
      // Same pipeline built-ins use — lib inlining + theme substitution.
      try {
        processed = processSurfaceHtml(html, s.kind);
      } catch (e) {
        console.error(`[works] extension-surfaces: processSurfaceHtml failed for kind "${s.kind}":`, e);
        continue;
      }
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
      universal:   !!s.universal,
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
