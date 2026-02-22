import { AFS } from './state.js';
import { openDB, dbGet, dbPut } from './fs.js';

// ── PERSISTENCE ──
// Stores workspace state in IndexedDB 'state' store

let _saveTimer = null;

async function saveWorkspaceState() {
  // debounce: only the last call within 200ms actually writes
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 200);
}

async function _flushSave() {
  try {
    await openDB();
    const state = {
      roots: AFS.roots.map(r => {
        if (r.type === 'fsaa') return { type: 'fsaa', name: r.name, dirHandle: r.dirHandle };
        return { type: 'box', name: r.name, boxId: r.boxId };
      }),
      tabs: AFS.tabs.map(t => ({
        rootIndex: t.rootIndex,
        path: t.path,
        title: t.title,
        preview: t.preview || undefined,
      })),
      activeTabIndex: AFS.tabs.findIndex(t => t.id === AFS.activeTabId),
      sidebarWidth: AFS.sidebarWidth,
      treeOpen: AFS.treeOpen,
    };
    await dbPut('state', state, 'workspace');
  } catch (err) {
    console.error('failed to save workspace state:', err);
  }
}

async function loadWorkspaceState() {
  try {
    await openDB();
    const state = await dbGet('state', 'workspace');
    if (!state) return null;
    return state;
  } catch (err) {
    console.error('failed to load workspace state:', err);
    return null;
  }
}

async function restoreRoots(savedRoots) {
  const restored = [];
  for (const sr of savedRoots) {
    if (sr.type === 'box') {
      restored.push({ type: 'box', name: sr.name, boxId: sr.boxId });
    } else if (sr.type === 'fsaa' && sr.dirHandle) {
      // try to re-request permission
      try {
        const perm = await sr.dirHandle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          restored.push({ type: 'fsaa', name: sr.name, dirHandle: sr.dirHandle });
        } else {
          const req = await sr.dirHandle.requestPermission({ mode: 'readwrite' });
          if (req === 'granted') {
            restored.push({ type: 'fsaa', name: sr.name, dirHandle: sr.dirHandle });
          }
          // if denied, silently skip
        }
      } catch {
        // permission request failed (user gesture required)
        // store it so user can re-grant later
        restored.push({
          type: 'fsaa', name: sr.name, dirHandle: sr.dirHandle,
          needsPermission: true,
        });
      }
    }
  }
  return restored;
}
