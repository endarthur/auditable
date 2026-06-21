// File operations on the workspace VFS — move, copy, external drag-drop
// imports, and tree drag-to-move. Loaded by init.js.

import { WKS, setStatus } from './state.js';
import { Dialog, confirm as dlgConfirm } from '#dialog';
import { importNotebook } from './import.js';
import { importEpubBytes } from './book-import.js';
import { installGcudatBytes } from './gcudat-install.js';
import { readSettings } from './settings-store.js';
import { openPath } from './surfaces.js';
import { archive } from '#archive';
import { parseGcupkg, installGcupkg, gcupkgConsentDescriptor, gcupkgConsentPrompt } from '#gcupkg';
import { mergeExamplesFromExtension } from './examples-loader.js';
import { evaluateWorksScript } from './extension-loader.js';
import { declarePackageServices } from './extension-services.js';
import { registerPackageSurfaceTools } from './surface-tools.js';

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

// ── Upload an OS file into the workspace VFS (binary-safe) ──────────

/** Write a dropped/picked File into destDir, auto-deduping the name. */
export async function uploadFileToVfs(file, destDir = '/home') {
  const buf = new Uint8Array(await file.arrayBuffer());
  await WKS.vfs.mkdir(destDir, { recursive: true });
  let dest = join(destDir, file.name);
  if (await WKS.vfs.exists(dest)) {
    const dot = file.name.lastIndexOf('.');
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
      const c = join(destDir, stem + ' (' + i + ')' + ext);
      if (!(await WKS.vfs.exists(c))) { dest = c; break; }
    }
  }
  await WKS.vfs.writeFile(dest, buf);
  try { WKS.worksBus?.signal({ interface: 'VFS', member: 'Changed' }, [{ path: destDir, op: 'upload' }]); } catch { /* */ }
  return dest;
}

/** Open the OS file picker and upload the chosen file(s) into destDir.
 *  Returns the path of the last uploaded file (or null). */
export async function uploadFilePrompt(destDir) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      let last = null;
      for (const f of inp.files) {
        try { last = await uploadFileToVfs(f, destDir); setStatus('uploaded → ' + last); }
        catch (e) { setStatus('upload failed: ' + (e.message || e)); }
      }
      inp.remove();
      resolve(last);
    });
    // If the user cancels, the change event never fires — clean up on focus.
    window.addEventListener('focus', () => setTimeout(() => { if (inp.isConnected && !inp.files.length) { inp.remove(); resolve(null); } }, 400), { once: true });
    inp.click();
  });
}

// ── External-file drag-drop (OS file → workspace) ───────────────────

/** Install a global drag-drop listener on the shell. External files
 *  dropped anywhere on the works window route through importNotebook
 *  (which dispatches by extension to .txt / .html / .ipynb handlers).
 *
 *  Internal tree drags use a custom MIME type; this handler ignores
 *  them by checking event.dataTransfer.files.length first. */
