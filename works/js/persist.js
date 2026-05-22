// Single-file workspace export / import — auditable-works-spec §12.3.
//
// A workspace serialises to one self-contained HTML: the works.html runtime
// plus the workspace VFS (/projects + /lib + /home) as a base64 WORKS-VFS
// comment block. Opening that file boots the desktop over the embedded
// workspace — a portable, offline snapshot.

import { WKS, setStatus } from './state.js';

const BLOCK_RE = /<!--WORKS-VFS\n([\s\S]*?)\nWORKS-VFS-->/;
const PERSISTENT = ['/projects', '/lib', '/home'];

function _bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function _b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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

/** Parse an embedded WORKS-VFS block from page HTML, or null. */
export function detectWorkspaceBlock(html) {
  const m = html.match(BLOCK_RE);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/\s/g, '')))));
  } catch (e) {
    console.error('[works] WORKS-VFS block parse failed:', e);
    return null;
  }
}

// ── Export ───────────────────────────────────────────────────────────

// Reconstruct a self-contained works HTML from the live page + a dump.
export function buildWorksHtml(dump) {
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

  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(dump))))
    .replace(/.{1,76}/g, '$&\n');
  const block = '<!-- auditable works: workspace VFS snapshot -->\n'
    + '<!--WORKS-VFS\n' + b64 + '\nWORKS-VFS-->';

  let html = '<!DOCTYPE html>\n' + clone.outerHTML;
  // Drop any prior snapshot (re-exporting an imported workspace), then embed
  // the fresh one just before the runtime <script>.
  html = html.replace(BLOCK_RE, '')
             .replace('<!-- auditable works: workspace VFS snapshot -->\n', '')
             .replace('<script>', block + '\n<script>');
  return html;
}

/** Serialize the workspace and download it as one self-contained HTML. */
export async function exportWorkspace() {
  try {
    const dump = await serializeWorkspace(WKS.vfs);
    const blob = new Blob([buildWorksHtml(dump)], { type: 'text/html' });
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
