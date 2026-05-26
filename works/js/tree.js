// The file-tree explorer over the workspace VFS. Rooted at `/` — the whole
// filesystem is navigable: /projects is expanded by default (the user's
// work, front and centre), with /lib, /home, /tmp, /sys and any mounted
// folders collapsed but one click away. Projects are directories with a
// project.json marker; double-click opens a project or file as a surface;
// right-click is a context menu for new / rename / delete.

import { WKS, setStatus } from './state.js';
import { Menu } from '#menu';
import { prompt as dlgPrompt, confirm as dlgConfirm } from '#dialog';
import { kindDef, kindForExtension } from './surface-registry.js';
import { openPath, spawnSurface } from './surfaces.js';
import { itemsForNode as extMenuItemsForNode, dispatch as extMenuDispatch } from './context-menu-registry.js';
import { prompt as dlgPrompt2, alert as dlgAlert2, confirm as dlgConfirm2 } from '#dialog';

// ctx handed to a contributed contextMenu action. Curated surface per
// EXTENSION_SPEC §3.8.2. Built fresh per dispatch (cheap) so a re-mounted
// VFS or a refreshed bus reach the next action without staleness.
function _buildExtCtx(path) {
  return {
    bus:    WKS.bus || WKS.worksBus || null,
    dialog: { alert: dlgAlert2, prompt: dlgPrompt2, confirm: dlgConfirm2 },
    vfs:    WKS.vfs || null,
    spawnSurface,
    openPath,
    setStatus,
    async peek(n) {
      if (n <= 0 || !WKS.vfs) return new Uint8Array(0);
      try {
        const raw = await WKS.vfs.readFile(path);
        if (!(raw instanceof Uint8Array)) return new Uint8Array(0);
        const cap = Math.min(n, 1 << 20);
        return raw.subarray(0, Math.min(cap, raw.length));
      } catch { return new Uint8Array(0); }
    },
  };
}
import { unmountAt } from './mount.js';
import { importFileAsNotebook } from './import.js';
import { exportProject, exportProjectAsIpynb } from './project-export.js';
import {
  moveToPrompt, copyToPrompt, attachTreeRowDnd, downloadFile,
  downloadFolder, extractArchiveHere, extractArchiveToPrompt, compressFolderTo,
  ARCHIVE_EXT_RE,
} from './file-ops.js';

