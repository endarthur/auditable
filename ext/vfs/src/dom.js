// DOM helpers for @gcu/vfs — blob URLs, drag-drop, file picker
// Runtime guards: only functional in browser environments

const _blobCache = (typeof Map !== 'undefined') ? new Map() : null;
const _autoRevokeListeners = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

function toURL(vfs, p) {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined') {
    throw new Error('toURL requires a browser environment');
  }
  const key = p;
  if (_blobCache && _blobCache.has(key)) return _blobCache.get(key);

  // Set up auto-revoke listener once per VFS instance
  if (_autoRevokeListeners && !_autoRevokeListeners.has(vfs)) {
    const handler = (e) => {
      if (_blobCache && _blobCache.has(e.path)) {
        URL.revokeObjectURL(_blobCache.get(e.path));
        _blobCache.delete(e.path);
      }
    };
    vfs.on('write', handler);
    _autoRevokeListeners.set(vfs, handler);
  }

  return vfs.readFile(p, 'bytes').then(data => {
    const mimeType = path.mime(p);
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    if (_blobCache) _blobCache.set(key, url);
    return url;
  });
}

function revokeURL(url) {
  if (typeof URL === 'undefined') return;
  URL.revokeObjectURL(url);
  if (_blobCache) {
    for (const [k, v] of _blobCache) {
      if (v === url) { _blobCache.delete(k); break; }
    }
  }
}

function revokeURLs(prefix) {
  if (!_blobCache) return;
  const toDelete = [];
  for (const [k, v] of _blobCache) {
    if (k.startsWith(prefix)) {
      if (typeof URL !== 'undefined') URL.revokeObjectURL(v);
      toDelete.push(k);
    }
  }
  for (const k of toDelete) _blobCache.delete(k);
}

async function fromDrop(vfs, event, destPath) {
  const files = event.dataTransfer ? event.dataTransfer.files : [];
  const paths = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(destPath, file.name);
    const buf = await file.arrayBuffer();
    await vfs.writeFile(filePath, new Uint8Array(buf));
    paths.push(filePath);
  }
  return paths;
}

function fromPicker(vfs, destPath, opts) {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('fromPicker requires a browser environment'));
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts && opts.multiple) input.multiple = true;
    if (opts && opts.accept) input.accept = opts.accept;
    if (opts && opts.directory) input.webkitdirectory = true;

    input.onchange = async () => {
      try {
        const paths = [];
        for (let i = 0; i < input.files.length; i++) {
          const file = input.files[i];
          const filePath = path.join(destPath, file.name);
          const buf = await file.arrayBuffer();
          await vfs.writeFile(filePath, new Uint8Array(buf));
          paths.push(filePath);
        }
        resolve(paths);
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}

export { toURL, revokeURL, revokeURLs, fromDrop, fromPicker, _blobCache };
