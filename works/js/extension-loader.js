// works.js evaluator + shell-side window.auditable.registerExtension.
//
// EXTENSION_SPEC §2.5 + §3.8.7. An extension that contributes to the
// Works shell (surfaces, contextMenu, future MCP tools) ships a
// works.js entry point. The shell evaluates it at install time AND at
// boot — once per installed extension — and the script's
// registerExtension call wires everything directly. No A-Bus bridge,
// no snapshots, no cross-frame coordination.
//
// The notebook-context registerExtension (cellType / taggedLanguage /
// exports / etc) lives in the notebook iframe and is separate from
// the shell-side surface defined here. They share a name; they don't
// share state.

import { WKS } from './state.js';
import {
  registerExtensionSurfaces, unregisterExtensionSurfaces,
} from './extension-surfaces.js';
import {
  registerExtensionContextMenu, unregisterExtensionContextMenu,
} from './context-menu-registry.js';

// Manifests we've registered, keyed by name. Used to drive the
// "already-registered → unregister-then-register" replace path on
// re-install.
const _registered = new Map();

// Capability slots the shell handles. Anything outside this set
// is a notebook-context concern and gets a clear warning so the
// extension author knows to move it to index.js.
const SHELL_CAPABILITIES = new Set(['surfaces', 'contextMenu', 'mcpTools']);
const NOTEBOOK_CAPABILITIES = new Set([
  'cellType', 'taggedLanguage', 'taggedLanguages',
  'airLowerer', 'exports', 'contextHook', 'globals',
]);

function _validate(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('shell registerExtension: manifest must be an object');
  }
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error('shell registerExtension: manifest.name is required');
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`shell registerExtension: manifest.version is required (${manifest.name})`);
  }
  // Per-slot shape checks — minimal, since the in-tree validator in
  // src/js/cell-types.js does the full shape check on the notebook
  // side. Here we only care about the slots we'll actually wire.
  if (manifest.surfaces !== undefined && !Array.isArray(manifest.surfaces)) {
    throw new Error(`shell registerExtension: manifest.surfaces must be an array (${manifest.name})`);
  }
  if (manifest.contextMenu !== undefined && !Array.isArray(manifest.contextMenu)) {
    throw new Error(`shell registerExtension: manifest.contextMenu must be an array (${manifest.name})`);
  }
}

// Warn loudly when a works.js manifest mentions notebook-context
// capabilities. Those should live in index.js, not here. The warning
// names the offending slot so the user knows where to move it.
function _warnMisplaced(manifest) {
  for (const slot of NOTEBOOK_CAPABILITIES) {
    if (manifest[slot] !== undefined) {
      console.warn(
        `[works] @${manifest.name}'s works.js declares "${slot}" — that's a notebook-context capability. ` +
        `Move it to index.js (see EXTENSION_SPEC §2.5).`
      );
    }
  }
}

async function shellRegisterExtension(manifest) {
  _validate(manifest);
  _warnMisplaced(manifest);

  // Replace path — re-evaluating works.js (re-install or re-boot)
  // unregisters the previous contributions first.
  if (_registered.has(manifest.name)) {
    const prev = _registered.get(manifest.name);
    try { unregisterExtensionSurfaces(prev); } catch (e) { console.error(e); }
    try { unregisterExtensionContextMenu(prev); } catch (e) { console.error(e); }
  }
  _registered.set(manifest.name, manifest);

  if (Array.isArray(manifest.surfaces) && manifest.surfaces.length > 0) {
    try { await registerExtensionSurfaces(manifest); }
    catch (e) { console.error(`[works] surface registration for "${manifest.name}":`, e); }
  }
  if (Array.isArray(manifest.contextMenu) && manifest.contextMenu.length > 0) {
    try { registerExtensionContextMenu(manifest); }
    catch (e) { console.error(`[works] contextMenu registration for "${manifest.name}":`, e); }
  }
  // mcpTools — pending §3.7 spec
}

// Public lookup helpers. Mirror the shape of the notebook-side
// API so works.js authors can call them the same way they would
// from index.js.
function shellGetExtension(name)  { return _registered.get(name) || null; }
function shellListExtensions()    { return [..._registered.values()]; }

