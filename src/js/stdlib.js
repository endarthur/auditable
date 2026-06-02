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
  readDataset, datasetInfo, listDatasets, parseDataPack,
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

// Fetch a .gcudat and install it into the notebook at /var/data/<name>/ (the
// standalone "add a data pack" verb, parallel to install() for code). Persists
// with the notebook (/var is a durable mount). Clean-replace on reinstall.
async function _dataInstall(url) {
  const vfs = _nbVfs();
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('std.data.install: HTTP ' + res.status);
  const { manifest, files } = await parseDataPack(new Uint8Array(await res.arrayBuffer()));
  if (manifest.kind !== 'data')
    throw new Error(`std.data.install: not a data pack (kind=${manifest.kind})`);
  const dir = '/var/data/' + (manifest.name || 'data');
  await vfs.rm(dir, { recursive: true }).catch(() => {});            // clean-replace
  for (const [p, content] of files) {
    if (p === 'gcudat.json') continue;
    const full = dir + '/' + p;
    await vfs.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await vfs.writeFile(full, content);
  }
  return dir;
}

const data = Object.assign((name) => readDataset(_nbVfs(), name), {
  info: (name) => datasetInfo(_nbVfs(), name),
  list: () => listDatasets(_nbVfs()),
  install: _dataInstall,
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
