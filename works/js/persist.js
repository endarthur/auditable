// Single-file workspace export / import — auditable-works-spec §12.3.
//
// A workspace serialises to one self-contained HTML: the works.html runtime
// plus the workspace VFS (/projects + /lib + /home) as a gzip+base64
// WORKS-VFS comment block. Opening that file boots the desktop over the
// embedded workspace — a portable, offline snapshot.

import { WKS, setStatus } from './state.js';
import { chooseExport } from './export-dialog.js';
import { diskFromDump } from './disk.js';

const BLOCK_RE = /<!--WORKS-VFS\n([\s\S]*?)\nWORKS-VFS-->/;
// Mounts that travel with a workspace export.
//   /projects — user notebooks
//   /lib      — installed extensions (gcupkgs, lockfile)
//   /home     — user files + Works state (e.g. /home/.works/layout.json)
//   /etc      — workspace settings (theme, font, text-editor prefs);
//               settings-store.js's contract is "what should travel with
//               the workspace export"
//
// Deliberately excluded:
//   /sys, /usr — volatile, rebuilt by the shell at boot from build payloads
//   /tmp       — scratch
//   /mnt/<x>   — disk-folder mounts; FileSystemDirectoryHandles can't roam
const PERSISTENT = ['/projects', '/lib', '/home', '/etc'];

function _bytesToB64(bytes) {
  // Chunked so the WORKS-VFS gzip blob (multi-MB) doesn't blow the
  // fromCharCode argument limit or quadratic single-char concatenation.
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
function _b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// gzip the dump before base64 — the VFS snapshot is text-heavy (notebooks,
// book markdown/html) and compresses ~1.4× even with base64'd images in the
// mix. gzip (not brotli) because DecompressionStream('br') still throws in
// Chromium. Older exports are plain base64 (no GZIP_TAG) and still load.
const GZIP_TAG = 'gz:';
async function _gzipBytes(bytes) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function _gunzipBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// ── Serialize ────────────────────────────────────────────────────────

async function _walk(vfs, dir, dump) {
  let entries;
  try { entries = await vfs.readdir(dir, { stat: true }); }
  catch { return; }
  if (entries.length === 0) { dump[dir + '/'] = { type: 'directory' }; return; }
  for (const e of entries) {
    const full = dir + '/' + e.name;
    if (e.type === 'directory') { await _walk(vfs, full, dump); continue; }
    const bytes = await vfs.readFile(full, 'bytes');
    let content, kind;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      kind = 'text';
    } catch {
      content = _bytesToB64(bytes);
      kind = 'binary';
    }
    dump[full] = { type: 'file', kind, content };
  }
}

/** Walk the persistent workspace mounts into a flat { path → entry } dump. */
export async function serializeWorkspace(vfs) {
  const dump = {};
  for (const mount of PERSISTENT) await _walk(vfs, mount, dump);
  return dump;
}

/** Write a { path → entry } dump back into a VFS. */
export async function hydrateWorkspace(vfs, dump) {
  for (const [p, entry] of Object.entries(dump)) {
    if (entry.type === 'directory') {
      await vfs.mkdir(p.replace(/\/$/, ''), { recursive: true }).catch(() => {});
      continue;
    }
    const parent = p.split('/').slice(0, -1).join('/') || '/';
    await vfs.mkdir(parent, { recursive: true }).catch(() => {});
    await vfs.writeFile(p, entry.kind === 'binary' ? _b64ToBytes(entry.content) : entry.content);
  }
}

/** Parse an embedded WORKS-VFS block from page HTML, or null. Async — the
 *  gzip path needs DecompressionStream. */
export async function detectWorkspaceBlock(html) {
  const m = html.match(BLOCK_RE);
  if (!m) return null;
  try {
    const raw = m[1].replace(/\s/g, '');
    let json;
    if (raw.startsWith(GZIP_TAG)) {
      const bytes = await _gunzipBytes(_b64ToBytes(raw.slice(GZIP_TAG.length)));
      json = new TextDecoder('utf-8').decode(bytes);
    } else {
      json = decodeURIComponent(escape(atob(raw)));   // legacy plain-base64 exports
    }
    return JSON.parse(json);
  } catch (e) {
    console.error('[works] WORKS-VFS block parse failed:', e);
    return null;
  }
}

