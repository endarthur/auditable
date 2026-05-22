// Re-export stub for VFS — used by globals.js and stdlib.js at dev/test time.
// At build time, processModulesAsRegistry rewrites './vfs.js' → '#vfs',
// and the actual VFS bundle (ext/vfs/index.js) is loaded via the import map.
export { VFS, VFSError, CommentBackend, MemoryBackend, AbusBackend, FSAABackend, IDBBackend, path } from '../../ext/vfs/index.js';
