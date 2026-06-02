// Single-file workspace export / import — auditable-works-spec §12.3.
//
// A workspace serialises to one self-contained HTML: the works.html runtime
// plus the workspace VFS (/projects + /lib + /home) as a gzip+base64
// WORKS-VFS comment block. Opening that file boots the desktop over the
// embedded workspace — a portable, offline snapshot.

import { WKS, setStatus } from './state.js';

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

/** Serialize the workspace and download it as one self-contained HTML. */
export async function exportWorkspace() {
  try {
    const dump = await serializeWorkspace(WKS.vfs);
    const blob = new Blob([await buildWorksHtml(dump)], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'workspace.html';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('workspace exported');
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
