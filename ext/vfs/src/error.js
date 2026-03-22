const VFS_ERROR_MESSAGES = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  ENOSPC: 'no space left on device',
  EACCES: 'permission denied',
  EXDEV: 'cross-device link',
  ENOTSUP: 'operation not supported',
};

class VFSError extends Error {
  constructor(code, path, message) {
    const msg = message || `${VFS_ERROR_MESSAGES[code] || code}: ${path}`;
    super(msg);
    this.code = code;
    this.path = path;
    this.name = 'VFSError';
  }
}

function vfsError(code, path, detail) {
  const base = VFS_ERROR_MESSAGES[code] || code;
  const msg = detail ? `${base}: ${path} (${detail})` : `${base}: ${path}`;
  return new VFSError(code, path, msg);
}

export { VFSError, vfsError, VFS_ERROR_MESSAGES };
