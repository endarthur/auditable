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
import { metaGet, metaSet } from './meta.js';

// File-panel width — persisted across reloads in shell meta IDB.
const SIDEBAR_WIDTH_KEY = 'sidebar.width';
const SIDEBAR_MIN = 140;
const sidebarMax = () => Math.min(640, Math.round(window.innerWidth * 0.6));
const clampSidebar = (w) => Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), w));

// A draggable splitter between the file panel and the rails area. Restores the
// saved width on boot and persists on drag-end. Width lives in the --tree-width
// CSS var on .works-sidebar (default 232px in CSS).
function installSidebarResizer() {
  const sidebar = document.querySelector('.works-sidebar');
  const handle = document.getElementById('works-sidebar-resizer');
  if (!sidebar || !handle) return;

  const applyWidth = (w) => sidebar.style.setProperty('--tree-width', clampSidebar(w) + 'px');

  // Restore saved width (fire-and-forget; CSS default holds until it lands).
  metaGet(SIDEBAR_WIDTH_KEY).then((w) => {
    if (typeof w === 'number' && isFinite(w)) applyWidth(w);
  }).catch(() => { /* no saved width — keep the CSS default */ });

  let startX = 0, startW = 0, shield = null;
  const onMove = (e) => applyWidth(startW + (e.clientX - startX));
  const onUp = () => {
    handle.classList.remove('dragging');
    if (shield) { shield.remove(); shield = null; }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const w = clampSidebar(sidebar.getBoundingClientRect().width);
    metaSet(SIDEBAR_WIDTH_KEY, w).catch(() => { /* best-effort persist */ });
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    // Surfaces are iframes; once the cursor crosses one it swallows pointer
    // events and the drag dies. A pointer-capturing shield over the whole
    // window keeps move/up in the shell document. Two details mirror the
    // tree-row drag shield (file-ops.js): a max z-index, and a 0.01-alpha
    // fill — Chromium skips hit-testing FULLY transparent overlays over
    // cross-origin iframes, so 'transparent' would let events sail through.
    shield = document.createElement('div');
    shield.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;cursor:col-resize;background:rgba(0,0,0,0.01)';
    document.body.appendChild(shield);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Double-click the splitter → reset to the default width.
  handle.addEventListener('dblclick', () => {
    sidebar.style.removeProperty('--tree-width');
    metaSet(SIDEBAR_WIDTH_KEY, 232).catch(() => {});
  });
}

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
import { uninstallExtension } from './uninstall-extension.js';
import {
  moveToPrompt, copyToPrompt, attachTreeRowDnd, downloadFile,
  downloadFolder, extractArchiveHere, extractArchiveToPrompt, compressFolderTo,
  ARCHIVE_EXT_RE,
} from './file-ops.js';

const IMPORTABLE_RE = /\.(html?|txt|ipynb)$/i;

const ROOT = '/';
// /projects open by default; the rest of the VFS is there, collapsed.
const expanded = new Set(['/', '/projects']);

// Outline entries default to *expanded* (inverse of folders). Toggling
// the chevron on an outline-entry adds its path to this set to collapse
// just that subtree; the next chevron click removes it.
const outlineCollapsed = new Set();

// notebook.outline.json is the sidecar persist.js writes per save. The
// tree special-cases this filename — instead of showing it as a regular
// file, we render it as an expandable pseudo-folder whose children are
// outline entries (markdown headers, %cellName directives, docTitle).
const OUTLINE_FILE = 'notebook.outline.json';

let _treeEl = null;
let _refreshTimer = null;

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; };
const join = (dir, name) => (dir === '/' ? '/' : dir + '/') + name;
const sanitize = (s) => String(s).trim().replace(/[/\\]+/g, '-');
const rid = () => Math.random().toString(36).slice(2, 10);

