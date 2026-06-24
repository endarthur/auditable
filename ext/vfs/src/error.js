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
  EBUSY: 'resource busy or rate-limited',
  EIO: 'input/output error',
};

class VFSError extends Error {
  // `extra` (optional) carries backend-specific fields onto the error — e.g. DropboxBackend
  // attaches { retryAfterMs } on EBUSY and { failed } on a partial batch.
  constructor(code, path, message, extra) {
    const msg = message || `${VFS_ERROR_MESSAGES[code] || code}: ${path}`;
    super(msg);
    this.code = code;
    this.path = path;
    this.name = 'VFSError';
    if (extra) Object.assign(this, extra);
  }
}

function vfsError(code, path, detail) {
  const base = VFS_ERROR_MESSAGES[code] || code;
  const msg = detail ? `${base}: ${path} (${detail})` : `${base}: ${path}`;
  return new VFSError(code, path, msg);
}

export { VFSError, vfsError, VFS_ERROR_MESSAGES };
