// Decompress the examples payload that build.js --target=works-all
// embedded into works-all.html, populating /usr/share/examples/ in the
// workspace VFS so the Help → Open example… menu can pick from them.
//
// /usr is a volatile MemoryBackend (workspace.js): the shell repopulates
// it on every boot, examples never leak into workspace exports, fresh on
// every reload.
//
// This is a no-op for the regular --target=works build (no payload tag
// in the DOM); only works-all.html carries the bundle.

import { WKS } from './state.js';

let _manifest = null;
export function getExamplesManifest() { return _manifest; }
export function hasExamples() { return _manifest != null; }

async function _decompressExamples() {
  const el = document.getElementById('examples-payload');
  if (!el) return null;
  const bytes = Uint8Array.from(
    atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const text = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

export async function installExamplesToVfs(vfs) {
  if (!vfs) return;
  const payload = await _decompressExamples();
  if (!payload) return;       // works (not works-all) — no payload
  _manifest = payload.manifest || { categories: {} };
  await vfs.mkdir('/usr/share/examples', { recursive: true }).catch(() => {});
  for (const [relPath, content] of Object.entries(payload.defs || {})) {
    const fullPath = '/usr/share/examples/' + relPath;
    const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(fullPath, content);
  }
  await vfs.writeFile('/usr/share/examples/manifest.json',
    JSON.stringify(_manifest));
}
