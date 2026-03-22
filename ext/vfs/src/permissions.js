import { vfsError } from './error.js';
import { path } from './path.js';

const READ_OPS = new Set(['read', 'readFile', 'readdir', 'stat', 'lstat', 'exists',
  'createReadStream', 'glob', 'du', 'export', 'readlink']);
const WRITE_OPS = new Set(['write', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'rename',
  'cp', 'touch', 'chmod', 'chown', 'symlink', 'rm', 'import', 'createWriter', 'writeFrom']);

function checkPermission(operation, p, principal, meta) {
  // No principal → unrestricted
  if (!principal) return;

  const normalized = path.normalize(p);
  const isRead = READ_OPS.has(operation) || operation === 'read';
  const isWrite = WRITE_OPS.has(operation) || operation === 'write';

  // Prefix check
  if (principal.prefixes) {
    const matched = principal.prefixes.some(prefix => {
      const normPrefix = prefix.startsWith('/') ? prefix : '/' + prefix;
      return normalized === normPrefix || normalized.startsWith(normPrefix.endsWith('/') ? normPrefix : normPrefix + '/');
    });
    const readOnlyMatch = principal.readOnlyPrefixes && principal.readOnlyPrefixes.some(prefix => {
      const normPrefix = prefix.startsWith('/') ? prefix : '/' + prefix;
      return normalized === normPrefix || normalized.startsWith(normPrefix.endsWith('/') ? normPrefix : normPrefix + '/');
    });

    if (!matched && !readOnlyMatch) {
      throw vfsError('EACCES', p, 'path not in allowed prefixes');
    }

    // Read-only prefix check
    if (readOnlyMatch && !matched && isWrite) {
      throw vfsError('EACCES', p, 'read-only prefix');
    }
    // If only matched via readOnlyPrefixes, writes are denied
    if (readOnlyMatch && matched) {
      // Matched in both — regular prefix takes precedence (rw)
    } else if (readOnlyMatch && isWrite) {
      throw vfsError('EACCES', p, 'read-only prefix');
    }
  }

  // Mode bit check — agent is always "other"
  if (meta && meta.mode !== undefined) {
    const otherBits = meta.mode & 0o7;
    if (isRead && !(otherBits & 0o4)) {
      throw vfsError('EACCES', p, 'mode bits deny read');
    }
    if (isWrite && !(otherBits & 0o2)) {
      throw vfsError('EACCES', p, 'mode bits deny write');
    }
  }
}

export { checkPermission };
