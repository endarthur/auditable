// A tiny IndexedDB sidecar for lamina block indexes. Keyed by fileKey (name +
// size + mtime); value = { detect, index }. Reopening a file we've seen skips the
// scan entirely — instant even for a tens-of-GB file whose index took minutes to
// build the first time. Best-effort: any IDB failure (private mode, quota) just
// degrades to a re-scan, never throws. The harness injects this; a Works @gcu/lamina
// surface would swap a VFS sidecar with the same { get, set } shape.

const DB = 'lamina', STORE = 'index', VER = 1;
let _db;

function open() {
  return (_db ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const idbCache = {
  async get(key) { try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; } },
  async set(key, val) { try { await tx('readwrite', (s) => s.put(val, key)); } catch { /* best-effort */ } },
  async clear() { try { await tx('readwrite', (s) => s.clear()); } catch { /* best-effort */ } },
};
