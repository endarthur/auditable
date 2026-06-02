// The workspace VFS — the one filesystem the whole desktop shares.
//
// Three mounts (auditable-works-spec §7.2): one persistent backend at `/` —
// the storage home — inside which `projects/`, `lib/`, `home/` are ordinary
// directories; plus volatile MemoryBackend overlays at `/tmp` (POSIX-shape
// scratch space, workspace-wide; surfaces see it through the / proxy) and
// `/sys`.
//
// The storage home is one of two kinds (§12.1): a **disk folder** (File
// System Access API) or **browser-resident** (IndexedDB). IndexedDB is the
// default; a disk folder is adopted via File → Open folder…, its handle
// saved so the workspace reconnects on reload.

import { VFS } from '#vfs';
import { WKS } from './state.js';
import { detectWorkspaceBlock, hydrateWorkspace } from './persist.js';
import { consumePendingDisk, hydrateVfsFromDisk } from './disk.js';
import { metaGet, metaSet } from './meta.js';
import { clearSavedMounts } from './mount.js';

const HANDLE_KEY = 'workspace-handle';

// ── Reconnect gate ───────────────────────────────────────────────────
// On reload, a saved folder handle's permission is often back to 'prompt';
// re-granting it needs a user gesture. Block boot behind a one-click gate
// rather than silently dropping to an empty IndexedDB workspace.

function _reconnectGate(handle) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'works-reconnect';
    overlay.innerHTML =
      '<div class="works-reconnect-card">'
      + '<div class="works-reconnect-title">Reconnect your workspace</div>'
      + '<div class="works-reconnect-msg">Auditable Works needs permission to '
      + 'reopen the workspace folder <b></b>.</div>'
      + '<div class="works-reconnect-actions">'
      + '<button class="works-reconnect-go">Reconnect</button>'
      + '<button class="works-reconnect-skip">Start fresh instead</button>'
      + '</div></div>';
    overlay.querySelector('b').textContent = handle.name;
    document.body.appendChild(overlay);
    overlay.querySelector('.works-reconnect-go').onclick = async () => {
      try {
        if (await handle.requestPermission({ mode: 'readwrite' }) === 'granted') {
          overlay.remove();
          resolve(true);
        }
      } catch { /* keep the gate up */ }
    };
    overlay.querySelector('.works-reconnect-skip').onclick = () => {
      overlay.remove();
      resolve(false);
    };
  });
}

// ── Workspace setup ──────────────────────────────────────────────────

// A volatile in-memory workspace VFS with the standard mounts + dirs. Used by
// both the embedded-HTML snapshot and the .gcudsk open paths.
async function _memoryWorkspaceVfs() {
  const vfs = await VFS.create({
    backends: {
      '/':        { type: 'memory' },
      '/tmp':     { type: 'memory' },
      '/sys':     { type: 'memory' },
      '/usr':     { type: 'memory' },   // shell builtins (§Unix: /usr/lib)
    },
  });
  for (const dir of ['/projects', '/lib', '/home', '/home/.works', '/mnt', '/usr/lib']) {
    try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  }
  return vfs;
}

export async function setupWorkspace() {
  // A pending .gcudsk open (File → Open disk…) takes precedence — it stashed
  // its bytes and reloaded; boot it as a volatile memory workspace, exactly
  // like an embedded-HTML import (edits persist by re-exporting).
  const pendingDisk = await consumePendingDisk();
  if (pendingDisk) {
    const vfs = await _memoryWorkspaceVfs();
    await hydrateVfsFromDisk(vfs, pendingDisk, { root: '' });
    WKS.vfs = vfs;
    WKS.home = { kind: 'memory' };
    return;
  }

  // An exported workspace HTML embeds its VFS — open it as a volatile
  // snapshot (edits persist by re-exporting, or by adopting a disk folder).
  const imported = await detectWorkspaceBlock(document.body.innerHTML);
  if (imported) {
    const vfs = await _memoryWorkspaceVfs();
    await hydrateWorkspace(vfs, imported);
    WKS.vfs = vfs;
    WKS.home = { kind: 'memory' };
    return;
  }

  let home = null;   // { kind:'fsaa', handle } | { kind:'idb', name }

  // A saved disk-folder handle takes precedence — that folder *is* the
  // workspace.
  let handle = null;
  try { handle = await metaGet(HANDLE_KEY); } catch { /* no meta db yet */ }
  if (handle) {
    let perm = 'denied';
    try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch { /* */ }
    if (perm !== 'granted' && await _reconnectGate(handle)) perm = 'granted';
    if (perm === 'granted') home = { kind: 'fsaa', handle };
    else await metaSet(HANDLE_KEY, undefined).catch(() => {});   // dismissed
  }

  // Default: browser-resident (IndexedDB).
  if (!home) home = { kind: 'idb', name: 'auditable-works' };

  const homeBackend = home.kind === 'fsaa'
    ? { type: 'fsaa', handle: home.handle }
    : { type: 'idb', name: home.name };

  const vfs = await VFS.create({
    backends: {
      '/':        homeBackend,        // persistent — the storage home
      '/tmp':     { type: 'memory' }, // volatile — POSIX-shape scratch
      '/sys':     { type: 'memory' }, // volatile
      '/usr':     { type: 'memory' }, // volatile — shell builtins (/usr/lib)
    },
  });

  // Standard directories inside the storage home (idempotent — they persist
  // across reloads). /home/.works holds the shell's own state.
  for (const dir of ['/projects', '/lib', '/home', '/home/.works', '/mnt', '/usr/lib']) {
    try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  }

  WKS.vfs = vfs;
  WKS.home = home;   // the storage-home descriptor — 5c delegates from it
}

// ── Storage-home commands (the File menu) ────────────────────────────

// Pick a disk folder and adopt it as the workspace home. Reloads the shell
// so the new home is mounted cleanly, with no live VFS swap under surfaces.
export async function openWorkspaceFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'auditable-works', mode: 'readwrite' });
  } catch { return; }   // the user cancelled the picker
  await metaSet(HANDLE_KEY, handle);
  location.reload();
}

// Discard the current workspace and start fresh on a clean IndexedDB home.
export async function resetWorkspace() {
  await metaSet(HANDLE_KEY, undefined).catch(() => {});
  await clearSavedMounts().catch(() => {});
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('auditable-works');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.reload();
}