// Recognize a tree row as an installed-extension leaf directory and
// return its canonical package name ('@scope/name' or 'bare-name'),
// or null if the row is anything else. Two shapes installed by
// installGcupkg: /lib/@scope/name and /lib/local/name. Excludes the
// scope folder itself (/lib/@scope) and any deeper paths.
function _libPkgName(path, type) {
  if (type !== 'folder' && type !== 'project') return null;
  const m = /^\/lib\/(?:(@[\w.-]+)\/([\w.-]+)|local\/([\w.-]+))$/.exec(path);
  if (!m) return null;
  return m[1] ? m[1] + '/' + m[2] : m[3];
}

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

  installSidebarResizer();
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
    } else if (e.name === OUTLINE_FILE) {
      // The outline sidecar — render as a pseudo-folder whose children
      // are the notebook's headers / cellnames / docTitle. Lazy: only
      // read + parse the JSON once the user opens the row.
      let children = null;
      if (expanded.has(p)) {
        try {
          const data = JSON.parse(await WKS.vfs.readFile(p, 'text'));
          children = _buildOutlineForest(data.entries || [], dir, p);
        } catch { children = []; }
      }
      nodes.push({
        name: e.name, label: 'outline', path: p, type: 'outline',
        projectDir: dir, children,
      });
    } else {
      nodes.push({ name: e.name, label, path: p, type: 'file' });
    }
  }
  const rank = { folder: 0, project: 1, outline: 2, file: 3 };
  nodes.sort((a, b) => (rank[a.type] - rank[b.type])
    || (a.label || a.name).localeCompare(b.label || b.name));
  return nodes;
}

// Walk the flat entries list and build a nested forest by `level`. Each
// entry's parent is the most recent entry with strictly lower level (or
// the root if none). Synthetic paths (`<outlinePath>#i`) give us stable
// keys for the collapse Set.
function _buildOutlineForest(entries, projectDir, outlinePath) {
  const root = { children: [] };
  const stack = [{ level: -1, node: root }];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    while (stack[stack.length - 1].level >= e.level) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = {
      name: 'entry-' + i,
      label: e.text,
      path: outlinePath + '#' + i,
      type: 'outline-entry',
      kind: e.kind, level: e.level,
      cellId: e.cellId, headerIdx: e.headerIdx,
      projectDir,
      children: [],
    };
    parent.children.push(node);
    stack.push({ level: e.level, node });
  }
  return root.children;
}

function renderNode(node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-' + node.type;
  row.dataset.path = node.path;
  row.style.paddingLeft = (6 + depth * 14) + 'px';

  // Outline-entry rows expand by inverse default (visible until collapsed)
  // and use a separate set; everything else uses the `expanded` set.
  const hasOutlineChildren = node.type === 'outline-entry' && node.children && node.children.length > 0;
  const isExpandable = (node.type === 'folder' || node.type === 'project'
                     || node.type === 'outline' || hasOutlineChildren);
  const isOpen =
      node.type === 'outline-entry' ? !outlineCollapsed.has(node.path)
    : isExpandable                  ? expanded.has(node.path)
    :                                 false;

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
    icon = '⊟';
    label = node.label || node.name;
  } else if (node.type === 'project') {
    icon = (kindDef(node.kind) || {}).icon || '■';
    label = node.title;
  } else if (node.type === 'outline') {
    icon = '≡';
    label = 'outline';
  } else if (node.type === 'outline-entry') {
    // Distinct glyph per outline-entry kind so headers and named cells
    // read as different things at a glance. Header glyph repeats #
    // by level so H1/H2/H3 look like the markdown that produced them.
    if (node.kind === 'title')         icon = '▤';
    else if (node.kind === 'cellname') icon = '→';
    else                               icon = '#'.repeat(Math.max(1, Math.min(6, node.level)));
    label = node.label;
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
  } else if (node.type === 'outline') {
    // Outline file: row toggles expansion of the entries list. No open
    // semantics (don't want to spawn a text surface on the JSON).
    row.addEventListener('click', toggle);
  } else if (node.type === 'outline-entry') {
    // Outline entry: chevron toggles the (inverse-default) collapse;
    // row click jumps to the corresponding cell in the notebook.
    if (hasOutlineChildren) {
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        if (outlineCollapsed.has(node.path)) outlineCollapsed.delete(node.path);
        else outlineCollapsed.add(node.path);
        refreshTree();
      });
    }
    row.addEventListener('click', (e) => {
      // Ignore clicks that originated from the chevron (its handler ran).
      if (e.target === chevron) return;
      jumpToOutlineEntry(node);
    });
  } else {
    row.addEventListener('dblclick', () => openPath(node.path));
  }
  // Outline rows have no useful context menu yet — skip it so we don't
  // hand the user File-Manager actions (Delete / Rename / Move) that
  // would corrupt the JSON sidecar.
  if (node.type !== 'outline' && node.type !== 'outline-entry') {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e, node.path, node.type);
    });
    // Drag-to-move: draggable source on every row, drop target on folders.
    // Ctrl+drop copies; plain drop moves.
    attachTreeRowDnd(row, node);
  }

  if (isExpandable && isOpen && node.children) {
    for (const c of node.children) renderNode(c, depth + 1);
  }
}

