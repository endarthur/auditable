import { AFS, $ } from './state.js';
import { openDB, fsaaOpen, boxCreate, boxImport, extractBoxData, walkRoot } from './fs.js';
import { renderTree, closeContextMenu } from './tree.js';
import { openTab, switchTab, renderTabBar, showEmptyState, hideEmptyState, setStatus, closeTab } from './tabs.js';
import { initBridge, saveActiveTab } from './bridge.js';
import { saveWorkspaceState, loadWorkspaceState, restoreRoots } from './persist.js';

// ── INIT ──

(async function init() {
  // wire UI first — before any async work, so buttons respond even if DB fails (e.g. file://)
  initBridge();

  const addFolderBtn = $('#af-add-folder');
  const addBoxBtn = $('#af-add-box');
  const saveBtn = $('#af-save');
  const importBtn = $('#af-import');

  if (addFolderBtn) {
    if (AFS.hasFSAA) {
      addFolderBtn.addEventListener('click', addFolder);
    } else {
      addFolderBtn.style.display = 'none';
    }
  }

  if (addBoxBtn) addBoxBtn.addEventListener('click', addBox);
  if (saveBtn) saveBtn.addEventListener('click', () => saveActiveTab());
  if (importBtn) importBtn.addEventListener('click', importBoxFromFile);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveActiveTab();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  initResize();

  // async DB + state restoration — may fail on file:// protocol
  try {
    await openDB();
  } catch (err) {
    console.warn('IndexedDB unavailable:', err.message || err);
    showEmptyState();
    return;
  }

  // check for embedded box data (import flow)
  const raw = document.body.innerHTML;
  const embeddedBox = extractBoxData(raw);

  // restore saved state or handle embedded box
  if (embeddedBox) {
    const box = await boxImport(document.documentElement.outerHTML);
    if (box) {
      AFS.roots.push({ type: 'box', name: box.name, boxId: box.id });
      await renderTree();
      setStatus('imported box: ' + box.name);
    }
  } else {
    const saved = await loadWorkspaceState();
    if (saved) {
      AFS.roots = await restoreRoots(saved.roots);
      AFS.sidebarWidth = saved.sidebarWidth || 240;
      AFS.treeOpen = saved.treeOpen || {};
      applySidebarWidth();

      await renderTree();

      // re-open saved tabs silently (no switch, no save)
      if (saved.tabs) {
        for (const st of saved.tabs) {
          if (st.rootIndex < AFS.roots.length) {
            const root = AFS.roots[st.rootIndex];
            if (!root.needsPermission) {
              await openTab(st.rootIndex, st.path, st.title, { silent: true, preview: st.preview });
            }
          }
        }
        // restore active tab (or fall back to first)
        const activeIdx = saved.activeTabIndex >= 0 && saved.activeTabIndex < AFS.tabs.length
          ? saved.activeTabIndex : 0;
        if (AFS.tabs.length > 0) {
          switchTab(AFS.tabs[activeIdx].id);
        }
      }

      // show roots that need re-permission
      const needPerm = AFS.roots.filter(r => r.needsPermission);
      if (needPerm.length > 0) {
        setStatus(needPerm.length + ' folder(s) need permission \u2014 click to re-grant');
      }
    }
  }

  // show empty state if nothing loaded
  if (AFS.tabs.length === 0) showEmptyState();

  // handle beforeunload for dirty tabs
  window.addEventListener('beforeunload', (e) => {
    if (AFS.tabs.some(t => t.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();

// ── TOOLBAR ACTIONS ──

async function addFolder() {
  try {
    const root = await fsaaOpen();
    AFS.roots.push(root);
    hideEmptyState();
    await renderTree();
    saveWorkspaceState();
    setStatus('opened ' + root.name);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('open folder:', err);
  }
}

async function addBox() {
  const name = prompt('box name:', 'scratch');
  if (!name) return;
  const box = await boxCreate(name);
  AFS.roots.push({ type: 'box', name, boxId: box.id });
  hideEmptyState();
  await renderTree();
  saveWorkspaceState();
  setStatus('created box: ' + name);
}

async function importBoxFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const html = await file.text();
    const box = await boxImport(html);
    if (box) {
      AFS.roots.push({ type: 'box', name: box.name, boxId: box.id });
      hideEmptyState();
      await renderTree();
      saveWorkspaceState();
      setStatus('imported box: ' + box.name);
    } else {
      setStatus('no box data found in file');
    }
  });
  input.click();
}

// ── SIDEBAR RESIZE ──

function initResize() {
  const handle = $('#af-resize');
  if (!handle) return;

  let startX, startW;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = AFS.sidebarWidth;
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  function onResize(e) {
    const delta = e.clientX - startX;
    AFS.sidebarWidth = Math.max(120, Math.min(600, startW + delta));
    applySidebarWidth();
  }

  function onResizeEnd() {
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', onResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveWorkspaceState();
  }
}

function applySidebarWidth() {
  document.documentElement.style.setProperty('--sidebar-w', AFS.sidebarWidth + 'px');
}

// ── RE-GRANT FSAA PERMISSIONS ──

async function regrantPermission(rootIndex) {
  const root = AFS.roots[rootIndex];
  if (!root || root.type !== 'fsaa' || !root.needsPermission) return;
  try {
    const perm = await root.dirHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      delete root.needsPermission;
      await renderTree();
      saveWorkspaceState();
      setStatus('permission granted for ' + root.name);
    }
  } catch (err) {
    console.error('permission request failed:', err);
  }
}