// Install window.auditable on the shell. Called once at boot,
// BEFORE evaluating any works.js. The notebook iframe has its own
// window.auditable with the full registerExtension; the shell's
// is a different namespace, in a different window — they don't
// interact.
export function installShellAuditable() {
  if (!window.auditable) window.auditable = {};
  window.auditable.registerExtension = shellRegisterExtension;
  window.auditable.getExtension      = shellGetExtension;
  window.auditable.listExtensions    = shellListExtensions;
  // Surface the registered map for debug / diagnostics.
  window.auditable._shellRegistered  = _registered;
}

// ── works.js loader ────────────────────────────────────────────────────

const _libPathFor = (name) => /^@[\w.-]+\/[\w.-]+$/.test(name)
  ? '/lib/' + name
  : '/lib/local/' + name;

// Evaluate /lib/<pkg>/works.js if it exists. Reads the source,
// wraps it in a blob URL, dynamic-imports it (so the script's
// `window.auditable.registerExtension({...})` call fires in this
// shell context). Idempotent — re-evaluating an already-registered
// extension hits the replace path in shellRegisterExtension.
//
// `name` is the package name (`@gcu/foo` or `bare-name`). Returns
// true on success, false on no-works.js (silent — not every
// extension has one), throws on actual evaluation error.
export async function evaluateWorksScript(name) {
  if (!WKS.vfs) return false;
  const libPath = _libPathFor(name);
  const worksPath = libPath + '/works.js';
  let source;
  try { source = await WKS.vfs.readFile(worksPath, 'utf8'); }
  catch { return false; }   // no works.js for this extension — fine

  // Same blob-URL pattern the notebook iframe uses for its own
  // load() — the script evaluates as an ES module in the shell
  // window. Revoke after import so we don't leak blob URLs.
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await import(url);
    console.info(`[works] evaluated ${worksPath}`);
    return true;
  } catch (e) {
    console.error(`[works] works.js for "${name}" failed:`, e);
    throw e;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Walk /lib at boot looking for every installed extension's
// works.js. Same enumeration shape as gcupkg installer's _libPathFor:
// scoped names at /lib/<scope>/<name>, bare names under /lib/local/.
//
// Logs a one-line summary so reload-time problems are diagnosable
// without setting flags: "found N, evaluated M, registered K".
export async function evaluateAllWorksScripts() {
  if (!WKS.vfs) return;
  const names = await _enumerateInstalled();
  const evaluated = [];
  const skipped = [];     // installed but no works.js — usually fine
  const errored = [];     // works.js threw — diagnostic
  for (const name of names) {
    try {
      const ok = await evaluateWorksScript(name);
      if (ok) evaluated.push(name);
      else    skipped.push(name);
    } catch (e) {
      errored.push({ name, message: e && e.message });
    }
  }
  console.info(
    `[works] /lib has ${names.length} installed extensions; ` +
    `${evaluated.length} works.js evaluated, ` +
    `${skipped.length} have no works.js, ` +
    `${errored.length} errored, ` +
    `${_registered.size} registered`
  );
  if (evaluated.length)
    console.info('[works]   evaluated:', evaluated.join(', '));
  if (errored.length) {
    console.warn('[works]   errored:',
      errored.map((e) => `${e.name} (${e.message})`).join(', '));
  }
}

async function _enumerateInstalled() {
  const out = [];
  let topLevel;
  try { topLevel = await WKS.vfs.readdir('/lib'); } catch { return out; }
  for (const ent of topLevel) {
    const top = '/lib/' + ent;
    const stat = await WKS.vfs.stat(top).catch(() => null);
    if (!stat || stat.type !== 'directory') continue;
    if (ent.startsWith('@')) {
      // scoped — drill one level
      const inner = await WKS.vfs.readdir(top).catch(() => []);
      for (const sub of inner) {
        const pkgPath = top + '/' + sub;
        const s2 = await WKS.vfs.stat(pkgPath).catch(() => null);
        if (s2 && s2.type === 'directory') out.push(ent + '/' + sub);
      }
    } else if (ent === 'local') {
      const inner = await WKS.vfs.readdir(top).catch(() => []);
      for (const sub of inner) {
        const pkgPath = top + '/' + sub;
        const s2 = await WKS.vfs.stat(pkgPath).catch(() => null);
        if (s2 && s2.type === 'directory') out.push(sub);
      }
    }
    // anything else under /lib (lockfile, etc) is ignored
  }
  return out;
}
