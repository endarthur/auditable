// The workspace VFS — the one filesystem the whole desktop shares.
//
// Three mounts (auditable-works-spec §7.2): one persistent backend at `/`
// — the storage home — inside which `projects/`, `lib/`, `home/` are
// ordinary directories; plus volatile MemoryBackend overlays at `/scratch`
// and `/sys`.
//
// Chunk 1 uses a MemoryBackend storage home (fresh each load). The durable
// backends — browser IndexedDB and a disk folder — arrive with persistence
// (Chunk 5).

import { VFS, MemoryBackend } from '#vfs';
import { WKS } from './state.js';

export async function setupWorkspace() {
  const vfs = new VFS();
  vfs._mounts.set('/', new MemoryBackend());          // storage home
  vfs._mounts.set('/scratch', new MemoryBackend());   // volatile
  vfs._mounts.set('/sys', new MemoryBackend());       // volatile

  // Standard top-level directories inside the storage home.
  for (const dir of ['/projects', '/lib', '/home']) {
    await vfs.mkdir(dir, { recursive: true });
  }

  WKS.vfs = vfs;
}
