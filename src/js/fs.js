// ── NOTEBOOK FILESYSTEM ──
// Embedded key-value filesystem stored in the notebook HTML.
// Files are base64-encoded (gzip-compressed when beneficial) in an AUDITABLE-FS comment block.
// API lives at notebook.fs — available in every code cell.

// notifyDirty() is called via window._notifyDirty — wired in globals.js
// to avoid importing editor.js (which pulls in cm6.js and the full editor chain)

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
  if (path.startsWith('/')) throw new Error('fs: path must not start with /');
  if (path.includes('..')) throw new Error('fs: path must not contain ..');
  const segments = path.split('/');
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

let _fsSyncTimer = null;

function notifyFsDirty() {
  if (typeof window !== 'undefined' && window._notifyDirty) window._notifyDirty();
  // debounced live sync — syncFs is imported by save.js and wired up there
  clearTimeout(_fsSyncTimer);
  _fsSyncTimer = setTimeout(() => {
    if (typeof window._syncFs === 'function') window._syncFs();
  }, 500);
}

// ── FS MAP ──

function getFs() {
  if (!window._notebookFS) window._notebookFS = new Map();
  return window._notebookFS;
}

// ── API ──

async function write(path, content, opts = {}) {
  validatePath(path);
  const fs = getFs();

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
  const fs = getFs();
  const entry = fs.get(path);
  if (!entry) throw new Error(`fs.read: file not found: ${path}`);

  let bytes = base64ToUint8(entry.data);
  if (entry.compressed) bytes = await gzipDecompress(bytes);

  const fmt = format || (isTextType(entry.type) ? 'text' : 'binary');

  switch (fmt) {
    case 'text': return new TextDecoder().decode(bytes);
    case 'binary': return bytes;
    case 'json': return JSON.parse(new TextDecoder().decode(bytes));
    case 'blob': return new Blob([bytes], { type: entry.type });
    case 'url': return URL.createObjectURL(new Blob([bytes], { type: entry.type }));
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

function delete_(path, opts = {}) {
  const fs = getFs();

  // exact file match
  if (fs.has(path)) {
    fs.delete(path);
    notifyFsDirty();
    return true;
  }

  // folder prefix
  const prefix = path.endsWith('/') ? path : path + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(prefix));

  if (children.length === 0) return false;
  if (!opts.recursive) throw new Error('fs.delete: use { recursive: true } to delete folders');

  for (const k of children) fs.delete(k);
  notifyFsDirty();
  return children.length;
}

function rename(oldPath, newPath) {
  const fs = getFs();

  // exact file
  if (fs.has(oldPath)) {
    const entry = fs.get(oldPath);
    fs.delete(oldPath);
    fs.set(newPath, entry);
    notifyFsDirty();
    return true;
  }

  // folder prefix rename
  const oldPrefix = oldPath.endsWith('/') ? oldPath : oldPath + '/';
  const newPrefix = newPath.endsWith('/') ? newPath : newPath + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(oldPrefix));
  if (children.length === 0) return false;

  for (const k of children) {
    const entry = fs.get(k);
    fs.delete(k);
    fs.set(newPrefix + k.slice(oldPrefix.length), entry);
  }
  notifyFsDirty();
  return true;
}

function fsCopy(src, dest) {
  const fs = getFs();

  // exact file
  if (fs.has(src)) {
    const entry = fs.get(src);
    fs.set(dest, { ...entry });
    notifyFsDirty();
    return { path: dest, size: entry.size };
  }

  // folder prefix copy
  const srcPrefix = src.endsWith('/') ? src : src + '/';
  const destPrefix = dest.endsWith('/') ? dest : dest + '/';
  const children = [...fs.keys()].filter(k => k.startsWith(srcPrefix));
  if (children.length === 0) throw new Error(`fs.copy: source not found: ${src}`);

  let totalSize = 0;
  for (const k of children) {
    const entry = fs.get(k);
    fs.set(destPrefix + k.slice(srcPrefix.length), { ...entry });
    totalSize += entry.size;
  }
  notifyFsDirty();
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
  };
}

// ── UI PANEL ──

let _fsPanelVisible = false;

export function toggleFs() {
  _fsPanelVisible = !_fsPanelVisible;
  const panel = document.getElementById('fsPanel');
  if (panel) panel.style.display = _fsPanelVisible ? 'block' : '';
  if (_fsPanelVisible) refreshFsPanel();
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function refreshFsPanel() {
  const body = document.getElementById('fsPanelBody');
  if (!body) return;
  const fs = getFs();

  if (!fs.size) {
    body.innerHTML = '<div style="color:var(--fg-dim);padding:12px 0;">no files</div>';
    updateFsSummary();
    return;
  }

  // group by first path segment
  const folders = new Map(); // prefix -> [{path, entry}]
  const root = []; // files without /

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

  // render folders
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

  // render root files
  for (const { path, entry } of root.sort((a, b) => a.path.localeCompare(b.path))) {
    html += `<div class="fs-file-row" data-path="${esc(path)}" oncontextmenu="event.preventDefault();window._fsContextFile(event,'${esc(path)}')">`
      + `<span class="fs-file-name">${esc(path)}</span>`
      + `<span class="fs-file-size">${fmtSize(entry.size)}</span>`
      + `<button class="fs-file-del" onclick="window._fsDelete('${esc(path)}')">\u00d7</button></div>`;
  }

  body.innerHTML = html;
  updateFsSummary();

  // wire folder toggles
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

function updateFsSummary() {
  const el = document.getElementById('fsSummary');
  if (!el) return;
  const fs = getFs();
  if (!fs.size) { el.textContent = 'empty'; return; }
  const total = getSize();
  el.textContent = `${fs.size} file${fs.size > 1 ? 's' : ''}, ${fmtSize(total)}`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fsImport() {
  import_({}).then(() => refreshFsPanel()).catch(() => {});
}

// context menu
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

  // close on outside click
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

// global handlers for onclick/oncontextmenu in generated HTML
if (typeof window !== 'undefined') {
  window._fsDelete = (path) => {
    delete_(path);
    refreshFsPanel();
  };

  window._fsContextFile = (event, path) => {
    showContextMenu(event.clientX, event.clientY, [
      { label: 'copy read command', action: () => copyText(`await notebook.fs.read("${path}")`) },
      { label: 'copy path', action: () => copyText(path) },
      { label: 'rename', action: () => {
        const newPath = prompt('new path:', path);
        if (newPath && newPath !== path) { rename(path, newPath); refreshFsPanel(); }
      }},
      { label: 'download', action: () => export_(path) },
      { label: 'delete', action: () => { delete_(path); refreshFsPanel(); } },
    ]);
  };

  window._fsContextFolder = (event, prefix) => {
    showContextMenu(event.clientX, event.clientY, [
      { label: 'copy list command', action: () => copyText(`notebook.fs.list("${prefix}/")`) },
      { label: 'download as zip', action: () => export_(prefix) },
      { label: 'import into folder', action: () => import_({ prefix: prefix + '/' }).then(() => refreshFsPanel()).catch(() => {}) },
      { label: 'rename folder', action: () => {
        const newPrefix = prompt('new folder name:', prefix);
        if (newPrefix && newPrefix !== prefix) { rename(prefix, newPrefix); refreshFsPanel(); }
      }},
      { label: 'delete folder', action: () => { delete_(prefix, { recursive: true }); refreshFsPanel(); } },
    ]);
  };
}
