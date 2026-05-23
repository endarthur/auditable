// Shell-level metadata store — a tiny IndexedDB key-value, separate from
// the workspace VFS, for things the shell needs across reloads but doesn't
// want in the workspace itself: the saved workspace-folder handle, the
// saved mount list, etc. File handles are structured-cloneable, so they go
// in here too.

const META_DB = 'auditable-works-meta';

function _db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function metaGet(key) {
  const db = await _db();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function metaSet(key, value) {
  const db = await _db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
