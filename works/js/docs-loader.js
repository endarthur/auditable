// Decompress the docs payload that build.js embedded into works.html,
// populating /usr/share/doc/ in the workspace VFS so the docs surface
// can read each file via the standard works.VFS interface.
//
// /usr is a volatile MemoryBackend (workspace.js): the shell repopulates
// it on every boot, docs never leak into workspace exports, fresh on
// every reload.

import { WKS } from './state.js';

let _manifest = null;
export function getDocsManifest() { return _manifest; }

async function _decompressDocs() {
  const el = document.getElementById('docs-payload');
  if (!el) return null;
  const bytes = Uint8Array.from(
    atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const text = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

export async function installDocsToVfs(vfs) {
  if (!vfs) return;
  const payload = await _decompressDocs();
  if (!payload) return;
  _manifest = payload.manifest || { nav: [], extensions: [] };
  await vfs.mkdir('/usr/share/doc', { recursive: true }).catch(() => {});
  for (const [relPath, content] of Object.entries(payload.docs || {})) {
    const fullPath = '/usr/share/doc/' + relPath;
    const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(fullPath, content);
  }
  // Drop the manifest as JSON next to the docs so the surface can read
  // it the same way as everything else.
  await vfs.writeFile('/usr/share/doc/manifest.json',
    JSON.stringify(_manifest));
}
