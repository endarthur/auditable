// File operations on the workspace VFS — move, copy, external drag-drop
// imports, and tree drag-to-move. Loaded by init.js.

import { WKS, setStatus } from './state.js';
import { Dialog } from '#dialog';
import { importNotebook } from './import.js';
import { openPath } from './surfaces.js';
import { archive } from '#archive';

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const parentOf = (p) => {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
};
const join = (a, b) => (a === '/' ? '' : a) + '/' + b;

// ── Move / Copy primitives ──────────────────────────────────────────

/** Move a file or directory into destDir; returns the new path. */
export async function moveTo(srcPath, destDir) {
  if (!srcPath || !destDir) return null;
  if (srcPath === destDir || destDir.startsWith(srcPath + '/')) {
    setStatus('move: destination is the source itself');
    return null;
  }
  const dest = join(destDir, basename(srcPath));
  if (await WKS.vfs.exists(dest)) {
    setStatus('move: ' + dest + ' already exists');
    return null;
  }
  try {
    await WKS.vfs.rename(srcPath, dest);
    setStatus('moved → ' + dest);
    return dest;
  } catch (e) {
    setStatus('move failed: ' + (e.message || e));
    return null;
  }
}

/** Recursively copy a file or directory into destDir; returns the new path. */
export async function copyTo(srcPath, destDir) {
  if (!srcPath || !destDir) return null;
  if (destDir.startsWith(srcPath + '/') || destDir === srcPath) {
    setStatus('copy: destination is inside the source');
    return null;
  }
  let dest = join(destDir, basename(srcPath));
  // Auto-dedupe (Finder-style: "thing", "thing copy", "thing copy 2"…)
  if (await WKS.vfs.exists(dest)) {
    const base = basename(srcPath);
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? base + ' copy' : base + ' copy ' + i;
      const cand = join(destDir, candidate);
      if (!(await WKS.vfs.exists(cand))) { dest = cand; break; }
      if (i > 1000) { setStatus('copy: too many name conflicts'); return null; }
    }
  }
  try {
    await _copyRecursive(srcPath, dest);
    setStatus('copied → ' + dest);
    return dest;
  } catch (e) {
    setStatus('copy failed: ' + (e.message || e));
    return null;
  }
}

async function _copyRecursive(src, dest) {
  // File vs directory dispatch
  let isDir = false;
  try {
    const entries = await WKS.vfs.readdir(src);
    isDir = true;
  } catch { isDir = false; }
  if (isDir) {
    await WKS.vfs.mkdir(dest, { recursive: true });
    const entries = await WKS.vfs.readdir(src, { stat: true });
    for (const e of entries) {
      await _copyRecursive(join(src, e.name), join(dest, e.name));
    }
  } else {
    // Try text first; fall back to binary for non-utf8 content.
    try {
      const text = await WKS.vfs.readFile(src, 'utf8');
      await WKS.vfs.writeFile(dest, text);
    } catch {
      const bin = await WKS.vfs.readFile(src);
      await WKS.vfs.writeFile(dest, bin);
    }
  }
}

// ── Folder-picker dialog ────────────────────────────────────────────

