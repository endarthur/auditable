// File → Mount folder… — adopt a disk folder as a workspace mount at
// /mnt/<name>. Mounts are saved in the shell-meta IndexedDB and reconnect
// on reload, permissions allowing.
//
// The mount is per-machine state — it points at a real disk folder, so
// it does NOT travel with the workspace export (the persistent-mount list
// in persist.js is /projects + /lib + /home, deliberately not /mnt).

import { WKS, setStatus } from './state.js';
import { FSAABackend } from '#vfs';
import { metaGet, metaSet } from './meta.js';

const MNT_ROOT = '/mnt';
const MOUNTS_KEY = 'workspace-mounts';
const sanitize = (s) => String(s).trim().replace(/[/\\]+/g, '-') || 'mount';

// The saved-mount list, mirrored in memory. { name, handle } pairs.
let _savedMounts = [];

// Pick a /mnt/<name> not currently in use. Dedups against both active
// mounts and saved-but-not-yet-reconnected ones.
function uniqueMountName(suggested) {
  const base = sanitize(suggested);
  const taken = new Set([
    ...[...WKS.vfs._mounts.keys()]
      .filter((m) => m.startsWith(MNT_ROOT + '/'))
      .map((m) => m.slice(MNT_ROOT.length + 1)),
    ..._savedMounts.map((m) => m.name),
  ]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const c = base + '-' + n;
    if (!taken.has(c)) return c;
  }
}

async function _saveList() {
  await metaSet(MOUNTS_KEY, _savedMounts).catch(() => {});
}

// OPFS handles don't have a permission model — queryPermission may be
// absent or throw. Treat that as granted; let the FSAA init succeed or
// fail. Disk-folder handles do have queryPermission and must be granted.
async function _hasPermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return true;
  try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; }
  catch { return false; }
}

async function _doMount(handle, name) {
  await WKS.vfs.mkdir(MNT_ROOT, { recursive: true }).catch(() => {});
  const mountPath = MNT_ROOT + '/' + name;
  // vfs.mount accepts a Backend instance directly; it calls init() and
  // emits 'mount' for us.
  await WKS.vfs.mount(mountPath, new FSAABackend({ handle }));
  return mountPath;
}

/**
 * Mount `handle` at /mnt/<name>, persist it, return the mount path.
 * The user-facing mountFolder() drives this after a successful picker;
 * works-smoke calls it directly with an OPFS handle.
 */
export async function mountHandle(handle, suggestedName) {
  const name = uniqueMountName(suggestedName || handle.name);
  const mountPath = await _doMount(handle, name);
  _savedMounts.push({ name, handle });
  await _saveList();
  return mountPath;
}

/** Unmount /mnt/<name> and forget the saved handle. Disk content is untouched. */
export async function unmountAt(mountPath) {
  if (!mountPath.startsWith(MNT_ROOT + '/')) return;
  const name = mountPath.slice(MNT_ROOT.length + 1);
  await WKS.vfs.unmount(mountPath).catch(() => {});
  _savedMounts = _savedMounts.filter((m) => m.name !== name);
  await _saveList();
  setStatus('unmounted ' + mountPath);
}

/** File → Mount folder… — pick a disk folder, mount it, persist. */
export async function mountFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({
      id: 'auditable-works-mount', mode: 'readwrite' });
  } catch { return null; }   // user cancelled
  try {
    const mountPath = await mountHandle(handle, handle.name);
    setStatus('mounted ' + handle.name + ' at ' + mountPath);
    return mountPath;
  } catch (e) {
    console.error('[works] mount failed:', e);
    setStatus('mount failed: ' + (e.message || e));
    return null;
  }
}

/**
 * On boot: load the saved-mount list and reconnect each one. Mounts whose
 * permission has lapsed are kept in the saved list (so the user can
 * recover by re-mounting) but skipped with a console.warn.
 */
export async function restoreMounts() {
  _savedMounts = (await metaGet(MOUNTS_KEY).catch(() => null)) || [];
  if (_savedMounts.length === 0) return;
  await WKS.vfs.mkdir(MNT_ROOT, { recursive: true }).catch(() => {});
  for (const { name, handle } of _savedMounts) {
    if (!(await _hasPermission(handle))) {
      console.warn('[works] mount ' + name + ' needs permission — re-mount to reconnect');
      continue;
    }
    try { await _doMount(handle, name); }
    catch (e) { console.warn('[works] failed to remount ' + name + ':', e.message); }
  }
}

/** Clear the saved-mount list — called by resetWorkspace. */
export async function clearSavedMounts() {
  _savedMounts = [];
  await metaSet(MOUNTS_KEY, undefined).catch(() => {});
}
