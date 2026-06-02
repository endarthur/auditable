// .gcudsk — a portable disk image. A ZIP archive of a VFS subtree (binary
// files stored raw, text deflated) plus a disk.json manifest. It carries the
// same payload as an embedded WORKS-VFS export but without the base64 tax
// (~25% smaller) and as a separate file you can carry, share, version, or
// mount — and, being a ZIP, it's inspectable with any zip tool and supports
// random access (read one file without unpacking the rest).
//
// A .gcudsk FILE is a disk image; MOUNTING one surfaces a VOLUME at
// /mnt/<name> (you mount a disk, a volume appears — same as a real OS). Three
// operations: export to one (export-dialog → persist.exportWorkspace), open
// one as the workspace (fresh reload boot), or mount one as a volume.

import { WKS, setStatus } from './state.js';
import { MemoryBackend } from '#vfs';
import { archive } from '#archive';
import { metaGet, metaSet } from './meta.js';

const PENDING_KEY = 'pending-disk-open';
const _b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ── Write ────────────────────────────────────────────────────────────

/** Build a .gcudsk (zip bytes) from a { path → entry } dump (serializeWorkspace
 *  shape). Binary entries (base64 in the dump) are stored raw in the zip. */
export async function diskFromDump(dump, meta = {}) {
  const manifest = {
    format: 'gcudsk', version: 1,
    kind: meta.kind || 'workspace',
    root: meta.root || '/',
    created: new Date().toISOString(),
    generator: 'auditable-works',
    ...(meta.extra || {}),
  };
  const entries = { 'disk.json': JSON.stringify(manifest, null, 2) };
  for (const [p, e] of Object.entries(dump)) {
    const rel = p.replace(/^\/+/, '');
    if (e.type === 'directory') { entries[rel.endsWith('/') ? rel : rel + '/'] = new Uint8Array(0); continue; }
    entries[rel] = e.kind === 'binary' ? _b64ToBytes(e.content) : e.content;
  }
  const out = await archive.compress(entries, 'memory', { format: 'zip', level: 9 });
  return [...out.values()][0];
}

// ── Read ─────────────────────────────────────────────────────────────

/** Parse the disk.json manifest from a .gcudsk, or null. */
export async function readDiskManifest(zipBytes) {
  try {
    const b = await archive.read(zipBytes, 'disk.json');
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  } catch { return null; }
}

/** Populate `vfs` from a .gcudsk. `root` prefixes every entry ('' = at root). */
export async function hydrateVfsFromDisk(vfs, zipBytes, { root = '' } = {}) {
  const list = await archive.list(zipBytes);
  for (const en of list) {
    if (en.path === 'disk.json') continue;
    const isDir = en.type === 'directory' || en.path.endsWith('/');
    const dest = (root + '/' + en.path).replace(/\/+/g, '/');
    if (isDir) { await vfs.mkdir(dest.replace(/\/$/, ''), { recursive: true }).catch(() => {}); continue; }
    const parent = dest.split('/').slice(0, -1).join('/') || '/';
    await vfs.mkdir(parent, { recursive: true }).catch(() => {});
    const bytes = await archive.read(zipBytes, en.path);
    if (bytes) await vfs.writeFile(dest, bytes);
  }
}

// ── Mount ────────────────────────────────────────────────────────────

function _uniqueMountName(base) {
  base = String(base || 'disk').replace(/\.gcudsk$/i, '').replace(/[/\\]+/g, '-') || 'disk';
  const taken = new Set([...WKS.vfs._mounts.keys()]
    .filter((m) => m.startsWith('/mnt/')).map((m) => m.slice(5)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(base + '-' + n)) return base + '-' + n;
}

/** Mount a .gcudsk as a volatile volume at /mnt/<name>. Returns the path.
 *  Volatile (a MemoryBackend) — the disk file isn't re-read on reload, so
 *  unlike a /mnt disk folder it doesn't persist in the mount list. */
export async function mountDisk(zipBytes, suggestedName) {
  const name = _uniqueMountName(suggestedName);
  const mountPath = '/mnt/' + name;
  await WKS.vfs.mkdir('/mnt', { recursive: true }).catch(() => {});
  await WKS.vfs.mount(mountPath, new MemoryBackend());
  await hydrateVfsFromDisk(WKS.vfs, zipBytes, { root: mountPath });
  return mountPath;
}

// ── Open as workspace (reload boot) ──────────────────────────────────

/** Stash a disk for a fresh-boot open, then reload — setupWorkspace consumes
 *  it before any storage home, hydrating it into a volatile memory workspace
 *  exactly like an imported embedded-HTML workspace. */
export async function openDiskAsWorkspace(zipBytes) {
  await metaSet(PENDING_KEY, zipBytes);
  location.reload();
}

/** Boot hook: if a disk-open is pending, return its bytes (and clear it). */
export async function consumePendingDisk() {
  let bytes = null;
  try { bytes = await metaGet(PENDING_KEY); } catch { /* */ }
  if (bytes) await metaSet(PENDING_KEY, undefined).catch(() => {});
  return bytes || null;
}

// ── File pickers ─────────────────────────────────────────────────────

function _pickDisk() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.gcudsk';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) { resolve(null); return; }
      resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.click();
  });
}

/** File → Open disk… — pick a .gcudsk and boot it as the workspace. */
export async function openDiskFile() {
  const picked = await _pickDisk();
  if (!picked) return;
  setStatus('opening ' + picked.name + '…');
  await openDiskAsWorkspace(picked.bytes);
}

/** File → Mount disk… — pick a .gcudsk and mount it at /mnt/<name>. */
export async function mountDiskFile() {
  const picked = await _pickDisk();
  if (!picked) return;
  try {
    const mp = await mountDisk(picked.bytes, picked.name);
    setStatus('mounted ' + picked.name + ' at ' + mp);
  } catch (e) {
    console.error('[works] mount disk failed:', e);
    setStatus('mount failed: ' + (e.message || e));
  }
}