// Walk the VFS collecting folder paths. Skips /usr (volatile bundled libs),
// /tmp (volatile scratch), and entries that look like project leaves (have
// a project.json) — we move into folders, not into projects.
async function _collectFolders() {
  const out = [];
  async function recurse(dir, depth) {
    out.push({ path: dir, depth });
    if (depth > 6) return;
    let entries;
    try { entries = await WKS.vfs.readdir(dir, { stat: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.type !== 'directory') continue;
      const p = join(dir, e.name);
      // Skip non-target areas
      if (p.startsWith('/usr')) continue;
      if (p.startsWith('/tmp')) continue;
      // Skip project leaves (we don't move INTO projects)
      try {
        if (await WKS.vfs.exists(p + '/project.json')) continue;
      } catch { /* */ }
      await recurse(p, depth + 1);
    }
  }
  for (const root of ['/projects', '/home', '/mnt']) {
    try {
      if (await WKS.vfs.exists(root)) await recurse(root, 0);
    } catch { /* */ }
  }
  return out;
}

/** Show a folder-picker dialog. Resolves to the chosen path or null. */
async function pickFolder(title, srcPath) {
  const folders = await _collectFolders();
  const srcDir = parentOf(srcPath);
  return new Promise((resolve) => {
    const dlg = new Dialog({
      title,
      width: 460,
      render: (body, ctx) => {
        body.style.cssText = 'padding: 8px 12px;';

        // "+ New folder…" — opens a sub-prompt for an absolute VFS path,
        // creates it (recursively), then closes the picker with that path.
        // Lets the user create a fresh destination without bouncing out to
        // the tree first. Sits at the top of the list as a sticky row.
        const newRow = document.createElement('div');
        newRow.tabIndex = 0;
        newRow.style.cssText = 'padding: 4px 8px; cursor: pointer; '
          + 'border-radius: 2px; color: var(--gcu-accent, #d97a3c); '
          + 'border-bottom: 1px solid var(--gcu-border, #2a2e33); '
          + 'margin-bottom: 4px;';
        newRow.textContent = '+ New folder…';
        newRow.onmouseenter = () => newRow.style.background = 'var(--gcu-bg-bright, #21262b)';
        newRow.onmouseleave = () => newRow.style.background = '';
        newRow.onfocus = () => newRow.style.background = 'var(--gcu-bg-bright, #21262b)';
        newRow.onblur = () => newRow.style.background = '';
        const newFolderFlow = async () => {
          // Default to the source's parent directory + a placeholder name
          // so the user only has to type the new leaf in the common case.
          const seed = (srcDir === '/' ? '' : srcDir) + '/new-folder';
          const newPath = await dlgPrompt('Create a new folder', {
            title: 'New folder',
            defaultValue: seed,
            placeholder: '/projects/my-extract',
          });
          if (!newPath) return;  // user cancelled
          try {
            await WKS.vfs.mkdir(newPath, { recursive: true });
            ctx.close(newPath);
          } catch (e) {
            // Re-prompt with the error visible. For simplicity here we just
            // surface it via alert + leave the picker open for retry.
            setStatus('mkdir failed: ' + (e.message || e));
          }
        };
        newRow.onclick = newFolderFlow;
        newRow.onkeydown = (e) => { if (e.key === 'Enter') newFolderFlow(); };
        body.appendChild(newRow);

        const list = document.createElement('div');
        list.style.cssText = 'max-height: 50vh; overflow: auto; '
          + 'font: 12px ui-monospace, monospace;';
        for (const f of folders) {
          // Don't allow moving into the source's own directory
          // (no-op) or into itself.
          if (f.path === srcPath || f.path.startsWith(srcPath + '/')) continue;
          const row = document.createElement('div');
          row.tabIndex = 0;
          const isCurrent = f.path === srcDir;
          row.style.cssText = 'padding: 4px 8px; cursor: pointer; '
            + 'border-radius: 2px; '
            + 'padding-left: ' + (8 + f.depth * 14) + 'px; '
            + (isCurrent ? 'color: var(--gcu-fg-soft, #888);' : '');
          row.textContent = (isCurrent ? '(current) ' : '') + f.path;
          row.onmouseenter = () => row.style.background = 'var(--gcu-bg-bright, #21262b)';
          row.onmouseleave = () => row.style.background = '';
          row.onfocus = () => row.style.background = 'var(--gcu-bg-bright, #21262b)';
          row.onblur = () => row.style.background = '';
          row.onclick = () => ctx.close(f.path);
          row.onkeydown = (e) => { if (e.key === 'Enter') ctx.close(f.path); };
          list.appendChild(row);
        }
        body.appendChild(list);
      },
    });
    dlg.show().then(resolve);
  });
}

/** ctx menu: Move to… */
// Download a single VFS file via the browser's standard save dialog.
// Reads the file (binary-safe via Uint8Array fallback), wraps in a Blob,
// triggers an <a download> click. application/octet-stream is the safest
// default — the browser respects the filename's extension and the user's
// download folder regardless of the type hint.
export async function downloadFile(path) {
  if (!path) return;
  let bytes;
  try {
    // MUST pass 'bytes' — without it the MemoryBackend (and most others)
    // TextDecoder().decode() the file contents and substitute U+FFFD for
    // any non-UTF-8-valid bytes. Encoding that string back to UTF-8 is
    // lossy and corrupts any binary file (e.g. downloading a ZIP through
    // this path used to land bytes 10..12 as `ef bf bd` because the binary
    // header was UTF-8-laundered on the way out).
    const r = await WKS.vfs.readFile(path, 'bytes');
    if (typeof r === 'string') bytes = new TextEncoder().encode(r);
    else if (r instanceof Uint8Array) bytes = r;
    else if (r && r.buffer) bytes = new Uint8Array(r.buffer);
    else bytes = new TextEncoder().encode(String(r));
  } catch (e) {
    setStatus('download failed: ' + (e.message || e));
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Slight delay before revoke — Firefox needs the URL live during click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('downloaded ' + basename(path));
}

// Recognized archive file extensions. Used by tree.js to decide whether to
// surface Extract / Preview actions in the context menu. The actual format
// detection (magic-byte sniff) happens inside @gcu/archive — this regex is
// just for the menu population pass.
export const ARCHIVE_EXT_RE = /\.(zip|tar|tar\.gz|tgz|tar\.zst|tzst|tar\.xz|txz|tar\.bz2|tbz2|gz|zst)$/i;

// Strip a recognized archive extension off a basename. Returns the stem
// suitable for use as an extracted-directory name. e.g.
//   'data.tar.gz' → 'data'    'archive.zip' → 'archive'    'foo.gz' → 'foo'
function _stripArchiveExt(name) {
  return name.replace(ARCHIVE_EXT_RE, '');
}

// Resolve a destination path that may collide with an existing entry by
// auto-suffixing. Mirrors Finder-style 'foo (2).zip' / 'foo (3).zip'.
// Used for Extract here (target directory) and Compress as (target file)
// — both want non-destructive defaults.
async function _uniqueDest(path) {
  if (!(await WKS.vfs.exists(path))) return path;
  // Split into stem + ext (last extension only — '.tar.gz' loses '.gz' here,
  // which is fine because the suffix lives inside the stem anyway:
  //   '/foo.tar.gz' → '/foo.tar (2).gz'  is mildly ugly but unambiguous).
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0) ? path.slice(0, slash + 1 + dot) : path;
  const ext  = (dot > 0) ? path.slice(slash + 1 + dot)    : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await WKS.vfs.exists(candidate))) return candidate;
  }
  throw new Error('rename: too many collisions');
}