export function installGlobalFileDrop() {
  // dragenter/dragleave fire for every child element transition during the
  // drag — entering a nested element triggers BOTH a dragenter on the new
  // node and a dragleave on the old one (in unpredictable order). A counter
  // pattern is the canonical fix: increment on enter, decrement on leave,
  // show the overlay while > 0. Drop / dragend reset the counter to zero.
  let depth = 0;
  const overlay = _ensureDropOverlay();

  // Truthy iff this drag carries OS-file data (i.e. not an internal
  // tree-row drag which uses application/x-works-tree-path).
  const isFileDrag = (ev) =>
    ev.dataTransfer && ev.dataTransfer.types && ev.dataTransfer.types.indexOf('Files') >= 0;

  const showOverlay = () => { overlay.classList.add('visible'); };
  const hideOverlay = () => { overlay.classList.remove('visible'); depth = 0; };

  const onDragEnter = (ev) => {
    if (!isFileDrag(ev)) return;
    depth++;
    showOverlay();
  };
  const onDragLeave = (ev) => {
    if (!isFileDrag(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  };
  const onDragOver = (ev) => {
    // Show "drop allowed" cursor only for OS-file drags.
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (ev) => {
    hideOverlay();
    if (!ev.dataTransfer || !ev.dataTransfer.files
        || ev.dataTransfer.files.length === 0) return;
    ev.preventDefault();
    for (const file of ev.dataTransfer.files) {
      try {
        // .gcupkg — sideload an extension. Binary path, separate from
        // the notebook-import flow (which is text-based).
        if (file.name.toLowerCase().endsWith('.gcupkg')) {
          await installDroppedGcupkg(file);
          continue;
        }
        // .epub — ingest into a reader book (binary, like .gcupkg).
        if (file.name.toLowerCase().endsWith('.epub')) {
          const buf = new Uint8Array(await file.arrayBuffer());
          const dir = await importEpubBytes(buf, file.name);
          if (dir) { await openPath(dir); setStatus('imported ' + file.name); }
          continue;
        }
        // .gcudat — install a data pack (pure data, routed by kind; no eval).
        if (file.name.toLowerCase().endsWith('.gcudat')) {
          const buf = new Uint8Array(await file.arrayBuffer());
          const dest = await installGcudatBytes(buf, file.name);
          if (dest) await openPath(dest);
          continue;
        }
        // Notebook text formats → import as a project.
        if (/\.(txt|html?|ipynb)$/i.test(file.name)) {
          const content = await file.text();
          const projPath = await importNotebook(content, file.name);
          await openPath(projPath);
          setStatus('imported ' + file.name);
          continue;
        }
        // Anything else (pdf, images, csv, arbitrary binary) → upload into the
        // workspace VFS and open it by kind. (Previously these were run through
        // file.text() → importNotebook, which garbled binary content.)
        const dest = await uploadFileToVfs(file, '/home');
        await openPath(dest);
        setStatus('uploaded → ' + dest);
      } catch (e) {
        console.error('[works] drop import failed:', file.name, e);
        setStatus('drop failed: ' + file.name + ' — ' + (e.message || e));
      }
    }
  };
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragover',  onDragOver);
  document.addEventListener('drop',      onDrop);
  // Safety net — if the drag ends outside our handlers (drag escapes the
  // window with a quick release), make sure the overlay clears.
  window.addEventListener('dragend',   hideOverlay);
  window.addEventListener('blur',      hideOverlay);
}

// Lazily-built full-screen overlay element. Browser privacy hides the
// dragged file's name during dragover, so the message stays generic
// (specific result lands in the status bar after the drop). One element,
// reused for the lifetime of the page.
function _ensureDropOverlay() {
  let el = document.getElementById('works-drop-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'works-drop-overlay';
  el.innerHTML = `
    <div class="works-drop-card">
      <div class="works-drop-icon">⤓</div>
      <div class="works-drop-title">Drop to import</div>
      <div class="works-drop-hint">
        Notebooks (.html, .txt, .ipynb) become new projects.<br>
        Extensions (.gcupkg) install; books (.epub) + data packs (.gcudat) load.<br>
        Any other file (PDF, images, …) uploads into your workspace.
      </div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

// Sideload a .gcupkg dropped from the OS file picker. Parses the archive,
// validates, installs into /lib/ + /usr/share/, hydrates _installedModules
// so load() resolves immediately. Refreshes the tree at the end so the new
// /lib entry is visible.
async function installDroppedGcupkg(file) {
  setStatus('reading ' + file.name + '…');
  await installExtensionWithConsent(new Uint8Array(await file.arrayBuffer()), file.name, 'extension');
}

// The single consent gate every non-registry install funnels through, so
// nothing installs silently (capability-security spec §7). Used by the shell's
// own OS-drop (above) AND by the Shell.InstallExtension A-Bus method a notebook
// surface delegates to — so a .gcupkg dropped on a notebook installs to the
// WORKSPACE with consent, not silently into that one notebook. gcupkg (code)
// ALWAYS prompts; gcudat (inert data) installs on the lighter-touch default,
// its consent gated behind a future `confirmDataPackInstall` toggle. The
// registry/Browse-Library path keeps calling installGcupkgBytes directly —
// clicking "Install" on a package is already explicit intent.
export async function installExtensionWithConsent(bytes, filename, kind = 'extension') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (kind === 'data') {
    // Data packs are inert; gate only when the workspace asks for it
    // (confirmDataPackInstall in /etc/works.json, default off).
    let confirmData = false;
    try { const s = await readSettings(WKS.vfs); confirmData = !!(s && s.confirmDataPackInstall); }
    catch { /* default off */ }
    if (confirmData) {
      const ok = await dlgConfirm(
        `Install data pack ${filename}?\n\nInstalls to the workspace library.`,
        { title: 'Install data pack', okLabel: 'Install' });
      if (!ok) { setStatus('data pack install cancelled'); return { cancelled: true }; }
    }
    const dest = await installGcudatBytes(u8, filename);
    if (dest) await openPath(dest);
    return { installed: true, kind: 'data', dest: dest || null };
  }
  let parsed;
  try {
    parsed = await parseGcupkg(u8, { archive });
  } catch (e) {
    setStatus(`gcupkg parse failed: ${e.message}`);
    return { error: e.message };
  }
  const descriptor = gcupkgConsentDescriptor(parsed, { scope: 'workspace' });
  const c = gcupkgConsentPrompt(descriptor);
  const ok = await dlgConfirm(c.message, { title: c.title, okLabel: c.okLabel, danger: c.danger });
  if (!ok) {
    setStatus(`install cancelled — ${descriptor.name}`);
    return { cancelled: true, name: descriptor.name };
  }
  await installGcupkgBytes(u8, filename);
  return { installed: true, name: descriptor.name, version: descriptor.version, integrityOk: parsed.integrity.ok };
}

// Install .gcupkg bytes: parse → install to /lib (+ /usr/share) → merge
// examples → register works.js so surfaces/menu items appear immediately.
// Returns { name, version, libPath, integrityOk }; throws on parse failure.
// Shared by the OS-drop path and the content registry (registry.js).
export async function installGcupkgBytes(bytes, filename) {
  let parsed;
  try {
    parsed = await parseGcupkg(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { archive });
  } catch (e) {
    setStatus(`gcupkg parse failed: ${e.message}`);
    throw e;
  }

  // Permissive install — broken integrity surfaces in the lockfile + status
  // bar but doesn't block. Matches `pkg install` behavior.
  const result = await installGcupkg(parsed, {
    vfs:              WKS.vfs,
    installedModules: typeof window !== 'undefined' ? window._installedModules : null,
  });

  // Merge the extension's examples (if any) into the Help → Open example
  // picker. Without this, the examples land on disk but stay invisible
  // until the next page reload re-reads the manifest from VFS.
  if (result.exampleRoot) {
    const slug = result.exampleRoot.split('/').pop();
    try {
      await mergeExamplesFromExtension(WKS.vfs, slug);
    } catch (e) {
      console.warn('[works] examples merge failed:', e);
    }
  }

  const verdict = parsed.integrity.ok === false
    ? ' (⚠ integrity mismatch)'
    : (parsed.integrity.ok === true ? ' ✓' : '');
  setStatus(`installed ${parsed.meta.name}@${parsed.meta.version}${verdict} → ${result.libPath}`);
  console.log('[works] gcupkg installed:', {
    name: parsed.meta.name,
    version: parsed.meta.version,
    libPath: result.libPath,
    examples: result.exampleCount,
    docs: result.docsCount,
    hasAdder: result.hasAdder,
    integrity: parsed.integrity,
    suggested: result.hasAdder
      ? `load("${parsed.meta.name}"); load("${parsed.meta.name}/adder");`
      : `load("${parsed.meta.name}");`,
  });

  // Tree refresh — the workspace VFS change usually triggers this via the
  // existing VFS.Changed signal, but kick it explicitly to be safe.
  try {
    WKS.worksBus?.signal({ interface: 'VFS', member: 'Changed' }, [{ path: '/lib', op: 'gcupkg-install' }]);
  } catch { /* not yet wired — fine */ }

  // EXTENSION_SPEC §3.8.7 — evaluate the just-installed works.js in shell
  // context so surfaces + contextMenu items register immediately. Without
  // this the user would have to reload Works to pick them up (the boot
  // loader only walks /lib at startup). Silently no-ops if the extension
  // didn't ship a works.js.
  try { await evaluateWorksScript(parsed.meta.name); }
  catch (e) { console.warn('[works] post-install works.js evaluation failed:', e.message); }

  // §3.9 — declare the just-installed package's services cold (the data-manifest
  // counterpart to works.js). Without this the boot scan is the only declarer, so
  // a runtime-installed service would need a reload to become callable.
  try { await declarePackageServices(parsed.meta.name); }
  catch (e) { console.warn('[works] post-install service declaration failed:', e.message); }

  // Same for the package's gcu.agentTools — register them live so a just-installed
  // package's surface tools are reachable via the meta-tools without a reload
  // (works-agent-tools-spec; mirrors the service declaration above).
  try { await registerPackageSurfaceTools(parsed.meta.name); }
  catch (e) { console.warn('[works] post-install agentTools registration failed:', e.message); }

  return { name: parsed.meta.name, version: parsed.meta.version, libPath: result.libPath, integrityOk: parsed.integrity.ok };
}

// ── Tree drag-to-move ───────────────────────────────────────────────

const DND_MIME = 'application/x-works-tree-path';

// Tell every surface iframe a tree-row drag is in flight. Used by
// surfaces (doc, etc.) that want to drop-insert based on the dragged
// VFS path — postMessage crosses the opaque-origin boundary that
// blocks custom DataTransfer MIMEs across the file:// → blob:null
// gap. Surfaces opt in by listening for 'tree-drag-start' / 'tree-
// drag-end' on window.
function _broadcastTreeDrag(type, path) {
  try {
    for (const f of document.querySelectorAll('iframe')) {
      try { f.contentWindow.postMessage({ type, path }, '*'); }
      catch { /* iframe not yet booted / cross-origin — skip */ }
    }
  } catch { /* document.querySelectorAll failed somehow — bail */ }
}

// Shell-side drag delegation for cross-origin iframes.
//
// Chromium does NOT fire dragover/drop events INSIDE cross-origin
// iframes when the drag source is the parent (anti-phishing). The
// events do fire on the iframe ELEMENT in the parent's view, though.
// So the shell handles drag-over and drop on behalf of every surface
// iframe and postMessages the result into the iframe with viewport-
// relative coordinates. Surfaces opt in by listening for 'tree-drop'
// on window.
//
// Activates only when a tree drag is in flight (_currentTreeDragPath
// is non-null). For other drags (OS files, etc.) the existing
// per-surface and global handlers do their thing.
let _currentTreeDragPath = null;
let _dragShields = [];

// During a tree-row drag, overlay a transparent same-origin div on
// top of each surface iframe. The shield catches dragover/drop in
// the SHELL document (same origin → no anti-phishing suppression).
// Without the shield, Chromium drops drag events the moment the
// cursor crosses into a cross-origin iframe — neither the parent
// nor the iframe see them. Classic workaround pattern; same shape
// libraries like react-dnd use for cross-frame DnD.
function _showDragShields() {
  _hideDragShields();
  for (const iframe of document.querySelectorAll('iframe')) {
    const rect = iframe.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const shield = document.createElement('div');
    shield.className = 'works-drag-shield';
    // 0.01 alpha rather than 'transparent' — Chromium skips hit-
    // testing on fully transparent overlays in some configurations
    // (especially over cross-origin iframes), so drag events sail
    // through to the iframe behind. A barely-there fill forces the
    // browser to treat the shield as a real paintable hit target.
    // Visually indistinguishable from transparent at 1% alpha.
    shield.style.cssText =
      'position:fixed;'
      + `left:${rect.left}px;top:${rect.top}px;`
      + `width:${rect.width}px;height:${rect.height}px;`
      + 'z-index:2147483647;'
      + 'background:rgba(0,0,0,0.01);';
    shield._iframe = iframe;
    document.body.appendChild(shield);
    _dragShields.push(shield);
  }
}
function _hideDragShields() {
  for (const s of _dragShields) s.remove();
  _dragShields = [];
}

function _installShellDragDelegation() {
  document.addEventListener('dragover', (e) => {
    if (!_currentTreeDragPath) return;
    // Shield (transparent same-origin overlay over an iframe) is the
    // common case; bare iframe element is the fallback for any future
    // surface that's same-origin and doesn't need a shield.
    const shield = e.target && e.target.closest && e.target.closest('.works-drag-shield');
    const iframe = shield ? shield._iframe
      : (e.target && e.target.closest && e.target.closest('iframe'));
    if (!iframe) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, /* useCapture */ true);
  document.addEventListener('drop', (e) => {
    if (!_currentTreeDragPath) return;
    const shield = e.target && e.target.closest && e.target.closest('.works-drag-shield');
    const iframe = shield ? shield._iframe
      : (e.target && e.target.closest && e.target.closest('iframe'));
    if (!iframe) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = iframe.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    try {
      iframe.contentWindow.postMessage({
        type: 'tree-drop',
        path: _currentTreeDragPath,
        x, y,
      }, '*');
    } catch { /* iframe gone — fine */ }
    _currentTreeDragPath = null;
    _hideDragShields();
  }, /* useCapture */ true);
}
// Install once at module-eval. (No DOM dependency at install time —
// the document listener attaches before any iframe exists.)
_installShellDragDelegation();

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
      // Shell-side delegation needs to know the dragged path so the
      // generic iframe-targeted dragover/drop handlers above can do
      // their work without re-reading dataTransfer.
      _currentTreeDragPath = node.path;
      // Cover every surface iframe with a transparent shield so the
      // shell sees drag events normally (Chromium drops drag events
      // over cross-origin iframes; the shield is same-origin and
      // intercepts cleanly).
      _showDragShields();
      // Cross-origin drag side channel: blob:null/<uuid> iframes get
      // a unique opaque origin and Chromium drops drag events inside
      // them entirely (anti-phishing). Broadcast the dragged path via
      // postMessage so surfaces have visibility into the in-flight
      // drag for UX affordances (e.g. highlighting a drop zone).
      _broadcastTreeDrag('tree-drag-start', node.path);
    });
    row.addEventListener('dragend', () => {
      _currentTreeDragPath = null;
      _hideDragShields();
      _broadcastTreeDrag('tree-drag-end', null);
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
