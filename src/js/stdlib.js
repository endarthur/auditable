// ── STDLIB ──
// Bundled standard library for notebook work.
// Pure computation lives in stdlib-core.js; this file adds browser-only functions.

import { fsWrite } from './fs.js';
import { VFS, path } from './vfs.js';
import {
  csv, sum, mean, median, extent, bin, linspace,
  unique, zip, cross, fmt, include,
  zipArchive as zipFn, unzipArchive as unzipFn,
  color, colorScale, hsl,
  viridis, magma, inferno, plasma, turbo,
  palette10,
  readDataset, datasetInfo, listDatasets, installDataPack, datasetFile, expansionsOf,
} from './stdlib-core.js';

// ── Provider Registry ──

const _providers = { file: null, download: null };

export function registerProvider(name, fn) {
  if (name in _providers) _providers[name] = fn;
}

// ── Data ──

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetchJSON: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── DOM / IO ──

async function file(accept) {
  const opts = typeof accept === 'string' ? { accept } : (accept || {});
  if (_providers.file && !opts.embed) return _providers.file(opts.accept || accept);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) { reject(new Error('no file selected')); return; }
      if (opts.embed) {
        const path = (opts.prefix || '') + f.name;
        await fsWrite(path, new Uint8Array(await f.arrayBuffer()), { type: f.type || undefined });
        resolve(path);
      } else {
        const text = await f.text();
        resolve({ name: f.name, text, size: f.size });
      }
    };
    input.click();
  });
}

function download(data, filename, mimeType) {
  if (_providers.download) return _providers.download(data, filename, mimeType);
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const mime = mimeType || (typeof data === 'string' ? 'text/plain' : 'application/json');
  const blob = new Blob([str], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag, attrs, ...children) {
  const elem = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(elem.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        elem.addEventListener(k.slice(2), v);
      } else {
        elem.setAttribute(k, v);
      }
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  for (const child of children) {
    if (child instanceof Node) elem.appendChild(child);
    else if (child != null) elem.appendChild(document.createTextNode(String(child)));
  }
  return elem;
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
}

// ── Zip / Unzip window bindings ──
// expose for fs.js import/export
if (typeof window !== 'undefined') {
  window._stdZip = zipFn;
  window._stdUnzip = unzipFn;
}

// ── Export ──

// ── Data packs ──
// std.data is a callable namespace: `await std.data('factbook')` reads a pack's
// records; .info / .list inspect; .install(url) fetches a .gcudat into the
// notebook. Reads window._notebookVFS, so the same call resolves in a
// standalone notebook (/var/data) or a Works surface (/home/library/data) via
// the stdlib-core resolution chain.
function _nbVfs() {
  const v = typeof window !== 'undefined' ? window._notebookVFS : null;
  if (!v) throw new Error('std.data: no notebook filesystem available');
  return v;
}

// Install a .gcudat into the notebook at /var/data/<name>/ (the standalone "add
// a data pack" verb, parallel to install() for code). Accepts a URL (fetched),
// a File/Blob (drag-drop / ui.upload), or raw bytes. Persists with the notebook
// (/var is a durable mount). Clean-replace on reinstall.
async function _dataBytes(src) {
  if (typeof src === 'string') {
    const res = await fetch(src, { cache: 'no-cache' });
    if (!res.ok) throw new Error('std.data.install: HTTP ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src && typeof src.arrayBuffer === 'function') return new Uint8Array(await src.arrayBuffer());
  throw new Error('std.data.install: expected a URL, File/Blob, or bytes');
}
async function _dataInstall(src) {
  const { dir } = await installDataPack(_nbVfs(), await _dataBytes(src));
  return dir;
}

const data = Object.assign((name) => readDataset(_nbVfs(), name), {
  info: (name) => datasetInfo(_nbVfs(), name),
  list: () => listDatasets(_nbVfs()),
  install: _dataInstall,
  // Read a pack asset, resolving across the base + installed expansion tiers
  // (e.g. std.data.file('factbook', 'maps/de.png')). enc:'utf8' for text.
  file: (name, relpath, enc) => datasetFile(_nbVfs(), name, relpath, enc),
  // Installed expansion-tier dirs that extend `name`.
  expansions: (name) => expansionsOf(_nbVfs(), name),
});

export const std = {
  csv, fetchJSON, data,
  sum, mean, median, extent, bin, linspace,
  unique, zip, cross,
  file, download, el, copy, fmt,
  include, zipArchive: zipFn, unzipArchive: unzipFn,
  color, colorScale, hsl,
  viridis, magma, inferno, plasma, turbo,
  palette10,
  VFS, path,
};
