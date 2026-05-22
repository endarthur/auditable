// The workspace VFS — the one filesystem the whole desktop shares.
//
// Three mounts (auditable-works-spec §7.2): one persistent backend at `/` —
// the storage home — inside which `projects/`, `lib/`, `home/` are ordinary
// directories; plus volatile MemoryBackend overlays at `/scratch` and `/sys`.
//
// The storage home is one of two kinds (§12.1): a **disk folder** (File
// System Access API) or **browser-resident** (IndexedDB). IndexedDB is the
// default; a disk folder is adopted via File → Open folder…, its handle
// saved so the workspace reconnects on reload.

import { VFS } from '#vfs';
import { WKS } from './state.js';

// ── Shell metadata store ─────────────────────────────────────────────
// A tiny IndexedDB keyval, separate from the workspace itself, holding the
// saved workspace-folder handle. (FileSystemHandle objects are structured-
// cloneable, so IndexedDB can store them.)

const META_DB = 'auditable-works-meta';
const HANDLE_KEY = 'workspace-handle';

function _metaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _metaGet(key) {
  const db = await _metaDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _metaSet(key, value) {
  const db = await _metaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

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

export async function setupWorkspace() {
  let home = null;   // { kind:'fsaa', handle } | { kind:'idb', name }

  // A saved disk-folder handle takes precedence — that folder *is* the
  // workspace.
  let handle = null;
  try { handle = await _metaGet(HANDLE_KEY); } catch { /* no meta db yet */ }
  if (handle) {
    let perm = 'denied';
    try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch { /* */ }
    if (perm !== 'granted' && await _reconnectGate(handle)) perm = 'granted';
    if (perm === 'granted') home = { kind: 'fsaa', handle };
    else await _metaSet(HANDLE_KEY, undefined).catch(() => {});   // dismissed
  }

  // Default: browser-resident (IndexedDB).
  if (!home) home = { kind: 'idb', name: 'auditable-works' };

  const homeBackend = home.kind === 'fsaa'
    ? { type: 'fsaa', handle: home.handle }
    : { type: 'idb', name: home.name };

  const vfs = await VFS.create({
    backends: {
      '/':        homeBackend,        // persistent — the storage home
      '/scratch': { type: 'memory' }, // volatile
      '/sys':     { type: 'memory' }, // volatile
    },
  });

  // Standard directories inside the storage home (idempotent — they persist
  // across reloads). /home/.works holds the shell's own state.
  for (const dir of ['/projects', '/lib', '/home', '/home/.works']) {
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
  await _metaSet(HANDLE_KEY, handle);
  location.reload();
}

// Discard the current workspace and start fresh on a clean IndexedDB home.
export async function resetWorkspace() {
  await _metaSet(HANDLE_KEY, undefined).catch(() => {});
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('auditable-works');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.reload();
}
