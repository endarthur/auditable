import { AFS, $ } from './state.js';
import { walkRoot, readEntry } from './fs.js';
import { openTab, setStatus } from './tabs.js';
import { saveWorkspaceState } from './persist.js';
import { extractNotebook, toTxt, parseTxt, hydrateNotebook } from './notebook.js';

// ── FILE TREE ──

async function renderTree() {
  const container = $('#af-tree');
  if (!container) return;
  container.innerHTML = '';

  for (let ri = 0; ri < AFS.roots.length; ri++) {
    const root = AFS.roots[ri];
    const entries = await walkRoot(ri);
    const rootKey = 'r' + ri;
    const rootEl = document.createElement('details');
    rootEl.className = 'tree-root';
    rootEl.open = AFS.treeOpen[rootKey] !== false; // default open
    rootEl.dataset.rootIndex = ri;
    rootEl.addEventListener('toggle', () => {
      AFS.treeOpen[rootKey] = rootEl.open;
      saveWorkspaceState();
    });

    const summary = document.createElement('summary');
    summary.className = 'tree-root-label';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = root.name;
    summary.appendChild(nameSpan);
    const typeSpan = document.createElement('span');
    typeSpan.className = 'tree-root-type';
    typeSpan.textContent = root.type === 'fsaa' ? 'folder' : 'box';
    summary.appendChild(typeSpan);
    summary.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showRootContextMenu(e, ri);
    });
    rootEl.appendChild(summary);

    renderEntries(rootEl, entries, ri);
    container.appendChild(rootEl);
  }

  if (AFS.roots.length === 0) {
    container.innerHTML = '<div class="tree-empty">no workspaces open</div>';
  }
}

function renderEntries(parent, entries, rootIndex) {
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      const dirKey = 'r' + rootIndex + ':' + entry.path;
      const details = document.createElement('details');
      details.className = 'tree-dir';
      details.open = !!AFS.treeOpen[dirKey]; // default closed
      details.addEventListener('toggle', () => {
        AFS.treeOpen[dirKey] = details.open;
        saveWorkspaceState();
      });
      const summary = document.createElement('summary');
      summary.className = 'tree-dir-label';
      summary.textContent = entry.name;
      summary.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showEntryContextMenu(e, rootIndex, entry, true);
      });
      details.appendChild(summary);
      renderEntries(details, entry.children, rootIndex);
      parent.appendChild(details);
    } else {
      const isNotebook = entry.name.endsWith('.html') || entry.name.endsWith('.txt');
      const div = document.createElement('div');
      div.className = 'tree-file';
      if (entry.name.endsWith('.html')) div.classList.add('tree-file-html');
      if (entry.name.endsWith('.txt')) div.classList.add('tree-file-txt');
      div.textContent = entry.name;
      div.dataset.path = entry.path;
      div.dataset.rootIndex = rootIndex;
      div.addEventListener('click', () => {
        if (isNotebook) {
          openTab(rootIndex, entry.path, entry.name, { preview: true });
        }
      });
      div.addEventListener('dblclick', () => {
        if (isNotebook) {
          openTab(rootIndex, entry.path, entry.name, { permanent: true });
        }
      });
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showEntryContextMenu(e, rootIndex, entry, false);
      });
      parent.appendChild(div);
    }
  }
}

// ── CONTEXT MENUS ──

function closeContextMenu() {
  if (AFS.contextMenu) {
    AFS.contextMenu.remove();
    AFS.contextMenu = null;
  }
}

function createContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'af-context-menu';
  for (const item of items) {
    if (item === '---') {
      const sep = document.createElement('div');
      sep.className = 'af-ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', () => { closeContextMenu(); item.action(); });
    menu.appendChild(btn);
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  AFS.contextMenu = menu;

  // close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function showRootContextMenu(e, rootIndex) {
  const root = AFS.roots[rootIndex];
  const items = [];

  items.push({
    label: 'new notebook',
    action: () => promptNewNotebook(rootIndex, ''),
  });

  if (root.type === 'box') {
    items.push({
      label: 'rename box',
      action: () => promptRenameBox(rootIndex),
    });
    items.push({
      label: 'export box',
      action: () => exportBox(rootIndex),
    });
  }

  items.push('---');
  items.push({
    label: 'remove workspace',
    action: () => removeRoot(rootIndex),
  });

  createContextMenu(e.clientX, e.clientY, items);
}

function showEntryContextMenu(e, rootIndex, entry, isDir) {
  const items = [];

  if (isDir) {
    items.push({
      label: 'new notebook',
      action: () => promptNewNotebook(rootIndex, entry.path),
    });
  }

  const isNotebook = !isDir && (entry.name.endsWith('.html') || entry.name.endsWith('.txt'));

  if (isNotebook) {
    items.push({
      label: 'open',
      action: () => openTab(rootIndex, entry.path, entry.name, { permanent: true }),
    });
  }

  if (!isDir && entry.name.endsWith('.html')) {
    items.push({
      label: 'export as .txt',
      action: () => exportEntryAsTxt(rootIndex, entry),
    });
  }

  if (!isDir && entry.name.endsWith('.txt')) {
    items.push({
      label: 'export as .html',
      action: () => exportEntryAsHtml(rootIndex, entry),
    });
  }

  items.push({
    label: 'rename',
    action: () => promptRename(rootIndex, entry),
  });

  items.push({
    label: 'delete',
    action: () => promptDelete(rootIndex, entry),
  });

  createContextMenu(e.clientX, e.clientY, items);
}