// ── Export categories ────────────────────────────────────────────────
// Every persistent path falls into exactly one category. Re-installable
// categories (library, extensions) can travel as a tiny recipe instead of
// their bulk: `pkg install` restores /lib from the kept lockfile, and the
// shell restores /home/.books/library from the kept .installed.json (the
// boot-time executor is Phase 3). `keepInReinstall` is the set of small
// files that must stay so the recipe can run + reading state survives.
export const EXPORT_CATEGORIES = [
  { id: 'library', label: 'Library content', reinstallable: true,
    hint: 'Books & datasets from gcu-library',
    match: (p) => p.startsWith('/home/.books/'),
    // Keep the install registry + reading state; drop the bulk. NOTE (Phase 3):
    // a locally-added book under /home/.books/library that isn't in
    // .installed.json has no recipe entry — the boot executor should detect
    // un-restorable library dirs and keep them bundled rather than drop them.
    keepInReinstall: (p) => p === '/home/.books/.installed.json'
      || p.startsWith('/home/.books/state/') },
  { id: 'extensions', label: 'Installed extensions', reinstallable: true,
    hint: 'gcupkg modules — pkg install restores them',
    match: (p) => p.startsWith('/lib/'),
    keepInReinstall: (p) => p === '/lib/.gcu-lock.json' },
  { id: 'projects', label: 'Projects', reinstallable: false,
    hint: 'Your notebooks',
    match: (p) => p.startsWith('/projects/') && !/\/notebook\.outputs\//.test(p) },
  { id: 'outputs', label: 'Project outputs', reinstallable: false,
    hint: 'Cached cell outputs — recomputable by re-running',
    match: (p) => /^\/projects\/.*\/notebook\.outputs\//.test(p) },
  { id: 'home', label: 'Home files', reinstallable: false,
    hint: 'Loose files in /home',
    match: (p) => p.startsWith('/home/') && !p.startsWith('/home/.books/')
      && !p.startsWith('/home/.works/') },
  { id: 'state', label: 'Workspace state', reinstallable: false,
    hint: 'Layout, theme, editor prefs',
    match: (p) => p.startsWith('/home/.works/') || p.startsWith('/etc/') },
  { id: 'other', label: 'Other', reinstallable: false,
    hint: 'Anything else',
    match: () => true },
];

export function categoryOf(path) {
  for (const c of EXPORT_CATEGORIES) if (c.match(path)) return c.id;
  return 'other';
}

/** Group a dump by category with content-byte sizes (used by the dialog). */
export function categorizeDump(dump) {
  const by = new Map(EXPORT_CATEGORIES.map((c) =>
    [c.id, { id: c.id, label: c.label, hint: c.hint, reinstallable: c.reinstallable, count: 0, rawBytes: 0 }]));
  for (const [p, e] of Object.entries(dump)) {
    const cat = by.get(categoryOf(p));
    cat.count++;
    cat.rawBytes += (e && typeof e.content === 'string') ? e.content.length : 0;
  }
  return EXPORT_CATEGORIES.map((c) => by.get(c.id)).filter((c) => c.count > 0);
}

/**
 * Filter a dump for export. `bundled` is the set of category ids whose files
 * travel in full. A re-installable category not in `bundled` travels as a
 * recipe (its manifest + reading state kept, bulk dropped) and gets recorded
 * in /home/.works/reinstall.json (+ reinstall.geas when `emitGeas`). A
 * non-re-installable category not in `bundled` is dropped entirely.
 */
export function applyExportSelection(dump, { bundled, emitGeas } = {}) {
  const keep = bundled instanceof Set ? bundled
    : new Set(bundled || EXPORT_CATEGORIES.map((c) => c.id));
  const cats = new Map(EXPORT_CATEGORIES.map((c) => [c.id, c]));
  const out = {};
  const reinstall = [];
  for (const [p, e] of Object.entries(dump)) {
    const id = categoryOf(p);
    if (keep.has(id)) { out[p] = e; continue; }
    const c = cats.get(id);
    if (c && c.reinstallable) {
      if (c.keepInReinstall && c.keepInReinstall(p)) out[p] = e;
      if (!reinstall.includes(id)) reinstall.push(id);
    }
    // else: omit entirely
  }
  if (reinstall.length) {
    const recipe = buildReinstallRecipe(dump, reinstall);
    out['/home/.works/reinstall.json'] = {
      type: 'file', kind: 'text', content: JSON.stringify(recipe, null, 2) };
    if (emitGeas) out['/home/.works/reinstall.geas'] = {
      type: 'file', kind: 'text', content: _buildReinstallGeas(recipe) };
  }
  return out;
}

/** Read the kept manifests to describe what an importer should reinstall. */
export function buildReinstallRecipe(dump, reinstallIds) {
  const recipe = { version: 1,
    note: 'Generated by Works export — content set to reinstall on open.' };
  if (reinstallIds.includes('extensions')) {
    let lock = null;
    try { lock = JSON.parse(dump['/lib/.gcu-lock.json']?.content || 'null'); } catch { /* */ }
    recipe.extensions = lock && lock.modules
      ? Object.values(lock.modules)
          .filter((m) => m && m.kind === 'gcupkg' && /^(https?|npm|jsr|gh|local):/.test(m.url || ''))
          .map((m) => ({ alias: m.alias, url: m.url, version: m.version,
            integrity: (m.gcupkg && m.gcupkg.integrity) || m.integrity }))
      : [];
  }
  if (reinstallIds.includes('library')) {
    let inst = null;
    try { inst = JSON.parse(dump['/home/.books/.installed.json']?.content || 'null'); } catch { /* */ }
    recipe.library = inst
      ? Object.entries(inst).map(([id, m]) => ({ id, source: m.source,
          version: m.version, integrity: m.integrity, datKind: m.datKind }))
      : [];
  }
  return recipe;
}

function _buildReinstallGeas(recipe) {
  const out = ['# Auditable Works — reinstall recipe (generated)',
    '# Run in a Works terminal to restore content omitted from the export.', ''];
  if (recipe.extensions && recipe.extensions.length) {
    out.push('# Extensions — the lockfile travels with the workspace:', 'pkg install', '');
  }
  if (recipe.library && recipe.library.length) {
    out.push('# Library packs (restored by the shell from .installed.json):');
    for (const b of recipe.library) out.push(`#   ${b.id} ${b.version || ''} <- ${b.source || ''}`);
    out.push('');
  }
  return out.join('\n');
}

// ── Export ───────────────────────────────────────────────────────────

// Reconstruct a self-contained works HTML from the live page + a dump.
export async function buildWorksHtml(dump) {
  const clone = document.documentElement.cloneNode(true);
  // Reset the rendered desktop to the empty template — the next boot
  // re-renders into these containers.
  for (const id of ['works-menubar', 'works-tree', 'works-rails']) {
    const el = clone.querySelector('#' + id);
    if (el) el.innerHTML = '';
  }
  const status = clone.querySelector('#works-status');
  if (status) status.textContent = 'starting…';
  clone.querySelectorAll('.works-reconnect').forEach((el) => el.remove());

  const gz = await _gzipBytes(new TextEncoder().encode(JSON.stringify(dump)));
  const b64 = (GZIP_TAG + _bytesToB64(gz)).replace(/.{1,76}/g, '$&\n');
  const block = '<!-- auditable works: workspace VFS snapshot (gzip+base64) -->\n'
    + '<!--WORKS-VFS\n' + b64 + '\nWORKS-VFS-->';

  let html = '<!DOCTYPE html>\n' + clone.outerHTML;
  // Drop any prior snapshot (re-exporting an imported workspace), then embed
  // the fresh one just before the runtime <script>.
  html = html.replace(BLOCK_RE, '')
             .replace(/<!-- auditable works: workspace VFS snapshot[^>]*-->\n/, '')
             .replace('<script>', block + '\n<script>');
  return html;
}

function _download(data, name, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Serialize the workspace and download it — one self-contained HTML, or a
 *  .gcudsk disk image, per the export dialog's chosen target. */
export async function exportWorkspace() {
  try {
    const dump = await serializeWorkspace(WKS.vfs);
    const selection = await chooseExport(dump);   // null → user cancelled
    if (!selection) { setStatus('export cancelled'); return; }
    const filtered = applyExportSelection(dump, selection);
    if (selection.target === 'disk') {
      const bytes = await diskFromDump(filtered, { kind: 'workspace' });
      _download(bytes, 'workspace.gcudsk', 'application/octet-stream');
      setStatus('workspace exported (.gcudsk)');
    } else {
      _download(await buildWorksHtml(filtered), 'workspace.html', 'text/html');
      setStatus('workspace exported');
    }
  } catch (e) {
    console.error('[works] export failed:', e);
    setStatus('export failed: ' + (e.message || e));
  }
}

// ── Import ───────────────────────────────────────────────────────────

/** Pick a workspace HTML file and open it — it is self-booting. */
export function openWorkspaceFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,text/html';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) location.href = URL.createObjectURL(file);
  };
  input.click();
}

// ── Save — the flush barrier ─────────────────────────────────────────

/**
 * The Save command. The storage home is durable, so this is just the flush
 * barrier (spec §12.2): ask every open surface to flush, each with a
 * generous timeout so one slow surface can't deadlock the save.
 */
export async function saveWorkspace() {
  await Promise.all([...WKS.surfaces.values()].map((rec) =>
    Promise.race([
      WKS.worksBus.call(
        { to: rec.uniqueName, path: '/', interface: 'Surface', member: 'Flush' }, []),
      new Promise((r) => setTimeout(r, 5000)),
    ]).catch(() => {})));
  setStatus('saved');
}
