// The file-tree explorer over the workspace VFS. Rooted at `/` — the whole
// filesystem is navigable: /projects is expanded by default (the user's
// work, front and centre), with /lib, /home, /scratch, /sys and any mounted
// folders collapsed but one click away. Projects are directories with a
// project.json marker; double-click opens a project or file as a surface;
// right-click is a context menu for new / rename / delete.

import { WKS, setStatus } from './state.js';
import { Menu } from '#menu';
import { prompt as dlgPrompt, confirm as dlgConfirm } from '#dialog';
import { kindDef } from './surface-registry.js';
import { openPath, spawnSurface } from './surfaces.js';
import { unmountAt } from './mount.js';
import { importFileAsNotebook } from './import.js';
import { exportProject } from './project-export.js';

const IMPORTABLE_RE = /\.(html?|txt)$/i;

const ROOT = '/';
// /projects open by default; the rest of the VFS is there, collapsed.
const expanded = new Set(['/', '/projects']);

let _treeEl = null;
let _refreshTimer = null;

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; };
const join = (dir, name) => (dir === '/' ? '/' : dir + '/') + name;
const sanitize = (s) => String(s).trim().replace(/[/\\]+/g, '-');
const rid = () => Math.random().toString(36).slice(2, 10);

// /lib entries are URL-encoded module names ('%40gcu%2Fadder' for the dir
// holding the @gcu/adder source — persist.js's syncModulesToVfs layout).
// Decode them for display so the tree shows the real module name.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function setupTree() {
  _treeEl = document.getElementById('works-tree');
  if (!_treeEl) return;

  // Workspace VFS changes → debounced refresh.
  const bump = () => {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(refreshTree, 80);
  };
  for (const ev of ['write', 'delete', 'rename', 'mkdir', 'mount', 'unmount']) {
    WKS.vfs.on(ev, bump);
  }

  // Right-click empty tree space → create in /projects (the natural home
  // for a new notebook).
  _treeEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return;   // a row handles its own
    e.preventDefault();
    showMenu(e, '/projects', 'folder');
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
  for (const n of nodes) renderNode(n, 0);
}

// Build the tree model under `dir`. A directory with a project.json is a
// project (a leaf — its insides are the surface's concern, not the tree's);
// any other directory is a folder. Lazy: only expanded folders are read, so
// /lib and mounted folders cost nothing until opened.
async function walk(dir) {
  const entries = await WKS.vfs.readdir(dir, { stat: true });
  const nodes = [];
  // Inside /lib and /usr/lib, names are URL-encoded module URLs (e.g.
  // %40gcu%2Fxterm for @gcu/xterm); show them decoded for the user.
  const decode = (dir === '/lib' || dir === '/usr/lib');
  for (const e of entries) {
    const p = join(dir, e.name);
    const label = decode ? safeDecode(e.name) : e.name;
    if (e.type === 'directory') {
      let meta = null;
      try {
        if (await WKS.vfs.exists(p + '/project.json')) {
          meta = JSON.parse(await WKS.vfs.readFile(p + '/project.json'));
        }
      } catch { /* unreadable marker → treat as a plain folder */ }
      if (meta) {
        nodes.push({ name: e.name, label, path: p, type: 'project',
          kind: meta.kind, title: meta.title || label });
      } else {
        nodes.push({ name: e.name, label, path: p, type: 'folder',
          children: expanded.has(p) ? await walk(p) : null });
      }
    } else {
      nodes.push({ name: e.name, label, path: p, type: 'file' });
    }
  }
  const rank = { folder: 0, project: 1, file: 2 };
  nodes.sort((a, b) => (rank[a.type] - rank[b.type])
    || (a.label || a.name).localeCompare(b.label || b.name));
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
    label = node.label || node.name;
  } else if (node.type === 'project') {
    icon = (kindDef(node.kind) || {}).icon || '■';
    label = node.title;
  } else {
    icon = '·';
    label = node.label || node.name;
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
  // A folder is created inside; for a project/file the target is its parent.
  const dir = type === 'folder' ? path : parentOf(path);
  const items = [
    { label: 'New notebook…', action: 'new-project' },
    { label: 'New folder…',   action: 'new-folder' },
    { label: 'New file…',     action: 'new-file' },
  ];

  // Path-specific actions — open / copy path / per-type extras.
  const extras = [];
  if (type === 'project') extras.push({ label: 'Open',                  action: 'open' });
  extras.push(                          { label: 'Copy path',           action: 'copy-path' });
  if (type === 'folder')  extras.push({ label: 'Open terminal here',    action: 'terminal-here' });
  if (type === 'folder')  extras.push({ label: 'Refresh',               action: 'refresh' });
  if (type === 'project') extras.push({ label: 'Duplicate…',            action: 'duplicate' });
  if (type === 'project') extras.push({ label: 'Export as notebook…',   action: 'export' });
  if (type === 'file' && IMPORTABLE_RE.test(basename(path)))
    extras.push(                        { label: 'Import as notebook',  action: 'import-file' });
  if (extras.length) items.push('---', ...extras);

  // Rename / Delete / Unmount — not for `/` or the top-level mount roots.
  // A /mnt/<name> entry is a disk-folder mount: its action is Unmount (which
  // leaves the disk content alone), not Delete (which would touch the disk).
  const isMountedFolder = parentOf(path) === '/mnt';
  if (path !== '/' && parentOf(path) !== '/') {
    items.push('---');
    if (isMountedFolder) {
      items.push({ label: 'Unmount', action: 'unmount' });
    } else {
      items.push({ label: 'Rename…', action: 'rename' });
      items.push({ label: 'Delete',  action: 'delete', danger: true });
    }
  }

  const action = await Menu.show(items, { x: e.clientX, y: e.clientY });
  if (action === 'open') openPath(path);
  else if (action === 'new-project') newProject(dir);
  else if (action === 'new-folder')  newFolder(dir);
  else if (action === 'new-file')    newFile(dir);
  else if (action === 'copy-path')   copyPath(path);
  else if (action === 'terminal-here') spawnSurface('terminal',
    { path, title: 'Terminal — ' + basename(path) });
  else if (action === 'refresh')     refreshTree();
  else if (action === 'duplicate')   duplicateProject(path);
  else if (action === 'export')      exportProject(path);
  else if (action === 'import-file') importFileAsNotebook(path);
  else if (action === 'rename')      renameEntry(path, type);
  else if (action === 'delete')      deleteEntry(path, type);
  else if (action === 'unmount')     unmountEntry(path);
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    setStatus('copied ' + path);
  } catch {
    setStatus('clipboard unavailable');
  }
}

