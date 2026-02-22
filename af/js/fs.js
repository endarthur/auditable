// ── FILESYSTEM ──
// Unified interface for FSAA (real directories) and box (IndexedDB virtual FS) backends

// ── IndexedDB helpers ──

const DB_NAME = 'auditable-files';
const DB_VERSION = 2;

function openDB() {
  if (AFS.db) return Promise.resolve(AFS.db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('boxes')) {
        db.createObjectStore('boxes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state');
      }
      if (!db.objectStoreNames.contains('storage')) {
        db.createObjectStore('storage');
      }
    };
    req.onsuccess = () => { AFS.db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

function dbTx(store, mode = 'readonly') {
  return AFS.db.transaction(store, mode).objectStore(store);
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = dbTx(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const req = dbTx(store, 'readwrite').put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = dbTx(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = dbTx(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── FSAA backend ──

async function fsaaOpen() {
  const dirHandle = await showDirectoryPicker({ mode: 'readwrite' });
  return {
    type: 'fsaa',
    name: dirHandle.name,
    dirHandle,
  };
}

async function fsaaWalk(dirHandle, prefix = '') {
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue;
    const path = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'directory') {
      const children = await fsaaWalk(handle, path);
      entries.push({ name, kind: 'directory', path, handle, children });
    } else {
      entries.push({ name, kind: 'file', path, handle, children: [] });
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function fsaaRead(fileHandle) {
  const file = await fileHandle.getFile();
  return file.text();
}

async function fsaaWrite(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function fsaaCreate(dirHandle, name, content) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  await fsaaWrite(fh, content);
  return fh;
}

async function fsaaDelete(dirHandle, name) {
  await dirHandle.removeEntry(name);
}

async function fsaaCreateDir(dirHandle, name) {
  return dirHandle.getDirectoryHandle(name, { create: true });
}

// resolve nested path like "src/notes.html" to a file handle
async function fsaaResolve(rootHandle, filePath) {
  const parts = filePath.split('/');
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return { dir, fileHandle: await dir.getFileHandle(parts[parts.length - 1]) };
}

async function fsaaResolveDir(rootHandle, dirPath) {
  if (!dirPath) return rootHandle;
  const parts = dirPath.split('/');
  let dir = rootHandle;
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return dir;
}

// ── Box backend (IndexedDB) ──

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function boxCreate(name) {
  const box = {
    id: genId(),
    name,
    files: {},
    created: Date.now(),
    modified: Date.now(),
  };
  await dbPut('boxes', box);
  return box;
}

async function boxGet(boxId) {
  return dbGet('boxes', boxId);
}

async function boxSave(box) {
  box.modified = Date.now();
  await dbPut('boxes', box);
}

function boxWalk(box) {
  // reconstruct tree from flat path map
  const tree = [];
  const dirs = {};

  for (const path of Object.keys(box.files).sort()) {
    const parts = path.split('/');
    if (parts.length === 1) {
      tree.push({ name: parts[0], kind: 'file', path, children: [] });
    } else {
      // ensure parent directories exist
      let parentList = tree;
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? prefix + '/' + parts[i] : parts[i];
        if (!dirs[prefix]) {
          const dir = { name: parts[i], kind: 'directory', path: prefix, children: [] };
          dirs[prefix] = dir;
          parentList.push(dir);
        }
        parentList = dirs[prefix].children;
      }
      parentList.push({ name: parts[parts.length - 1], kind: 'file', path, children: [] });
    }
  }

  // sort: directories first, then alphabetical
  function sortEntries(entries) {
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) if (e.children) sortEntries(e.children);
  }
  sortEntries(tree);
  return tree;
}

async function boxRead(boxId, path) {
  const box = await boxGet(boxId);
  return box?.files[path] ?? null;
}

async function boxWrite(boxId, path, content) {
  const box = await boxGet(boxId);
  if (!box) return;
  box.files[path] = content;
  await boxSave(box);
}

async function boxCreateFile(boxId, path, content) {
  return boxWrite(boxId, path, content);
}

async function boxDeleteFile(boxId, path) {
  const box = await boxGet(boxId);
  if (!box) return;
  // delete file and any children if directory path
  const toRemove = Object.keys(box.files).filter(p => p === path || p.startsWith(path + '/'));
  for (const p of toRemove) delete box.files[p];
  await boxSave(box);
}

async function boxRename(boxId, oldPath, newPath) {
  const box = await boxGet(boxId);
  if (!box) return;
  const entries = Object.keys(box.files).filter(p => p === oldPath || p.startsWith(oldPath + '/'));
  for (const p of entries) {
    const newP = newPath + p.slice(oldPath.length);
    box.files[newP] = box.files[p];
    delete box.files[p];
  }
  await boxSave(box);
}

async function boxDeleteBox(boxId) {
  await dbDelete('boxes', boxId);
}

// ── Box export / import ──

async function boxExport(boxId) {
  const box = await boxGet(boxId);
  if (!box) return null;
  const data = { name: box.name, files: box.files };
  const json = JSON.stringify(data);
  // read the current af.html shell as base — use our own document
  const shellHtml = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>AF Box \u2014 ' +
    box.name + '</title></head><body><p>This file contains an Auditable Files box. ' +
    'Open it in AF to import.</p>\n' +
    '<!--AF-BOX\n' + json + '\nAF-BOX-->\n' +
    '</body></html>';
  return shellHtml;
}

function extractBoxData(html) {
  const match = html.match(/<!--AF-BOX\n([\s\S]*?)\nAF-BOX-->/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function boxImport(html) {
  const data = extractBoxData(html);
  if (!data) return null;
  const box = await boxCreate(data.name || 'imported');
  const saved = await boxGet(box.id);
  saved.files = data.files || {};
  await boxSave(saved);
  return saved;
}

// ── Unified interface ──

async function readEntry(rootIndex, path) {
  const root = AFS.roots[rootIndex];
  if (!root) return null;
  if (root.type === 'fsaa') {
    const { fileHandle } = await fsaaResolve(root.dirHandle, path);
    return fsaaRead(fileHandle);
  }
  return boxRead(root.boxId, path);
}

async function writeEntry(rootIndex, path, content) {
  const root = AFS.roots[rootIndex];
  if (!root) return;
  if (root.type === 'fsaa') {
    const { fileHandle } = await fsaaResolve(root.dirHandle, path);
    return fsaaWrite(fileHandle, content);
  }
  return boxWrite(root.boxId, path, content);
}

async function createEntry(rootIndex, parentPath, name, content) {
  const root = AFS.roots[rootIndex];
  if (!root) return;
  const fullPath = parentPath ? parentPath + '/' + name : name;
  if (root.type === 'fsaa') {
    const dirHandle = await fsaaResolveDir(root.dirHandle, parentPath);
    return fsaaCreate(dirHandle, name, content);
  }
  return boxCreateFile(root.boxId, fullPath, content);
}

async function deleteEntry(rootIndex, path) {
  const root = AFS.roots[rootIndex];
  if (!root) return;
  if (root.type === 'fsaa') {
    const parts = path.split('/');
    const name = parts.pop();
    const parentPath = parts.join('/');
    const dirHandle = await fsaaResolveDir(root.dirHandle, parentPath);
    return fsaaDelete(dirHandle, name);
  }
  return boxDeleteFile(root.boxId, path);
}

async function walkRoot(rootIndex) {
  const root = AFS.roots[rootIndex];
  if (!root) return [];
  if (root.type === 'fsaa') {
    return fsaaWalk(root.dirHandle);
  }
  const box = await boxGet(root.boxId);
  return box ? boxWalk(box) : [];
}