// ── ACTIONS (context menu) ──

async function promptNewNotebook(rootIndex, parentPath) {
  const name = prompt('notebook name:', 'untitled.html');
  if (!name) return;
  const finalName = (name.endsWith('.html') || name.endsWith('.txt')) ? name : name + '.html';
  const root = AFS.roots[rootIndex];
  let content;
  if (finalName.endsWith('.txt')) {
    content = '/// auditable\n/// title: ' + finalName.replace(/\.txt$/, '') + '\n';
  } else if (root && root.type === 'box') {
    // lightweight format for Box storage
    content = JSON.stringify({
      format: 'auditable-notebook',
      v: 1,
      title: finalName.replace(/\.html$/, ''),
      cells: [],
      settings: { theme: 'dark', fontSize: 13, width: '860' },
    });
  } else {
    content = __AUDITABLE_RUNTIME__;
  }
  await createEntry(rootIndex, parentPath, finalName, content);
  await renderTree();
  openTab(rootIndex, parentPath ? parentPath + '/' + finalName : finalName, finalName, { permanent: true });
}

async function promptRenameBox(rootIndex) {
  const root = AFS.roots[rootIndex];
  if (root.type !== 'box') return;
  const newName = prompt('rename box:', root.name);
  if (!newName || newName === root.name) return;
  root.name = newName;
  const box = await boxGet(root.boxId);
  if (box) { box.name = newName; await boxSave(box); }
  await renderTree();
  saveWorkspaceState();
}

async function promptRename(rootIndex, entry) {
  const root = AFS.roots[rootIndex];
  const newName = prompt('rename:', entry.name);
  if (!newName || newName === entry.name) return;

  if (root.type === 'box') {
    const oldPath = entry.path;
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    await boxRename(root.boxId, oldPath, newPath);

    // update any open tabs
    for (const tab of AFS.tabs) {
      if (tab.rootIndex === rootIndex && (tab.path === oldPath || tab.path.startsWith(oldPath + '/'))) {
        tab.path = newPath + tab.path.slice(oldPath.length);
        tab.title = newName;
      }
    }
    renderTabBar();
  } else if (root.type === 'fsaa') {
    // FSAA rename: copy + delete (no native rename)
    try {
      const parts = entry.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      const dirHandle = await fsaaResolveDir(root.dirHandle, parentPath);
      if (entry.kind === 'file') {
        const content = await readEntry(rootIndex, entry.path);
        await fsaaCreate(dirHandle, newName, content);
        await fsaaDelete(dirHandle, entry.name);
      }
    } catch (err) {
      console.error('rename failed:', err);
    }
  }
  await renderTree();
}

async function promptDelete(rootIndex, entry) {
  if (!confirm('delete ' + entry.name + '?')) return;

  // close any open tabs for this file
  const tabsToClose = AFS.tabs.filter(t =>
    t.rootIndex === rootIndex && (t.path === entry.path || t.path.startsWith(entry.path + '/'))
  );
  for (const tab of tabsToClose) closeTab(tab.id);

  await deleteEntry(rootIndex, entry.path);
  await renderTree();
}

async function exportBox(rootIndex) {
  const root = AFS.roots[rootIndex];
  if (root.type !== 'box') return;
  const html = await boxExport(root.boxId);
  if (!html) return;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = root.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '_box.html';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('exported ' + root.name);
}

async function exportEntryAsTxt(rootIndex, entry) {
  try {
    const content = await readEntry(rootIndex, entry.path);
    if (!content) return;
    const notebook = extractNotebook(content);
    if (!notebook) { setStatus('cannot export packed notebook'); return; }
    const txt = toTxt(notebook);
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name.replace(/\.html$/, '.txt');
    a.click();
    URL.revokeObjectURL(url);
    setStatus('exported ' + a.download);
  } catch (err) {
    console.error('export as .txt failed:', err);
    setStatus('export failed: ' + err.message);
  }
}

async function exportEntryAsHtml(rootIndex, entry) {
  try {
    const content = await readEntry(rootIndex, entry.path);
    if (!content) return;
    const notebook = parseTxt(content);
    const html = await hydrateNotebook(notebook);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name.replace(/\.txt$/, '.html');
    a.click();
    URL.revokeObjectURL(url);
    setStatus('exported ' + a.download);
  } catch (err) {
    console.error('export as .html failed:', err);
    setStatus('export failed: ' + err.message);
  }
}

function removeRoot(rootIndex) {
  // close tabs belonging to this root
  const tabsToClose = AFS.tabs.filter(t => t.rootIndex === rootIndex);
  for (const tab of tabsToClose) closeTab(tab.id);

  AFS.roots.splice(rootIndex, 1);

  // fix rootIndex in remaining tabs
  for (const tab of AFS.tabs) {
    if (tab.rootIndex > rootIndex) tab.rootIndex--;
  }

  renderTree();
  saveWorkspaceState();
}
