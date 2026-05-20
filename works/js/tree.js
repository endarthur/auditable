// The file-tree explorer over /projects/. Renders projects (directories
// with a project.json marker), organizing folders, and loose files.
// Double-click opens a project/file as a surface; right-click is a context
// menu for new / rename / delete.

import { WKS, setStatus } from './state.js';
import { Menu } from '#menu';
import { prompt as dlgPrompt, confirm as dlgConfirm } from '#dialog';
import { kindDef } from './surface-registry.js';
import { openPath } from './surfaces.js';

const ROOT = '/projects';
const expanded = new Set([ROOT]);

let _treeEl = null;
let _refreshTimer = null;

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ROOT; };
const sanitize = (s) => String(s).trim().replace(/[/\\]+/g, '-');
const rid = () => Math.random().toString(36).slice(2, 10);

export function setupTree() {
  _treeEl = document.getElementById('works-tree');
  if (!_treeEl) return;

  // Workspace VFS changes → debounced refresh.
  const bump = () => {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(refreshTree, 80);
  };
  for (const ev of ['write', 'delete', 'rename', 'mkdir']) WKS.vfs.on(ev, bump);

  // Right-click on empty tree space → create at the root.
  _treeEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return;   // a row handles its own
    e.preventDefault();
    showMenu(e, ROOT, 'folder');
  });

  refreshTree();
}

export async function refreshTree() {
  if (!_treeEl) return;
  let nodes;
  try {
    nodes = await walk(ROOT);
  } catch (e) {
    _treeEl.innerHTML = '<div class="works-tree-empty">tree error: ' + e.message + '</div>';
    return;
  }
  _treeEl.textContent = '';
  if (!nodes.length) {
    _treeEl.innerHTML = '<div class="works-tree-empty">No projects yet.</div>';
    return;
  }
  for (const n of nodes) renderNode(n, 0);
}

// Build the tree model under `dir`. A directory with a project.json is a
// project (a leaf — its insides are the surface's concern, not the tree's);
// any other directory is an organizing folder we recurse into.
async function walk(dir) {
  const entries = await WKS.vfs.readdir(dir, { stat: true });
  const nodes = [];
  for (const e of entries) {
    const p = dir + '/' + e.name;
    if (e.type === 'directory') {
      let meta = null;
      try {
        if (await WKS.vfs.exists(p + '/project.json')) {
          meta = JSON.parse(await WKS.vfs.readFile(p + '/project.json'));
        }
      } catch { /* unreadable marker → treat as a plain folder */ }
      if (meta) {
        nodes.push({ name: e.name, path: p, type: 'project',
          kind: meta.kind, title: meta.title || e.name });
      } else {
        nodes.push({ name: e.name, path: p, type: 'folder',
          children: expanded.has(p) ? await walk(p) : null });
      }
    } else {
      nodes.push({ name: e.name, path: p, type: 'file' });
    }
  }
  const rank = { folder: 0, project: 1, file: 2 };
  nodes.sort((a, b) => (rank[a.type] - rank[b.type]) || a.name.localeCompare(b.name));
  return nodes;
}

function renderNode(node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-' + node.type;
  row.dataset.path = node.path;
  row.style.paddingLeft = (6 + depth * 14) + 'px';

  let icon, label;
  if (node.type === 'folder') {
    icon = expanded.has(node.path) ? '▾' : '▸';
    label = node.name;
  } else if (node.type === 'project') {
    icon = (kindDef(node.kind) || {}).icon || '■';
    label = node.title;
  } else {
    icon = '·';
    label = node.name;
  }

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  iconEl.textContent = icon;
  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = label;
  row.append(iconEl, labelEl);
  _treeEl.appendChild(row);

  if (node.type === 'folder') {
    row.addEventListener('click', () => {
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      refreshTree();
    });
  } else {
    row.addEventListener('dblclick', () => openPath(node.path));
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e, node.path, node.type);
  });

  if (node.type === 'folder' && node.children) {
    for (const c of node.children) renderNode(c, depth + 1);
  }
}

async function showMenu(e, path, type) {
  // A folder (or the root) can be created inside; for a project/file the
  // target is its parent directory.
  const dir = type === 'folder' ? path : parentOf(path);
  const items = [
    { label: 'New project…', action: 'new-project' },
    { label: 'New folder…', action: 'new-folder' },
  ];
  if (path !== ROOT) {
    items.push('---');
    if (type === 'project') items.push({ label: 'Open', action: 'open' });
    items.push({ label: 'Rename…', action: 'rename' });
    items.push({ label: 'Delete', action: 'delete', danger: true });
  }
  const action = await Menu.show(items, { x: e.clientX, y: e.clientY });
  if (action === 'open') openPath(path);
  else if (action === 'new-project') newProject(dir);
  else if (action === 'new-folder') newFolder(dir);
  else if (action === 'rename') renameEntry(path, type);
  else if (action === 'delete') deleteEntry(path, type);
}

// Create a project. `name` may be passed to skip the prompt (programmatic
// use / tests); omitted, it is asked for.
export async function newProject(dir, name) {
  if (name == null) name = await dlgPrompt('New project name:');
  if (!name) return null;
  const p = dir + '/' + sanitize(name);
  try {
    await WKS.vfs.mkdir(p, { recursive: true });
    await WKS.vfs.writeFile(p + '/project.json',
      JSON.stringify({ kind: 'stub', id: 'p-' + rid(), title: name }, null, 2));
    expanded.add(dir);
    setStatus('created project ' + name);
    return p;
  } catch (e) {
    setStatus('create failed: ' + e.message);
    return null;
  }
}

export async function newFolder(dir, name) {
  if (name == null) name = await dlgPrompt('New folder name:');
  if (!name) return null;
  const p = dir + '/' + sanitize(name);
  try {
    await WKS.vfs.mkdir(p, { recursive: true });
    expanded.add(dir);
    return p;
  } catch (e) {
    setStatus('create failed: ' + e.message);
    return null;
  }
}

async function renameEntry(path) {
  const name = await dlgPrompt('Rename to:');
  if (!name) return;
  try {
    await WKS.vfs.rename(path, parentOf(path) + '/' + sanitize(name));
  } catch (e) {
    setStatus('rename failed: ' + e.message);
  }
}

async function deleteEntry(path) {
  const ok = await dlgConfirm('Delete "' + basename(path) + '"?', { danger: true });
  if (!ok) return;
  try {
    await WKS.vfs.rm(path, { recursive: true });
  } catch (e) {
    setStatus('delete failed: ' + e.message);
  }
}
