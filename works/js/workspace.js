// The workspace VFS — the one filesystem the whole desktop shares.
//
// Three mounts (auditable-works-spec §7.2): one persistent backend at `/`
// — the storage home — inside which `projects/`, `lib/`, `home/` are
// ordinary directories; plus volatile MemoryBackend overlays at `/scratch`
// and `/sys`.
//
// The storage home is IndexedDB-backed, so the workspace — projects, files,
// the rails layout — survives a reload. The disk-folder (FSAA) storage
// home and single-file export/import are the remaining persistence work.

import { VFS } from '#vfs';
import { WKS } from './state.js';

export async function setupWorkspace() {
  const vfs = await VFS.create({
    backends: {
      '/':        { type: 'idb', name: 'auditable-works' },  // persistent
      '/scratch': { type: 'memory' },                        // volatile
      '/sys':     { type: 'memory' },                        // volatile
    },
  });

  // Standard directories inside the storage home (idempotent — they
  // persist across reloads). /home/.works holds the shell's own state.
  for (const dir of ['/projects', '/lib', '/home', '/home/.works']) {
    try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  }

  WKS.vfs = vfs;
}
