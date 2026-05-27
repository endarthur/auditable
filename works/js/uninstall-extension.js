// Symmetric counterpart to installGcupkg. Removes everything the
// installer wrote AND drops the shell-side registrations (surfaces +
// context-menu items) the extension contributed.
//
// Inputs: pkgName ('@scope/name' or 'bare-name'), matching whatever
// the lockfile + extension-loader use as the manifest key.
//
// Side effects:
//   - shell registry: unregisterExtensionSurfaces + unregisterExtensionContextMenu
//   - VFS: rm -r /lib/<pkg>, /usr/share/examples/<slug>, /usr/share/docs/<slug>
//   - lockfile: delete the entry from /lib/.gcu-lock.json
//   - bus signal: fires VFS.Changed for /lib so the notebook iframe
//                 drops the entry from _installedModules
//   - tree refresh
//
// Notebook-side _installedModules cleanup is handled by the iframe's
// VFS.Changed subscription with the gcupkg-disappearance diff.

import { WKS, setStatus } from './state.js';
import {
  unregisterExtensionSurfaces,
} from './extension-surfaces.js';
import {
  unregisterExtensionContextMenu,
} from './context-menu-registry.js';
import { refreshTree } from './tree.js';

function _libPathFor(name) {
  return /^@[\w.-]+\/[\w.-]+$/.test(name) ? '/lib/' + name : '/lib/local/' + name;
}
function _slug(name) {
  return name.replace(/\//g, '_');
}

export async function uninstallExtension(pkgName) {
  if (!WKS.vfs) throw new Error('uninstallExtension: workspace VFS not ready');
  if (!pkgName || typeof pkgName !== 'string') {
    throw new Error('uninstallExtension: pkgName must be a non-empty string');
  }

  // 1. Drop shell-side registrations. Look the manifest up by name;
  //    if it's missing (extension never registered or already removed),
  //    silently move on — the disk cleanup below is the source of truth.
  const manifest = window.auditable?.getExtension?.(pkgName);
  if (manifest) {
    try { unregisterExtensionSurfaces(manifest); }
    catch (e) { console.warn('[uninstall] surfaces:', e.message); }
    try { unregisterExtensionContextMenu(manifest); }
    catch (e) { console.warn('[uninstall] contextMenu:', e.message); }
    // The shell-side registry map lives in extension-loader's
    // _registered; clear via the public surface.
    window.auditable._shellRegistered?.delete?.(pkgName);
  }

  // 2. Wipe the disk footprint.
  const libPath = _libPathFor(pkgName);
  const slug = _slug(pkgName);
  for (const p of [libPath, '/usr/share/examples/' + slug, '/usr/share/docs/' + slug]) {
    try {
      if (typeof WKS.vfs.rm === 'function') {
        await WKS.vfs.rm(p, { recursive: true });
      }
    } catch (e) {
      // ENOENT is expected for paths the extension didn't populate
      // (no examples, no docs, or already partially cleaned). Anything
      // else is a real problem — log but keep going so we don't leave
      // half-uninstalled state.
      if (!/ENOENT|no such|not found/i.test(e.message || '')) {
        console.warn(`[uninstall] failed to remove ${p}:`, e.message);
      }
    }
  }

  // 3. Drop the lockfile entry. Best-effort — no lockfile yet means
  //    pkg never wrote one (cell-side install can skip it).
  const lockPath = '/lib/.gcu-lock.json';
  try {
    const lock = JSON.parse(await WKS.vfs.readFile(lockPath, 'utf8'));
    if (lock.modules && lock.modules[pkgName]) {
      delete lock.modules[pkgName];
      // Also drop a `<pkg>/adder` secondary entry if present.
      const secondaryKey = pkgName + '/adder';
      if (lock.modules[secondaryKey]) delete lock.modules[secondaryKey];
      await WKS.vfs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    }
  } catch { /* no lockfile or unreadable — fine */ }

  // 4. Notify any open notebook surface that /lib changed so it can
  //    diff _installedModules and drop the now-orphaned gcupkg entries.
  try {
    WKS.worksBus?.signal(
      { interface: 'VFS', member: 'Changed' },
      [{ path: '/lib', op: 'uninstall', name: pkgName }]);
  } catch { /* bus not yet wired — fine */ }

  setStatus(`removed ${pkgName}`);
  refreshTree();
}