// Click → focus the project's notebook (opening it if not already a tab)
// and ask it to scroll the target cell into view via the Notebook A-Bus
// interface. Surface.Ready handshake on the first open path keeps the
// jump from racing the cell DOM construction.
async function jumpToOutlineEntry(node) {
  // Find or open the notebook tab for this project.
  let rec = null;
  for (const r of WKS.surfaces.values()) {
    if (r.path === node.projectDir && r.kind === 'notebook') { rec = r; break; }
  }
  if (!rec) {
    // openPath returns the tab id; look the surface up by it.
    const tabId = await openPath(node.projectDir);
    if (!tabId) return;
    rec = WKS.surfaces.get(tabId);
    if (!rec) return;
    // Wait for the surface to declare Ready before sending the jump call.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); off(); resolve(); };
      const off = WKS.worksBus.subscribe(
        { from: rec.uniqueName, interface: 'Surface', member: 'Ready' },
        finish,
      );
      const t = setTimeout(finish, 3000);
    });
  } else {
    // Already open — focus the tab via rails.
    WKS.rails?.activateTab?.(rec.tabId);
  }
  try {
    await WKS.worksBus.call(
      { to: rec.uniqueName, path: '/', interface: 'Notebook', member: 'JumpToCell' },
      [node.cellId, node.headerIdx],
    );
  } catch { /* surface doesn't expose Notebook — silently no-op */ }
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
  // Easter egg (off by default; unlocked by typing "dada" in the shell): open
  // a book directory in the DD-60 "DADA Diskman" retro reader skin.
  if (WKS.dd60Enabled && (type === 'folder' || type === 'project')) {
    try { if (await WKS.vfs.exists(path + '/book.json')) extras.push({ label: 'Open in DADA Diskman ▥', action: 'open-dd60' }); } catch { /* ignore */ }
  }
  if (extras.length) items.push('---', ...extras);

  // /lib/<pkg> leaf directories — give them "Remove extension" as a
  // first-class action so users don't have to use Delete (which would
  // appear destructive and only wipes the directory, leaving stale
  // /usr/share/examples and lockfile entries behind). Two shapes:
  //   /lib/@scope/name  — scoped extension
  //   /lib/local/name   — bare-name extension
  const extPkgName = _libPkgName(path, type);
  if (extPkgName) {
    items.push('---');
    items.push({ label: 'Remove extension', action: 'remove-extension', danger: true });
  }

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
  else if (action === 'open-dd60') spawnSurface('dd60', { path, title: basename(path) });
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
  else if (action === 'remove-extension' && extPkgName) {
    const ok = await dlgConfirm(
      'Remove extension',
      `Remove ${extPkgName}? This deletes its source, documentation, examples, and any contributed surfaces or context-menu items. Notebooks using it will need a re-install to work again.`
    );
    if (ok) {
      try { await uninstallExtension(extPkgName); }
      catch (e) {
        setStatus(`uninstall failed: ${e.message}`);
        console.error('[uninstall]', e);
      }
    }
  }
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
