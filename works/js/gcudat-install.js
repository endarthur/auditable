// .gcudat install — GCU data-pack consumer.
//
// A .gcudat is the inert-data counterpart to the executable .gcupkg: a
// container ({ manifest + file tree }) of pure, NON-EXECUTABLE data, routed by
// a `kind` discriminator. We never eval anything from a .gcudat — that's the
// whole reason it's separate from .gcupkg. Container-agnostic: the manifest
// (gcudat.json at the root) is the discriminator, so a .tgz, a .zip, or a bare
// directory all work; detection is by the manifest, not the extension.
//
// Format spec: ext/EXTENSION_SPEC.md (§ .gcudat). Producer: gcu-library.

import { WKS, setStatus } from './state.js';
import { gunzipBytes, listTar, readTar, listZip, readZip } from '#archive';
import { openPath } from './surfaces.js';

const norm = (p) => String(p).replace(/^\.\//, '').replace(/^\/+/, '');
const TEXT_EXT = /\.(html?|json|md|markdown|css|txt|svg|csv|js|mjs|xml)$/i;

// ── install ledger ──────────────────────────────────────────────────
// Records what's installed + at which version, so the Library can offer
// updates. A .gcudat manifest carries its own `version` (self-describing), so
// even direct (non-registry) installs record one. Lives in the VFS — it
// travels with the workspace on export. Reading state (highlights/position)
// lives separately under /home/.books/state/, so reinstalls never touch it.
const LEDGER = '/home/.books/.installed.json';
export async function getInstalled() {
  try { return JSON.parse(await WKS.vfs.readFile(LEDGER, 'utf8')) || {}; } catch { return {}; }
}
async function writeLedger(map) {
  await WKS.vfs.mkdir('/home/.books', { recursive: true }).catch(() => {});
  await WKS.vfs.writeFile(LEDGER, JSON.stringify(map, null, 2));
}
// Merge fields into an existing record (used by the registry layer to attach
// source + integrity after a registry install).
export async function patchInstalled(name, fields) {
  const map = await getInstalled();
  map[name] = { ...(map[name] || {}), ...fields };
  await writeLedger(map);
}

// Read a container (by magic byte): gzip'd-tar, plain tar, or zip. Returns
// { files: Map<normPath, origPath>, read(origPath) → Promise<Uint8Array> }.
// gunzipBytes is async (DecompressionStream); the rest may be sync — await is
// harmless either way.
async function openContainer(bytes) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;        // 'PK'
  let tar = bytes;
  if (!isZip && bytes[0] === 0x1f && bytes[1] === 0x8b) tar = await gunzipBytes(bytes); // gzip
  const list = await (isZip ? listZip(bytes) : listTar(tar));
  const files = new Map();
  for (const e of list) if (e.type === 'file') files.set(norm(e.path), e.path);
  const read = (orig) => (isZip ? readZip(bytes, orig) : readTar(tar, orig));
  return { files, read };
}

// kind → handler(manifest, container, name) → installed dir path. Pure data;
// handlers only write files to the VFS, never execute.
const KIND_HANDLERS = {
  async books(manifest, c, vfs) {
    const dest = '/home/.books/library/' + (manifest.name || 'book');
    // Clean-replace: drop the old book dir so a reinstall/update can't leave
    // stale files behind (renamed/removed chapters). Reading state is under
    // /home/.books/state/, a sibling — untouched.
    await vfs.rm(dest, { recursive: true }).catch(() => {});
    for (const [n, orig] of c.files) {
      if (n === 'gcudat.json') continue;                       // drop the pack manifest
      const full = dest + '/' + n;
      const dir = full.slice(0, full.lastIndexOf('/'));
      await vfs.mkdir(dir, { recursive: true }).catch(() => {});
      const data = await c.read(orig);
      await vfs.writeFile(full, TEXT_EXT.test(n) ? new TextDecoder().decode(data) : data);
    }
    return dest;
  },
};

// Install .gcudat bytes → returns the opened path (or null). Status bar reports
// failures. Detection + validation are by the manifest only.
export async function installGcudatBytes(bytes, filename) {
  const vfs = WKS.vfs;
  let c;
  try { c = await openContainer(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  catch (e) { setStatus('data pack: unreadable container — ' + (e.message || e)); return null; }

  const manifestOrig = c.files.get('gcudat.json');
  if (!manifestOrig) { setStatus('not a .gcudat (no gcudat.json) — ' + (filename || '')); return null; }
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(await c.read(manifestOrig))); }
  catch (e) { setStatus('data pack: bad gcudat.json — ' + (e.message || e)); return null; }
  if (!manifest.gcudat) { setStatus('data pack: gcudat.json missing version key'); return null; }

  const handler = KIND_HANDLERS[manifest.kind];
  if (!handler) { setStatus('data pack: no handler for kind "' + manifest.kind + '"'); return null; }

  let dest;
  try { dest = await handler(manifest, c, vfs); }
  catch (e) { setStatus('data pack install failed: ' + (e.message || e)); return null; }
  // Record in the ledger (manifest-derived fields). The registry layer patches
  // source + integrity on top for registry installs.
  try {
    await patchInstalled(manifest.name, {
      version: manifest.version || '', kind: 'gcudat', datKind: manifest.kind,
      title: manifest.title || manifest.name, dest, at: Date.now(),
    });
  } catch { /* ledger is best-effort */ }
  setStatus('installed ' + (manifest.title || manifest.name || filename) + ' (' + manifest.kind + ')');
  return dest;
}

// File → Install data pack… — OS file picker, then install + open.
export async function installGcudatViaPicker() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.gcudat,.zip,.tgz,application/gzip,application/zip';
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const dest = await installGcudatBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    if (dest) await openPath(dest);
  });
  inp.click();
}
