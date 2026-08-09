// micro paths — the project folder-layout vocabulary: which files a layer
// depends on, which kind subfolder each file routes to (mirrors the layer
// taxonomy), and path resolution over FileSystemDirectoryHandle (subfolder
// walk, backward-compatible with flat legacy projects). Drillholes — the one
// compound load — get a `.holes.json` descriptor binding their three CSVs +
// desurvey config into one loadable set; dhSetName names it.
import { layerBlob } from './records.js';

export const fmtSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
export const layerBytes = (L) => layerFiles(L).reduce((t, fd) => t + (fd.blob && fd.blob.size || 0), 0);
// every file a layer depends on — one for most kinds, three for drillholes
export function layerFiles(L) {
  if (L.dh && L.docs.dhDoc) {
    const bl = L.docs.dhDoc.blobs;
    return [['collar', bl.collar], ['survey', bl.survey], ['intervals', bl.intervals]]
      .map(([role, blob]) => ({ role, name: (blob && blob.name) || `${role}.csv`, blob }));
  }
  const blob = layerBlob(L);
  return blob ? [{ role: 'source', name: L.name, blob }] : [];
}
export const basename = (p) => String(p).split('/').pop();
export const joinPath = (a, b) => (a ? a.replace(/\/$/, '') + '/' + b : b);
export function kindDir(L) {
  if (L.dh) return 'drillholes';
  const d = L.docs || {};
  if (d.tableDoc) return 'tables';
  if (d.meshDoc) return 'meshes';
  if (d.gridDoc) return 'grids';
  if (d.blockDoc) return 'models';
  if (d.lasDoc || d.plyDoc) return 'clouds';
  return '';
}
export const relPathFor = (L, name) => joinPath(kindDir(L), basename(name));
export async function resolveFileHandle(dir, relpath, { create = false } = {}) {
  const parts = String(relpath).split('/').filter(Boolean);
  const name = parts.pop();
  let d = dir;
  for (const seg of parts) d = await d.getDirectoryHandle(seg, { create });
  return d.getFileHandle(name, { create });
}
export async function removeFileAt(dir, relpath) {
  const parts = String(relpath).split('/').filter(Boolean);
  const name = parts.pop();
  let d = dir;
  for (const seg of parts) { try { d = await d.getDirectoryHandle(seg); } catch { return; } }
  try { await d.removeEntry(name); } catch { /* already gone */ }
}
// where a layer's primary file actually lives (real path via its handle, else
// the canonical kind-folder path)
export async function layerRelpath(L, dir) {
  if (!L.dh && L.handle && dir.resolve) { try { const p = await dir.resolve(L.handle); if (p) return p.join('/'); } catch { /* not a descendant */ } }
  return relPathFor(L, L.name);
}
// resolve a drillhole-set member: relative to the DESCRIPTOR's folder first,
// then the project ROOT (root-file projects — the files matched at the legacy
// root when saved, but the descriptor lives in drillholes/), then drillholes/
export async function resolveDhFile(dir, setDir, name) {
  for (const rel of [joinPath(setDir, name), basename(name), joinPath('drillholes', name)]) {
    try { return await (await resolveFileHandle(dir, rel)).getFile(); } catch { /* next */ }
  }
  throw new Error(name + ' missing');
}
// the drillhole-set descriptor filename (lives in drillholes/)
export const dhSetName = (L) => (basename(String(L.name || 'holes')).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'holes') + '.holes.json';