const IMPORTABLE_RE = /\.(html?|txt|ipynb)$/i;

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
// project (rendered with its kind icon + title — but ALSO expandable like
// a folder so the user can peek at /attachments, generated XJNL, etc.);
// any other directory is a folder. Lazy: only expanded folders/projects
// are read, so /lib and mounted folders cost nothing until opened.
async function walk(dir) {
  const entries = await WKS.vfs.readdir(dir, { stat: true });
  const nodes = [];
  // Legacy: pre-pkg-spec /lib used flat URL-encoded names (%40gcu%2Fxterm
  // for @gcu/xterm). New layout is sub-namespaced (@gcu/xterm is a real
  // directory tree), so this only matters for not-yet-resaved notebooks.
  const decode = (dir === '/lib' || dir === '/usr/lib');
  for (const e of entries) {
    const p = join(dir, e.name);
    const label = decode && e.name.includes('%') ? safeDecode(e.name) : e.name;
    if (e.type === 'directory') {
      let meta = null;
      try {
        if (await WKS.vfs.exists(p + '/project.json')) {
          meta = JSON.parse(await WKS.vfs.readFile(p + '/project.json'));
        }
      } catch { /* unreadable marker → treat as a plain folder */ }
      if (meta) {
        nodes.push({ name: e.name, label, path: p, type: 'project',
          kind: meta.kind, title: meta.title || label,
          children: expanded.has(p) ? await walk(p) : null });
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

  const isExpandable = (node.type === 'folder' || node.type === 'project');
  const isOpen = isExpandable && expanded.has(node.path);

  // Chevron column — present on every row so labels stay vertically aligned.
  // Folders use the chevron as their primary icon; projects render the
  // chevron as a small affordance ahead of their kind icon (clicking the
  // chevron toggles expansion, clicking elsewhere opens the project);
  // files leave it as a non-interactive spacer.
  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  if (isExpandable) chevron.textContent = isOpen ? '▾' : '▸';
  else              chevron.textContent = ' ';

  let icon, label;
  if (node.type === 'folder') {
    // Hollow square — reads as "container". The chevron column beside
    // it carries the open/closed affordance. The icon column stays
    // reserved (whether glyph or blank) so labels align with file rows
    // at the same depth.
    icon = '□';
    label = node.label || node.name;
  } else if (node.type === 'project') {
    icon = (kindDef(node.kind) || {}).icon || '■';
    label = node.title;
  } else {
    // Files: prefer the icon of the surface kind that would open this
    // file (so .xjnl shows carotte's viewer icon, .parquet would show
    // the data-grid icon, .txt → text-surface icon, etc.). Falls back
    // to `·` for files no registered surface claims. Synchronous —
    // detect callbacks (async, content-based) are NOT consulted here.
    const base = node.label || node.name;
    const matchedKind = kindForExtension(base);
    icon = matchedKind ? ((kindDef(matchedKind) || {}).icon || '·') : '·';
    label = base;
  }

  row.appendChild(chevron);
  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  iconEl.textContent = icon;
  row.appendChild(iconEl);
  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);
  _treeEl.appendChild(row);

  const toggle = () => {
    if (expanded.has(node.path)) expanded.delete(node.path);
    else expanded.add(node.path);
    refreshTree();
  };

  if (node.type === 'folder') {
    // Folder: whole row toggles, no dblclick (folders don't open).
    row.addEventListener('click', toggle);
  } else if (node.type === 'project') {
    // Project: chevron toggles (stop propagation so the row click doesn't
    // also fire); the rest of the row opens on double-click.
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    row.addEventListener('dblclick', () => openPath(node.path));
  } else {
    row.addEventListener('dblclick', () => openPath(node.path));
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e, node.path, node.type);
  });
  // Drag-to-move: draggable source on every row, drop target on folders.
  // Ctrl+drop copies; plain drop moves.
  attachTreeRowDnd(row, node);

  if (isExpandable && node.children) {
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
  // Loose files with a registered surface kind get an explicit Open item too —
  // discoverable for users who don't know double-click opens them. LICENSE,
  // README, NOTICE etc. fall through kindForExtension's extensionlessNames
  // fallback so they land in the text surface.
  if (type === 'file' && kindForExtension(basename(path)))
    extras.push({ label: 'Open',                                        action: 'open' });
  extras.push(                          { label: 'Copy path',           action: 'copy-path' });
  if (type === 'folder')  extras.push({ label: 'Open terminal here',    action: 'terminal-here' });
  if (type === 'folder')  extras.push({ label: 'Refresh',               action: 'refresh' });
  if (type === 'project') extras.push({ label: 'Duplicate…',            action: 'duplicate' });
  if (type === 'project') extras.push({ label: 'Export as notebook…',   action: 'export' });
  if (type === 'project') extras.push({ label: 'Export as .ipynb',      action: 'export-ipynb' });
  if (type === 'file' && IMPORTABLE_RE.test(basename(path)))
    extras.push(                        { label: 'Import as notebook',  action: 'import-file' });
  // Archive ops — Extract here / Extract to… surface for any file whose
  // extension looks like a recognized archive format. The actual format
  // detection happens inside @gcu/archive when the action runs; this regex
  // just gates menu population. Magic-byte mismatch (e.g. someone renamed
  // a non-archive .zip) surfaces as a clear error at extract time.
  if (type === 'file' && ARCHIVE_EXT_RE.test(basename(path))) {
    extras.push({ label: 'Extract here',                                action: 'extract-here' });
    extras.push({ label: 'Extract to…',                            action: 'extract-to' });
  }
  // Compress / Download — applies to folders and to single files. For
  // folders we zip-on-the-fly; for files we stream the bytes through the
  // browser save dialog as-is.
  if (type === 'folder' || type === 'project') {
    extras.push({ label: 'Compress as .zip',                            action: 'compress-zip' });
    extras.push({ label: 'Compress as .tar.gz',                         action: 'compress-tgz' });
    extras.push({ label: 'Download',                                    action: 'download-folder' });
  } else if (type === 'file') {
    extras.push(                        { label: 'Download',            action: 'download' });
  }
  if (extras.length) items.push('---', ...extras);

  // Extension-contributed context-menu items (EXTENSION_SPEC §3.8.2).
  // Inserted as their own section so they're visually separated from
  // built-ins. Each item is keyed `_extmenu:<i>` or `_openin:<kind>`
  // so the dispatch lookup below stays uncoupled from labels.
  const extItems = extMenuItemsForNode(path, type);
  if (extItems.length) {
    items.push('---');
    for (const ei of extItems) items.push({ label: ei.label, action: ei.key });
  }

  // Rename / Move / Copy / Delete / Unmount — not for `/` or the
  // top-level mount roots. A /mnt/<name> entry is a disk-folder mount:
  // its action is Unmount (which leaves the disk content alone), not
  // Delete (which would touch the disk).
  const isMountedFolder = parentOf(path) === '/mnt';
  if (path !== '/' && parentOf(path) !== '/') {
    items.push('---');
    if (isMountedFolder) {
      items.push({ label: 'Unmount', action: 'unmount' });
    } else {
      items.push({ label: 'Rename…', action: 'rename' });
      items.push({ label: 'Move to…', action: 'move-to' });
      items.push({ label: 'Copy to…', action: 'copy-to' });
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
  else if (action === 'export-ipynb') exportProjectAsIpynb(path);
  else if (action === 'import-file') importFileAsNotebook(path);
  else if (action === 'download')    downloadFile(path);
  else if (action === 'download-folder') downloadFolder(path);
  else if (action === 'extract-here') {
    const dest = await extractArchiveHere(path);
    if (dest) { await refreshTree(); }
  }
  else if (action === 'extract-to') {
    const dest = await extractArchiveToPrompt(path);
    if (dest) { await refreshTree(); }
  }
  else if (action === 'compress-zip') {
    const dest = await compressFolderTo(path, 'zip');
    if (dest) { await refreshTree(); }
  }
  else if (action === 'compress-tgz') {
    const dest = await compressFolderTo(path, 'tar.gz');
    if (dest) { await refreshTree(); }
  }
  else if (action === 'rename')      renameEntry(path, type);
  else if (action === 'move-to')     moveToPrompt(path);
  else if (action === 'copy-to')     copyToPrompt(path);
  else if (action === 'delete')      deleteEntry(path, type);
  else if (action === 'unmount')     unmountEntry(path);
  else if (typeof action === 'string' && (action.startsWith('_extmenu:') || action.startsWith('_openin:'))) {
    const ei = extItems.find(x => x.key === action);
    if (ei) await extMenuDispatch(ei.item, path, _buildExtCtx(path));
  }
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
  if (name == null) name = await dlgPrompt('Duplicate as:', { defaultValue: defaultName });
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

// Replace the first `/// title: …` line in a notebook.txt header with a
// new title. If there's no title line at all, inserts one after the
// leading `/// auditable` directive. Returns the original text unchanged
// if neither anchor is found (defensive — uncommon for a real notebook).
function _patchTitleHeader(txt, newTitle) {
  // Try the existing-title path first — match the FIRST `/// title:`
  // line only, to avoid clobbering anything inside a markdown cell that
  // happens to look like a directive.
  const re = /^\/\/\/ title:.*$/m;
  if (re.test(txt)) return txt.replace(re, '/// title: ' + newTitle);
  // Insert after `/// auditable` directive line.
  const audMatch = txt.match(/^\/\/\/ auditable\s*$/m);
  if (audMatch) {
    const i = audMatch.index + audMatch[0].length;
    return txt.slice(0, i) + '\n/// title: ' + newTitle + txt.slice(i);
  }
  return txt;
}

async function renameEntry(path, type) {
  // For projects, the displayed name is project.json's `title`, which can
  // diverge from the directory basename (titles allow spaces / mixed case).
  // Rename should update BOTH so the tree label changes AND the on-disk
  // path follows — silently renaming only the dir produces the "nothing
  // happened" symptom because the tree never re-reads the title.
  let currentName, projectMeta = null;
  if (type === 'project') {
    try {
      projectMeta = JSON.parse(await WKS.vfs.readFile(path + '/project.json', 'utf8'));
      currentName = projectMeta.title || basename(path);
    } catch { currentName = basename(path); }
  } else {
    currentName = basename(path);
  }

  const name = await dlgPrompt('Rename to:', { defaultValue: currentName });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === currentName) return;

  try {
    if (type === 'project' && projectMeta) {
      // Persist the new title FIRST — if the dir-rename fails (path
      // collision etc.), we can recover by reading the new title from
      // project.json. The opposite ordering would leave a half-renamed
      // state on collision.
      projectMeta.title = trimmed;
      await WKS.vfs.writeFile(path + '/project.json',
        JSON.stringify(projectMeta, null, 2));

      // Also patch notebook.txt's `/// title:` header line, if present.
      // The notebook surface reads its title from there and emits
      // Surface:TitleChanged on boot — which OVERRIDES project.json's
      // title in the tab. Without this, an opened-after-rename tab would
      // still show the old title because the notebook self-reports it.
      try {
        const txt = await WKS.vfs.readFile(path + '/notebook.txt', 'utf8');
        const updated = _patchTitleHeader(txt, trimmed);
        if (updated !== txt) {
          await WKS.vfs.writeFile(path + '/notebook.txt', updated);
        }
      } catch { /* no notebook.txt, or unreadable — fine */ }
    }
    // Always attempt the directory rename — even for projects, since the
    // path is user-visible (URLs, pkg local: refs, copy-path).
    const newPath = join(parentOf(path), sanitize(trimmed));
    if (newPath !== path) {
      // Refuse to clobber an existing entry — the user would expect rename
      // to be safe.
      if (await WKS.vfs.exists(newPath)) {
        setStatus('rename: "' + sanitize(trimmed) + '" already exists');
        return;
      }
      await WKS.vfs.rename(path, newPath);
      // Walk WKS.surfaces and patch any tab whose path was under the
      // renamed dir. Updates rec.path so subsequent openPath dedups
      // correctly + updates the rails tab title for projects. Doesn't
      // rebind the surface iframe — the file content lives at the new
      // path now, but the iframe's in-memory state is unaffected by
      // the rename (it doesn't know its own path).
      for (const [tabId, rec] of WKS.surfaces) {
        if (rec.path === path || rec.path.startsWith(path + '/')) {
          rec.path = newPath + rec.path.slice(path.length);
          if (rec.path === newPath && type === 'project') {
            rec.title = trimmed;
            try { WKS.rails.updateTab(tabId, { title: trimmed }); } catch {}
          }
        }
      }
    }
    setStatus('renamed to ' + trimmed);
  } catch (e) {
    setStatus('rename failed: ' + (e.message || e));
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