// Trigger the browser save dialog for arbitrary bytes. Shared by
// downloadFile and downloadFolder so the blob-URL handling is in one place.
function _triggerDownload(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Compress a workspace folder into a ZIP and trigger a browser download.
// The folder isn't touched; archive.compress walks the VFS in-memory and
// produces a single Uint8Array. Recommended for folders up to ~hundreds
// of MB — beyond that the in-memory build will choke the tab.
export async function downloadFolder(path) {
  if (!path) return;
  const name = path.split('/').filter(Boolean).pop() || 'archive';
  setStatus(`zipping ${name}…`);
  try {
    const result = await archive.compress(
      { vfs: WKS.vfs, path },
      'memory',
      { format: 'zip' }
    );
    const [, bytes] = [...result.entries()][0];
    _triggerDownload(bytes, name + '.zip');
    setStatus(`downloaded ${name}.zip`);
  } catch (e) {
    setStatus('download failed: ' + (e.message || e));
  }
}

// Extract an archive file into a sibling directory. The dir name is derived
// from the archive's basename minus the extension; collisions auto-rename
// Finder-style. After completion, refreshes the tree and opens the result.
export async function extractArchiveHere(srcPath) {
  if (!srcPath) return;
  const parentDir = (() => {
    const i = srcPath.lastIndexOf('/');
    return i <= 0 ? '/' : srcPath.slice(0, i);
  })();
  const stem = _stripArchiveExt(srcPath.split('/').pop());
  const desired = parentDir === '/' ? '/' + stem : `${parentDir}/${stem}`;
  const dest = await _uniqueDest(desired);
  setStatus(`extracting to ${dest}…`);
  try {
    await archive.extract(
      { vfs: WKS.vfs, path: srcPath },
      { vfs: WKS.vfs, path: dest },
      { overwrite: 'rename' }   // belt + suspenders — _uniqueDest already de-collided the root
    );
    setStatus(`extracted to ${dest}`);
    return dest;
  } catch (e) {
    setStatus('extract failed: ' + (e.message || e));
    return null;
  }
}

// Extract an archive file into a user-picked directory. Reuses Move/Copy's
// folder-picker dialog (defined later in this file).
export async function extractArchiveToPrompt(srcPath) {
  if (!srcPath) return;
  const dest = await pickFolder('Extract to which folder?', srcPath);
  if (!dest) return;
  setStatus(`extracting to ${dest}…`);
  try {
    await archive.extract(
      { vfs: WKS.vfs, path: srcPath },
      { vfs: WKS.vfs, path: dest },
      { overwrite: 'rename' }
    );
    setStatus(`extracted to ${dest}`);
    return dest;
  } catch (e) {
    setStatus('extract failed: ' + (e.message || e));
    return null;
  }
}

// Compress a folder into an archive file in the SAME parent directory.
// Format is 'zip' or 'tar.gz'. Output filename = folder name + extension,
// auto-renamed on collision.
export async function compressFolderTo(srcPath, format) {
  if (!srcPath) return;
  const parentDir = (() => {
    const i = srcPath.lastIndexOf('/');
    return i <= 0 ? '/' : srcPath.slice(0, i);
  })();
  const name = srcPath.split('/').filter(Boolean).pop() || 'archive';
  const ext = format === 'tar.gz' ? '.tar.gz' : '.zip';
  const desired = parentDir === '/' ? '/' + name + ext : `${parentDir}/${name}${ext}`;
  const dest = await _uniqueDest(desired);
  setStatus(`compressing to ${dest}…`);
  try {
    await archive.compress(
      { vfs: WKS.vfs, path: srcPath },
      { vfs: WKS.vfs, path: dest },
      { format }
    );
    setStatus(`compressed to ${dest}`);
    return dest;
  } catch (e) {
    setStatus('compress failed: ' + (e.message || e));
    return null;
  }
}

export async function moveToPrompt(srcPath) {
  const dest = await pickFolder('Move "' + basename(srcPath) + '" to…', srcPath);
  if (!dest) return;
  await moveTo(srcPath, dest);
}

/** ctx menu: Copy to… */
export async function copyToPrompt(srcPath) {
  const dest = await pickFolder('Copy "' + basename(srcPath) + '" to…', srcPath);
  if (!dest) return;
  await copyTo(srcPath, dest);
}

// ── External-file drag-drop (OS file → workspace) ───────────────────

/** Install a global drag-drop listener on the shell. External files
 *  dropped anywhere on the works window route through importNotebook
 *  (which dispatches by extension to .txt / .html / .ipynb handlers).
 *
 *  Internal tree drags use a custom MIME type; this handler ignores
 *  them by checking event.dataTransfer.files.length first. */
export function installGlobalFileDrop() {
  const onDragOver = (ev) => {
    // Show "drop allowed" cursor only for OS-file drags.
    if (!ev.dataTransfer || ev.dataTransfer.types.indexOf('Files') < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.files
        || ev.dataTransfer.files.length === 0) return;
    ev.preventDefault();
    for (const file of ev.dataTransfer.files) {
      try {
        const content = await file.text();
        const projPath = await importNotebook(content, file.name);
        await openPath(projPath);
        setStatus('imported ' + file.name);
      } catch (e) {
        console.error('[works] drop import failed:', file.name, e);
        setStatus('drop failed: ' + file.name + ' — ' + (e.message || e));
      }
    }
  };
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
}

// ── Tree drag-to-move ───────────────────────────────────────────────

const DND_MIME = 'application/x-works-tree-path';

/** Make a tree row draggable and register it as a drop target.
 *  Called from tree.js's renderNode for each row. */
export function attachTreeRowDnd(row, node) {
  // Sources: every non-root, non-mount-root row is draggable.
  if (node.path !== '/' && parentOf(node.path) !== '/') {
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
      ev.stopPropagation();
      ev.dataTransfer.setData(DND_MIME, node.path);
      ev.dataTransfer.setData('text/plain', node.path);
      ev.dataTransfer.effectAllowed = 'copyMove';
    });
  }
  // Drop targets: folders only (not files, not project leaves).
  if (node.type === 'folder') {
    row.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer.types.indexOf(DND_MIME) < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = ev.ctrlKey || ev.metaKey ? 'copy' : 'move';
      row.style.background = 'var(--gcu-bg-bright, #21262b)';
    });
    row.addEventListener('dragleave', () => { row.style.background = ''; });
    row.addEventListener('drop', async (ev) => {
      row.style.background = '';
      const src = ev.dataTransfer.getData(DND_MIME);
      if (!src) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey) {
        await copyTo(src, node.path);
      } else {
        await moveTo(src, node.path);
      }
    });
  }
}