// Right-click → Duplicate… on a project. Recursive VFS copy + fresh id +
// updated title in project.json. The duplicate lands next to the original
// at /projects/<title>-2 (-3, …) — auto-deduped against existing names.
export async function duplicateProject(srcPath, name) {
  if (!srcPath.startsWith('/projects/')) {
    setStatus('only /projects/* projects can be duplicated'); return null;
  }
  let title = basename(srcPath);
  try {
    const meta = JSON.parse(await WKS.vfs.readFile(srcPath + '/project.json', 'utf8'));
    if (meta.title) title = meta.title;
  } catch { /* no marker — use basename */ }
  const defaultName = title + ' copy';
  if (name == null) name = await dlgPrompt('Duplicate as:', defaultName);
  if (!name) return null;
  const dst = await uniqueProjectPath(name);
  try {
    await _copyDir(srcPath, dst);
    // Mint a fresh id and the new title in the copy's project.json.
    try {
      const meta = JSON.parse(await WKS.vfs.readFile(dst + '/project.json', 'utf8'));
      meta.id = 'p-' + rid();
      meta.title = name;
      await WKS.vfs.writeFile(dst + '/project.json', JSON.stringify(meta, null, 2));
    } catch {
      // No marker in source — write a minimal one for the copy.
      await WKS.vfs.writeFile(dst + '/project.json',
        JSON.stringify({ kind: 'notebook', id: 'p-' + rid(), title: name }, null, 2));
    }
    setStatus('duplicated to ' + dst);
    return dst;
  } catch (e) {
    setStatus('duplicate failed: ' + (e.message || e));
    return null;
  }
}

// A free /projects/<name> path — appends ' 2', ' 3', … on collision.
async function uniqueProjectPath(name) {
  const base = '/projects/' + sanitize(name);
  if (!(await WKS.vfs.exists(base))) return base;
  for (let n = 2; ; n++) {
    const p = base + ' ' + n;
    if (!(await WKS.vfs.exists(p))) return p;
  }
}

async function _copyDir(src, dst) {
  await WKS.vfs.mkdir(dst, { recursive: true });
  const entries = await WKS.vfs.readdir(src, { stat: true });
  for (const e of entries) {
    const s = src + '/' + e.name;
    const d = dst + '/' + e.name;
    if (e.type === 'directory') await _copyDir(s, d);
    else await WKS.vfs.writeFile(d, await WKS.vfs.readFile(s, 'bytes'));
  }
}

export async function newFile(dir, name) {
  if (name == null) name = await dlgPrompt('New file name:');
  if (!name) return null;
  const p = join(dir, sanitize(name));
  if (await WKS.vfs.exists(p)) {
    setStatus('already exists: ' + p);
    return null;
  }
  try {
    await WKS.vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await WKS.vfs.writeFile(p, '');
    expanded.add(dir);
    return p;
  } catch (e) {
    setStatus('create failed: ' + e.message);
    return null;
  }
}

async function unmountEntry(path) {
  const ok = await dlgConfirm(
    'Unmount "' + basename(path) + '"? The folder on disk will not be deleted.');
  if (!ok) return;
  await unmountAt(path);
}

// Create a project. Defaults to a notebook — the project kind a user
// actually creates. `name` may be passed to skip the prompt (programmatic
// use / tests); omitted, it is asked for.
export async function newProject(dir, name, kind = 'notebook') {
  if (name == null) name = await dlgPrompt('New notebook name:');
  if (!name) return null;
  const p = join(dir, sanitize(name));
  try {
    await WKS.vfs.mkdir(p, { recursive: true });
    await WKS.vfs.writeFile(p + '/project.json',
      JSON.stringify({ kind, id: 'p-' + rid(), title: name }, null, 2));
    if (kind === 'notebook') {
      // A starter notebook.txt (the /// form) — a title cell + an empty
      // code cell. The notebook surface reads this on open.
      await WKS.vfs.writeFile(p + '/notebook.txt',
        '/// auditable\n/// title: ' + name + '\n\n/// md\n# ' + name + '\n\n/// code\n');
    }
    expanded.add(dir);
    setStatus('created ' + name);
    return p;
  } catch (e) {
    setStatus('create failed: ' + e.message);
    return null;
  }
}

export async function newFolder(dir, name) {
  if (name == null) name = await dlgPrompt('New folder name:');
  if (!name) return null;
  const p = join(dir, sanitize(name));
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
    await WKS.vfs.rename(path, join(parentOf(path), sanitize(name)));
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
