// ── NOTEBOOK FILESYSTEM ──
// Embedded key-value filesystem stored in the notebook HTML.
// Files are base64-encoded (gzip-compressed when beneficial) in an AUDITABLE-FS comment block.
// API lives at notebook.fs — available in every code cell.

// Dirty signaling flows through the hook bus (direct hooks import — the
// window.auditable.hooks wrapper isn't ready at module-eval time since
// globals.js loads after this module).
import * as hooks from './hooks.js';
import { prompt as dialogPrompt } from '#dialog';

// ── MIME / TYPE HELPERS ──

const MIME_MAP = {
  csv: 'text/csv', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  wasm: 'application/wasm', bin: 'application/octet-stream',
};

const SKIP_COMPRESS = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/zip', 'application/gzip', 'application/wasm',
]);

export function mimeFromExt(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function isTextType(mime) {
  if (mime.startsWith('text/')) return true;
  return mime === 'application/json' || mime === 'application/javascript' || mime === 'image/svg+xml';
}

// ── PATH VALIDATION ──

export function validatePath(path) {
  if (!path || typeof path !== 'string') throw new Error('fs: path must be a non-empty string');
  if (path.includes('..')) throw new Error('fs: path must not contain ..');
  // POSIX-ish: leading / is workspace-absolute (escapes project sandbox);
  // no leading / is project-relative. The leading slash legitimately produces
  // a leading empty segment, so don't reject it as an "empty segment".
  const segments = path.startsWith('/') ? path.slice(1).split('/') : path.split('/');
  if (segments.some(s => s === '')) throw new Error('fs: path must not contain empty segments');
  return path;
}

// ── GLOB MATCHING ──

export function globMatch(pattern, path) {
  // convert glob pattern to regex
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches any depth
      re += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip trailing /
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$').test(path);
}

// ── COMPRESSION HELPERS ──

async function gzipCompress(bytes) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gzipDecompress(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToUint8(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── DIRTY TRACKING ──
// Emits two bus events: notebook:dirty (Works bridge + cell-data sync) and
// fs:changed (filesystem-state mutation). Consumers (save.js, fs panel)
// debounce on their side.

function notifyFsDirty() {
  hooks.emit('notebook:dirty');
  hooks.emit('fs:changed');
}

// ── FS MAP ──

function getFs() {
  if (!window._notebookFS) window._notebookFS = new Map();
  return window._notebookFS;
}

// ── VFS DELEGATION ──

// The notebook's own project directory. Standalone is a workspace-of-one, so
// this is the fixed literal /projects/self/; in Works the surface VFS resolves
// `self` to the real project path. notebook.fs paths without a leading / are
// project-relative; paths starting with / are workspace-absolute and bypass
// the prefix entirely — used in Works to reach /mnt/<name>, /home/<user>, etc.
const NB_PREFIX = '/projects/self/';
function toAbs(p) { return p.startsWith('/') ? p : NB_PREFIX + p; }
function getVfs() { return window._notebookVFS; }

// ── API ──

async function write(path, content, opts = {}) {
  validatePath(path);

  let bytes;
  let mime = opts.type || mimeFromExt(path);

  if (typeof content === 'string') {
    bytes = new TextEncoder().encode(content);
    if (!opts.type) mime = mimeFromExt(path);
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else if (ArrayBuffer.isView(content)) {
    bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  } else if (typeof Blob !== 'undefined' && content instanceof Blob) {
    if (content.type && !opts.type) mime = content.type;
    bytes = new Uint8Array(await content.arrayBuffer());
  } else if (typeof HTMLCanvasElement !== 'undefined' && content instanceof HTMLCanvasElement) {
    const blob = await new Promise(resolve => content.toBlob(resolve, opts.type || 'image/png'));
    mime = blob.type;
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else if (typeof ImageData !== 'undefined' && content instanceof ImageData) {
    const c = document.createElement('canvas');
    c.width = content.width;
    c.height = content.height;
    c.getContext('2d').putImageData(content, 0, 0);
    const blob = await new Promise(resolve => c.toBlob(resolve, opts.type || 'image/png'));
    mime = blob.type;
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else if (content != null && typeof content === 'object') {
    bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
    mime = opts.type || 'application/json';
  } else {
    throw new Error('fs.write: unsupported content type');
  }

  // delegate to VFS — CommentBackend handles compression + base64 + syncComment
  const vfs = getVfs();
  if (vfs) {
    await vfs.writeFile(toAbs(path), bytes);
    // patch MIME type if specified (CommentBackend infers from extension)
    const entry = getFs().get(path);
    if (entry && opts.type && entry.type !== opts.type) entry.type = opts.type;
    const size = bytes.length;
    return { path, size, compressedSize: entry ? Math.ceil(entry.data.length * 3 / 4) : size };
  }

  // fallback: direct Map write (test environment without VFS)
  const fs = getFs();
  const size = bytes.length;
  const shouldCompress = opts.compress !== false && !SKIP_COMPRESS.has(mime);
  let data, compressed;

  if (shouldCompress) {
    const gz = await gzipCompress(bytes);
    if (gz.length < size) {
      data = uint8ToBase64(gz);
      compressed = true;
    } else {
      data = uint8ToBase64(bytes);
      compressed = false;
    }
  } else {
    data = uint8ToBase64(bytes);
    compressed = false;
  }

  fs.set(path, { type: mime, compressed, size, data });
  notifyFsDirty();
  return { path, size, compressedSize: Math.ceil(data.length * 3 / 4) };
}

async function read(path, format) {
  const vfs = getVfs();
  let bytes;
  let mime;

  if (vfs) {
    // VFS is source of truth — skip the project-scoped local Map gate so
    // workspace-absolute paths (/mnt/<name>, /home/<user>, …) resolve too.
    // Local Map entry, if present, contributes its MIME type; otherwise
    // infer from the extension.
    try {
      bytes = await vfs.readFile(toAbs(path), 'bytes');
    } catch (e) {
      throw new Error(`fs.read: file not found: ${path}`);
    }
    const entry = getFs().get(path);
    mime = entry ? entry.type : mimeFromExt(path);
  } else {
    const entry = getFs().get(path);
    if (!entry) throw new Error(`fs.read: file not found: ${path}`);
    bytes = base64ToUint8(entry.data);
    if (entry.compressed) bytes = await gzipDecompress(bytes);
    mime = entry.type;
  }

  const fmt = format || (isTextType(mime) ? 'text' : 'binary');

  switch (fmt) {
    case 'text': return new TextDecoder().decode(bytes);
    case 'binary': return bytes;
    case 'json': return JSON.parse(new TextDecoder().decode(bytes));
    case 'blob': return new Blob([bytes], { type: mime });
    case 'url': return URL.createObjectURL(new Blob([bytes], { type: mime }));
    default: throw new Error(`fs.read: unknown format: ${fmt}`);
  }
}

function list(pattern) {
  const fs = getFs();
  let entries;

  if (!pattern) {
    entries = [...fs.entries()];
  } else if (pattern.includes('*') || pattern.includes('?')) {
    entries = [...fs.entries()].filter(([p]) => globMatch(pattern, p));
  } else if (pattern.endsWith('/')) {
    entries = [...fs.entries()].filter(([p]) => p.startsWith(pattern));
  } else {
    // exact prefix + /
    const prefix = pattern + '/';
    entries = [...fs.entries()].filter(([p]) => p.startsWith(prefix) || p === pattern);
  }

  return entries
    .map(([p, e]) => ({ path: p, type: e.type, size: e.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function delete_(path, opts = {}) {
  const fs = getFs();
  const vfs = getVfs();

  // exact file match
  if (fs.has(path)) {
    if (vfs) await vfs.unlink(toAbs(path));
    else { fs.delete(path); notifyFsDirty(); }
    return true;
  }

  // folder prefix
  const prefix = path.endsWith('/') ? path : path + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(prefix));

  if (children.length === 0) return false;
  if (!opts.recursive) throw new Error('fs.delete: use { recursive: true } to delete folders');

  if (vfs) {
    for (const k of children) await vfs.unlink(toAbs(k));
  } else {
    for (const k of children) fs.delete(k);
    notifyFsDirty();
  }
  return children.length;
}

async function rename(oldPath, newPath) {
  const fs = getFs();
  const vfs = getVfs();

  // exact file
  if (fs.has(oldPath)) {
    if (vfs) {
      await vfs.rename(toAbs(oldPath), toAbs(newPath));
    } else {
      const entry = fs.get(oldPath);
      fs.delete(oldPath);
      fs.set(newPath, entry);
      notifyFsDirty();
    }
    return true;
  }

  // folder prefix rename
  const oldPrefix = oldPath.endsWith('/') ? oldPath : oldPath + '/';
  const newPrefix = newPath.endsWith('/') ? newPath : newPath + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(oldPrefix));
  if (children.length === 0) return false;

  if (vfs) {
    for (const k of children) {
      await vfs.rename(toAbs(k), toAbs(newPrefix + k.slice(oldPrefix.length)));
    }
  } else {
    for (const k of children) {
      const entry = fs.get(k);
      fs.delete(k);
      fs.set(newPrefix + k.slice(oldPrefix.length), entry);
    }
    notifyFsDirty();
  }
  return true;
}

async function fsCopy(src, dest) {
  const fs = getFs();
  const vfs = getVfs();

  // exact file — use read+write through VFS (not vfs.cp which reads as utf8)
  if (fs.has(src)) {
    if (vfs) {
      const bytes = await vfs.readFile(toAbs(src), 'bytes');
      await vfs.writeFile(toAbs(dest), bytes);
    } else {
      const entry = fs.get(src);
      fs.set(dest, { ...entry });
      notifyFsDirty();
    }
    const entry = fs.get(dest);
    return { path: dest, size: entry ? entry.size : 0 };
  }

  // folder prefix copy
  const srcPrefix = src.endsWith('/') ? src : src + '/';
  const destPrefix = dest.endsWith('/') ? dest : dest + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(srcPrefix));
  if (children.length === 0) throw new Error(`fs.copy: source not found: ${src}`);

  let totalSize = 0;
  if (vfs) {
    for (const k of children) {
      const bytes = await vfs.readFile(toAbs(k), 'bytes');
      await vfs.writeFile(toAbs(destPrefix + k.slice(srcPrefix.length)), bytes);
      totalSize += bytes.length;
    }
  } else {
    for (const k of children) {
      const entry = fs.get(k);
      fs.set(destPrefix + k.slice(srcPrefix.length), { ...entry });
      totalSize += entry.size;
    }
    notifyFsDirty();
  }
  return { path: dest, size: totalSize };
}

function stat(path) {
  const fs = getFs();
  const entry = fs.get(path);
  if (!entry) return null;
  return {
    path,
    type: entry.type,
    size: entry.size,
    compressedSize: Math.ceil(entry.data.length * 3 / 4),
  };
}

function exists(path) {
  return getFs().has(path);
}

function clear() {
  const fs = getFs();
  const count = fs.size;
  fs.clear();
  if (count) notifyFsDirty();
  return count;
}

function getSize() {
  let total = 0;
  for (const entry of getFs().values()) total += entry.size;
  return total;
}

async function import_(opts = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    if (opts.multiple) input.multiple = true;
    input.onchange = async () => {
      try {
        const files = [...input.files];
        if (!files.length) { reject(new Error('no file selected')); return; }

        // unzip mode
        if (opts.unzip && files.length === 1) {
          const buf = new Uint8Array(await files[0].arrayBuffer());
          // use std.unzip if available on window, else fall back
          const unzipFn = window._stdUnzip;
          if (!unzipFn) throw new Error('fs.import: unzip not available');
          const entries = await unzipFn(buf);
          const paths = [];
          for (const [name, data] of entries) {
            const path = (opts.prefix || '') + name;
            await write(path, data);
            paths.push(path);
          }
          resolve(opts.multiple ? paths : paths[0]);
          return;
        }

        const paths = [];
        for (const f of files) {
          const path = (opts.prefix || '') + f.name;
          const buf = new Uint8Array(await f.arrayBuffer());
          await write(path, buf, { type: f.type || undefined });
          paths.push(path);
        }
        resolve(opts.multiple ? paths : paths[0]);
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}

async function export_(path) {
  const fs = getFs();

  // exact file match
  if (fs.has(path)) {
    const bytes = await read(path, 'binary');
    const entry = fs.get(path);
    const blob = new Blob([bytes], { type: entry.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  // glob
  if (path.includes('*') || path.includes('?')) {
    const matches = list(path);
    if (!matches.length) throw new Error(`fs.export: no files match: ${path}`);
    const entries = [];
    for (const m of matches) {
      entries.push([m.path, await read(m.path, 'binary')]);
    }
    const zipFn = window._stdZip;
    if (!zipFn) throw new Error('fs.export: zip not available');
    const zipBytes = await zipFn(entries);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'files.zip';
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  // folder prefix
  const prefix = path.endsWith('/') ? path : path + '/';
  const matches = [...fs.keys()].filter(k => k.startsWith(prefix));
  if (!matches.length) throw new Error(`fs.export: not found: ${path}`);

  const entries = [];
  for (const p of matches) {
    entries.push([p.slice(prefix.length), await read(p, 'binary')]);
  }
  const zipFn = window._stdZip;
  if (!zipFn) throw new Error('fs.export: zip not available');
  const zipBytes = await zipFn(entries);
  const name = (path.endsWith('/') ? path.slice(0, -1) : path).split('/').pop();
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.zip';
  a.click();
  URL.revokeObjectURL(url);
}

// ── PUBLIC API ──

// exported for use by stdlib.js file({ embed }) and exec.js load('fs:...')
export const fsWrite = write;
export const fsRead = read;

export function createNotebookFs() {
  return {
    write, read, list, delete: delete_, rename, copy: fsCopy, stat, exists,
    clear, get size() { return getSize(); },
    import: import_, export: export_,
    // VFS-named aliases (relative paths, same as above)
    readFile: async (p, enc) => read(p, enc === 'bytes' ? 'binary' : undefined),
    writeFile: async (p, content) => write(p, content),
    readdir: (prefix) => {
      const fs = getFs();
      const dir = prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '';
      const seen = new Set();
      for (const k of fs.keys()) {
        if (!k.startsWith(dir)) continue;
        const rest = k.slice(dir.length);
        const idx = rest.indexOf('/');
        seen.add(idx === -1 ? rest : rest.slice(0, idx));
      }
      return [...seen].sort();
    },
    mkdir: async () => {},  // no-op (CommentBackend has implicit dirs)
    unlink: async (p) => delete_(p),
    rmdir: async (p) => delete_(p, { recursive: true }),
    glob: (pattern) => list(pattern).map(f => f.path),
    touch: async (p) => { const vfs = getVfs(); if (vfs) await vfs.touch(toAbs(p)); },
    get vfs() { return window._notebookVFS; },
  };
}

// ── UI PANEL ──

let _fsState = {
  visible: false,
  cwd: '/projects/self',
  root: '/projects/self',   // current view directory (breadcrumb navigates this)
  expanded: new Set(), // subdirs expanded within current root
  cache: new Map(),
};

export function toggleFs() {
  _fsState.visible = !_fsState.visible;
  const panel = document.getElementById('fsPanel');
  if (panel) panel.style.display = _fsState.visible ? 'block' : '';
  if (_fsState.visible) refreshFsPanel();
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── BREADCRUMB ──

function navigateTo(dirPath) {
  _fsState.root = dirPath;
  _fsState.expanded.clear();
  _fsState.cache.clear();
  refreshFsPanel();
}

function renderBreadcrumb() {
  const el = document.getElementById('fsBreadcrumb');
  if (!el) return;
  el.innerHTML = '';
  const root = _fsState.root;
  const parts = root === '/' ? [''] : root.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'fs-crumb-sep';
      sep.textContent = '\u203a';
      el.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'fs-crumb';
    btn.textContent = i === 0 ? '/' : parts[i];
    const crumbPath = i === 0 ? '/' : parts.slice(0, i + 1).join('/');
    // clicking navigates to that directory
    if (crumbPath !== root) {
      btn.onclick = () => navigateTo(crumbPath);
    } else {
      btn.style.color = 'var(--au-fg)';
      btn.style.cursor = 'default';
    }
    el.appendChild(btn);
    if (crumbPath === _fsState.cwd) {
      const badge = document.createElement('span');
      badge.className = 'fs-cwd-badge';
      badge.textContent = 'cwd';
      el.appendChild(badge);
    }
  }
}

// ── VFS TREE RENDERER ──

// For unmounted intermediate paths (/, /home, /usr, /usr/lib),
// synthesize directory entries from mount point paths.
function synthChildren(vfs, dirPath) {
  const prefix = dirPath === '/' ? '/' : dirPath + '/';
  const children = new Set();
  for (const { path: mp } of vfs.mounts()) {
    if (dirPath === '/') {
      const first = mp.split('/').filter(Boolean)[0];
      if (first) children.add(first);
    } else if (mp.startsWith(prefix)) {
      const rest = mp.slice(prefix.length);
      const next = rest.split('/')[0];
      if (next) children.add(next);
    }
  }
  return [...children].sort().map(name => ({ name, type: 'directory', size: 0 }));
}

async function renderDirectory(parentEl, dirPath, depth) {
  const vfs = getVfs();
  if (!vfs) return;
  let entries;
  try {
    entries = await vfs.readdir(dirPath, { stat: true });
  } catch {
    // No backend for this path — synthesize from mount points
    entries = synthChildren(vfs, dirPath);
    if (!entries.length) return;
  }

  // sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  const mountPaths = new Set(vfs._mounts.keys());
  const isVolatile = dirPath === '/tmp' || dirPath.startsWith('/tmp/');

  for (const entry of entries) {
    const absPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;

    if (entry.type === 'directory') {
      const isExpanded = _fsState.expanded.has(absPath);
      const isMountPoint = mountPaths.has(absPath);
      const isCwd = absPath === _fsState.cwd;

      const row = document.createElement('div');
      row.className = 'fs-dir-row';
      row.style.paddingLeft = (depth * 18) + 'px';
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); contextDir(e, absPath, isMountPoint); };

      const toggle = document.createElement('span');
      toggle.className = 'fs-dir-toggle';
      toggle.textContent = isExpanded ? '\u25be' : '\u25b8';
      row.appendChild(toggle);

      const name = document.createElement('span');
      name.textContent = ' ' + entry.name + '/';
      if (isVolatile || absPath === '/tmp' || absPath.startsWith('/tmp/')) name.className = 'fs-volatile';
      row.appendChild(name);

      if (isCwd) {
        const badge = document.createElement('span');
        badge.className = 'fs-cwd-badge';
        badge.textContent = 'cwd';
        row.appendChild(badge);
      }
      if (isMountPoint) {
        let type = 'mount';
        try { type = vfs.capabilities(absPath).type || 'mount'; } catch {}
        const badge = document.createElement('span');
        badge.className = 'fs-mount-badge';
        badge.textContent = type;
        row.appendChild(badge);
      }

      // arrow toggles inline expand/collapse
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (isExpanded) _fsState.expanded.delete(absPath);
        else _fsState.expanded.add(absPath);
        _fsState.cache.clear();
        refreshFsPanel();
      };
      // clicking name navigates into directory
      name.onclick = (e) => {
        e.stopPropagation();
        navigateTo(absPath);
      };
      name.style.cursor = 'pointer';
      parentEl.appendChild(row);

      if (isExpanded) {
        await renderDirectory(parentEl, absPath, depth + 1);
      }
    } else {
      // file row
      const row = document.createElement('div');
      row.className = 'fs-file-row';
      row.style.paddingLeft = (depth * 18) + 'px';
      row.oncontextmenu = (e) => { e.preventDefault(); contextFile(e, absPath, dirPath); };

      const fname = document.createElement('span');
      fname.className = 'fs-file-name';
      if (isVolatile) fname.className += ' fs-volatile';
      fname.textContent = entry.name;
      row.appendChild(fname);

      const size = document.createElement('span');
      size.className = 'fs-file-size';
      size.textContent = fmtSize(entry.size || 0);
      row.appendChild(size);

      // delete button — only for writable backends
      let writable = true;
      try { writable = vfs.capabilities(absPath).writable; } catch {}
      if (writable) {
        const del = document.createElement('button');
        del.className = 'fs-file-del';
        del.textContent = '\u00d7';
        del.onclick = async (e) => {
          e.stopPropagation();
          try { await vfs.unlink(absPath); } catch {}
          _fsState.cache.clear();
          refreshFsPanel();
        };
        row.appendChild(del);
      }

      parentEl.appendChild(row);
    }
  }
}

async function renderTree() {
  const body = document.getElementById('fsPanelBody');
  if (!body) return;
  body.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'fs-loading';
  loading.textContent = 'loading\u2026';
  body.appendChild(loading);

  try {
    await renderDirectory(body, _fsState.root, 0);
    // remove loading placeholder (it's the first child if still there)
    if (body.firstChild === loading) body.removeChild(loading);
    // if body is empty after render, show "no files"
    if (!body.children.length) {
      const empty = document.createElement('div');
      empty.className = 'fs-loading';
      empty.textContent = 'no files';
      body.appendChild(empty);
    }
  } catch (e) {
    body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'fs-loading';
    err.textContent = 'error: ' + e.message;
    body.appendChild(err);
  }
}

// ── LEGACY RENDERER (no VFS) ──

function refreshFsPanelLegacy() {
  const body = document.getElementById('fsPanelBody');
  if (!body) return;
  const fs = getFs();

  if (!fs.size) {
    body.innerHTML = '<div style="color:var(--au-fg-soft);padding:12px 0;">no files</div>';
    updateFsSummary();
    return;
  }

  const folders = new Map();
  const root = [];

  for (const [path, entry] of fs) {
    const idx = path.indexOf('/');
    if (idx === -1) {
      root.push({ path, entry });
    } else {
      const prefix = path.slice(0, idx);
      if (!folders.has(prefix)) folders.set(prefix, []);
      folders.get(prefix).push({ path, entry });
    }
  }

  let html = '';

  for (const [prefix, files] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const totalSize = files.reduce((s, f) => s + f.entry.size, 0);
    html += `<div class="fs-folder">`;
    html += `<div class="fs-folder-header" data-prefix="${esc(prefix)}" oncontextmenu="event.preventDefault();window._fsContextFolder(event,'${esc(prefix)}')">`
      + `<span class="fs-folder-toggle">\u25b8</span> ${esc(prefix)}/ `
      + `<span class="fs-folder-info">${files.length} file${files.length > 1 ? 's' : ''}, ${fmtSize(totalSize)}</span></div>`;
    html += `<div class="fs-folder-contents" style="display:none">`;
    for (const { path, entry } of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const name = path.slice(prefix.length + 1);
      html += `<div class="fs-file-row" data-path="${esc(path)}" oncontextmenu="event.preventDefault();window._fsContextFile(event,'${esc(path)}')">`
        + `<span class="fs-file-name">${esc(name)}</span>`
        + `<span class="fs-file-size">${fmtSize(entry.size)}</span>`
        + `<button class="fs-file-del" onclick="window._fsDelete('${esc(path)}')">\u00d7</button></div>`;
    }
    html += `</div></div>`;
  }

  for (const { path, entry } of root.sort((a, b) => a.path.localeCompare(b.path))) {
    html += `<div class="fs-file-row" data-path="${esc(path)}" oncontextmenu="event.preventDefault();window._fsContextFile(event,'${esc(path)}')">`
      + `<span class="fs-file-name">${esc(path)}</span>`
      + `<span class="fs-file-size">${fmtSize(entry.size)}</span>`
      + `<button class="fs-file-del" onclick="window._fsDelete('${esc(path)}')">\u00d7</button></div>`;
  }

  body.innerHTML = html;
  updateFsSummary();

  body.querySelectorAll('.fs-folder-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.classList.contains('fs-file-del')) return;
      const contents = hdr.nextElementSibling;
      const toggle = hdr.querySelector('.fs-folder-toggle');
      const open = contents.style.display !== 'none';
      contents.style.display = open ? 'none' : '';
      toggle.textContent = open ? '\u25b8' : '\u25be';
    });
  });
}

// ── PANEL ENTRY POINT ──

function refreshFsPanel() {
  const vfs = getVfs();
  if (vfs) {
    renderBreadcrumb();
    renderTree();
    updateFsSummary();
  } else {
    // hide breadcrumb in legacy mode
    const bc = document.getElementById('fsBreadcrumb');
    if (bc) bc.innerHTML = '';
    refreshFsPanelLegacy();
  }
}

function updateFsSummary() {
  const el = document.getElementById('fsSummary');
  if (!el) return;
  const fs = getFs();
  if (!fs.size) { el.textContent = 'empty'; return; }
  const total = getSize();
  el.textContent = `${fs.size} file${fs.size > 1 ? 's' : ''}, ${fmtSize(total)}`;
}

export function fsImport() {
  import_({}).then(() => { _fsState.cache.clear(); refreshFsPanel(); }).catch(() => {});
}

// ── CONTEXT MENUS ──

let _ctxMenu = null;

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'fs-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.onclick = () => { closeContextMenu(); item.action(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  _ctxMenu = menu;
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function copyText(text) {
  if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); return; }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function relPath(absPath) {
  // convert absolute VFS path to relative notebook.fs path (for project files)
  if (absPath.startsWith(NB_PREFIX)) return absPath.slice(NB_PREFIX.length);
  return absPath;
}

function contextFile(event, absPath, dirPath) {
  const vfs = getVfs();
  const isNb = absPath.startsWith(NB_PREFIX);
  const displayPath = isNb ? relPath(absPath) : absPath;

  const items = [];

  // copy read command — use relative path for project files, vfs for others
  if (isNb) {
    items.push({ label: 'copy read command', action: () => copyText(`await notebook.fs.read("${relPath(absPath)}")`) });
  } else {
    items.push({ label: 'copy read command', action: () => copyText(`await vfs.readFile("${absPath}", "text")`) });
  }
  items.push({ label: 'copy path', action: () => copyText(displayPath) });

  let writable = true;
  let isMountRoot = false;
  if (vfs) {
    try { writable = vfs.capabilities(absPath).writable; } catch {}
    isMountRoot = vfs._mounts.has(absPath);
  }

  if (writable && !isMountRoot) {
    items.push({ label: 'rename', action: async () => {
      const name = absPath.split('/').pop();
      const newName = await dialogPrompt('new name:', { defaultValue: name });
      if (!newName || newName === name) return;
      const newPath = dirPath === '/' ? '/' + newName : dirPath + '/' + newName;
      if (isNb && newPath.startsWith(NB_PREFIX)) {
        await rename(relPath(absPath), relPath(newPath));
      } else if (vfs) {
        await vfs.rename(absPath, newPath);
      }
      _fsState.cache.clear();
      refreshFsPanel();
    }});
  }

  if (isNb) {
    items.push({ label: 'download', action: () => export_(relPath(absPath)) });
  }

  if (writable && !isMountRoot) {
    items.push({ label: 'delete', action: async () => {
      if (isNb) {
        await delete_(relPath(absPath));
      } else if (vfs) {
        await vfs.unlink(absPath);
      }
      _fsState.cache.clear();
      refreshFsPanel();
    }});
  }

  showContextMenu(event.clientX, event.clientY, items);
}

function contextDir(event, absPath, isMountPoint) {
  const vfs = getVfs();
  const isNb = absPath.startsWith(NB_PREFIX);
  const displayPath = isNb ? relPath(absPath) : absPath;

  const items = [];
  items.push({ label: 'copy path', action: () => copyText(displayPath) });

  if (isNb) {
    const rel = relPath(absPath);
    items.push({ label: 'copy list command', action: () => copyText(`notebook.fs.list("${rel}/")`) });
    items.push({ label: 'download as zip', action: () => export_(rel) });
    items.push({ label: 'import into folder', action: () => import_({ prefix: rel + '/' }).then(() => { _fsState.cache.clear(); refreshFsPanel(); }).catch(() => {}) });
  }

  let writable = true;
  if (vfs) {
    try { writable = vfs.capabilities(absPath).writable; } catch {}
  }

  if (writable && !isMountPoint) {
    items.push({ label: 'rename folder', action: async () => {
      const name = absPath.split('/').pop();
      const newName = await dialogPrompt('new folder name:', { defaultValue: name });
      if (!newName || newName === name) return;
      const parent = absPath.slice(0, absPath.lastIndexOf('/')) || '/';
      const newPath = parent === '/' ? '/' + newName : parent + '/' + newName;
      if (isNb && newPath.startsWith(NB_PREFIX)) {
        await rename(relPath(absPath), relPath(newPath));
      } else if (vfs) {
        await vfs.rename(absPath, newPath);
      }
      _fsState.cache.clear();
      refreshFsPanel();
    }});
    items.push({ label: 'delete folder', action: async () => {
      if (isNb) {
        await delete_(relPath(absPath), { recursive: true });
      } else if (vfs) {
        await vfs.rmdir(absPath, { recursive: true });
      }
      _fsState.expanded.delete(absPath);
      _fsState.cache.clear();
      refreshFsPanel();
    }});
  }

  showContextMenu(event.clientX, event.clientY, items);
}

// legacy global handlers (for innerHTML-based legacy mode)
if (typeof window !== 'undefined') {
  window._fsDelete = async (path) => {
    await delete_(path);
    refreshFsPanel();
  };

  window._fsContextFile = (event, path) => {
    showContextMenu(event.clientX, event.clientY, [
      { label: 'copy read command', action: () => copyText(`await notebook.fs.read("${path}")`) },
      { label: 'copy path', action: () => copyText(path) },
      { label: 'rename', action: async () => {
        const newPath = await dialogPrompt('new path:', { defaultValue: path });
        if (newPath && newPath !== path) { await rename(path, newPath); refreshFsPanel(); }
      }},
      { label: 'download', action: () => export_(path) },
      { label: 'delete', action: async () => { await delete_(path); refreshFsPanel(); } },
    ]);
  };

  window._fsContextFolder = (event, prefix) => {
    showContextMenu(event.clientX, event.clientY, [
      { label: 'copy list command', action: () => copyText(`notebook.fs.list("${prefix}/")`) },
      { label: 'download as zip', action: () => export_(prefix) },
      { label: 'import into folder', action: () => import_({ prefix: prefix + '/' }).then(() => refreshFsPanel()).catch(() => {}) },
      { label: 'rename folder', action: async () => {
        const newPrefix = await dialogPrompt('new folder name:', { defaultValue: prefix });
        if (newPrefix && newPrefix !== prefix) { await rename(prefix, newPrefix); refreshFsPanel(); }
      }},
      { label: 'delete folder', action: async () => { await delete_(prefix, { recursive: true }); refreshFsPanel(); } },
    ]);
  };

  // fs:changed bus subscriber — debounces 150ms before refreshing the panel.
  // Subscribes via the direct hooks import; the window.auditable.hooks
  // surface isn't wired until globals.js evaluates (after this module).
  let _panelRefreshTimer = null;
  hooks.on('fs:changed', () => {
    if (!_fsState.visible) return;
    clearTimeout(_panelRefreshTimer);
    _panelRefreshTimer = setTimeout(() => {
      _fsState.cache.clear();
      refreshFsPanel();
    }, 150);
  });
}
