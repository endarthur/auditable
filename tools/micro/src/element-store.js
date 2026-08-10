// micro element store — WHERE derived columns and element manifests persist:
// the project dir (FSAA/OPFS, one Parquet per column beside the source) when
// the layer lives in a project, else the browser's IDB kv, else memory-only.
// This module registers itself as columns.js's sidecar reader at init, closing
// the residency loop (evict → re-fault) without the app wiring it by hand.
import { S } from './state.js';
import { layerRelpath, resolveFileHandle, removeFileAt, basename } from './paths.js';
import { storedCols, matColLooseId, matColSourceHash, matColEncode, matColDecodeStr, matColDecode, matColSet, paintRecount, PAINT_BLANK, ruleDefaultColor, columnsChanged, setSidecarReader } from './columns.js';
import { buildElementManifest, buildGridElementManifest, elementHydrate } from './manifest.js';

// a tiny IndexedDB kv (database 'micro', store 'kv') — the loose-layer fallback
// for matcols/elements, and the app's recents/projects ledger
export const _idb = (() => {
  let db;
  const open = () => (db ||= new Promise((res, rej) => {
    const r = indexedDB.open('micro', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode), req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    async get(k) { try { return await tx('readonly', (st) => st.get(k)); } catch { return undefined; } },
    async set(k, v) { try { await tx('readwrite', (st) => st.put(v, k)); } catch { /* best-effort */ } },
  };
})();

export async function readSidecarCol(L, name) {
  try {
    if (L.storage === 'project' && S.project && S.project.dir) {
      const rel = await layerRelpath(L, S.project.dir);
      return await (await (await resolveFileHandle(S.project.dir, `${rel}.cols/${name}.parquet`)).getFile()).arrayBuffer();
    }
    return await _idb.get(`matcol:${matColLooseId(L)}:col:${name}`);
  } catch { return null; }
}
setSidecarReader(readSidecarCol);                          // columns.js residency re-faults through here

export async function persistElement(L) {
  const cols = storedCols(L);
  const elem = buildElementManifest(L) || buildGridElementManifest(L);
  if (!elem) return 'none';
  if (L.storage === 'project' && S.project && S.project.dir) {
    const rel = await layerRelpath(L, S.project.dir);
    for (const c of cols) {
      if (c.mat && !c.fvalues) continue;                   // evicted: the sidecar file already holds these values
      const fh = await resolveFileHandle(S.project.dir, `${rel}.cols/${c.name}.parquet`, { create: true }); const w = await fh.createWritable(); await w.write(matColEncode(c)); await w.close();
    }
    if (!L.dh) { const mh = await resolveFileHandle(S.project.dir, `${rel}.element.json`, { create: true }); const w = await mh.createWritable(); await w.write(JSON.stringify(elem, null, 2)); await w.close(); }   // dh members ride the SET manifest
    return 'project';
  }
  try { const id = matColLooseId(L); for (const c of cols) { if (c.mat && !c.fvalues) continue; await _idb.set(`matcol:${id}:col:${c.name}`, matColEncode(c).buffer); } await _idb.set(`matcol:${id}:element`, elem); return 'idb'; }
  catch { return 'memory'; }
}
export async function loadElement(L, dir) {
  let elem = null, man = null, get = null;
  if (dir && L.storage === 'project') {
    const rel = await layerRelpath(L, dir);
    get = async (nm) => { try { return await (await (await resolveFileHandle(dir, `${rel}.cols/${nm}.parquet`)).getFile()).arrayBuffer(); } catch { return await (await (await resolveFileHandle(dir, `${rel}.cols/${nm}.f32`)).getFile()).arrayBuffer(); } };   // legacy .f32 fallback
    const manRel = L.dh && L._setPath && /\.element\.json$/i.test(L._setPath) ? L._setPath : `${rel}.element.json`;   // dh members share the SET manifest
    try { elem = JSON.parse(await (await (await resolveFileHandle(dir, manRel)).getFile()).text()); }
    catch { try { man = JSON.parse(await (await (await resolveFileHandle(dir, `${rel}.cols/manifest.json`)).getFile()).text()); } catch { get = null; } }   // legacy v2
  }
  if (!elem && !man) {
    try {
      const id = matColLooseId(L);
      elem = await _idb.get(`matcol:${id}:element`);
      if (!elem) man = await _idb.get(`matcol:${id}:manifest`);
      if (elem || man) get = async (nm) => await _idb.get(`matcol:${id}:col:${nm}`);
    } catch { /* none */ }
  }
  const cur = matColSourceHash(L);
  let mats = [];
  if (elem && elem.v === 1) {
    const locs = elem.locations || {};
    let lk = Object.keys(locs)[0];
    if (L.dh) { const me = basename(L.name); lk = Object.keys(locs).find((k) => locs[k].source && locs[k].source.file === me) || lk; }
    mats = elementHydrate(L, elem, lk);                    // derived ƒ restore even when materialized are stale
    const hash = lk && locs[lk] && locs[lk].source && locs[lk].source.hash;
    if (hash && hash !== cur) { if (mats.length) { const el = document.querySelector('#meta'); if (el) el.textContent = `${L.name}: materialized columns are stale (source changed) — re-run to refresh`; } return 0; }
  } else if (man && man.cols) {
    if (man.sourceHash && man.sourceHash !== cur) { const el = document.querySelector('#meta'); if (el) el.textContent = `${L.name}: materialized columns are stale (source changed) — re-run to refresh`; return 0; }
    mats = man.cols;
  }
  if (!mats.length || !get) return 0;
  let loaded = 0;
  for (const cm of mats) {
    try {
      const buf = await get(cm.name); if (!buf) continue;
      if (cm.type === 'category') {                        // stored category: string column → dict/codes, legend from the manifest
        const vals = await matColDecodeStr(buf);
        const dict = [''], colors = [PAINT_BLANK];
        for (const [, v] of Object.entries(cm.categories || {}).sort((a, b2) => +a[0] - +b2[0])) { dict.push(v.name); colors.push(v.color || ruleDefaultColor(dict.length - 2)); }
        const codeOf = new Map(dict.map((d, i2) => [d, i2]));
        const codes = new Uint8Array(vals.length);
        for (let i2 = 0; i2 < vals.length; i2++) {
          const v = vals[i2]; if (v == null || v === '') continue;
          let code = codeOf.get(v);
          if (code == null) { if (dict.length >= 256) continue; code = dict.length; dict.push(v); colors.push(ruleDefaultColor(dict.length - 2)); codeOf.set(v, code); }
          codes[i2] = code;
        }
        const col = { name: cm.name, dict, colors, blankColor: cm.blankColor || PAINT_BLANK, codes, lineage: cm.lineage };
        paintRecount(col);
        L.paintCols = ((L.paintCols || []).filter((c) => c.name !== cm.name)); L.paintCols.push(col);
        L._colStats = null; L._calcFns = null;
        columnsChanged(L);                                 // color-by options track the column set (active-layer guard inside)
      } else matColSet(L, cm.name, await matColDecode(buf), { lineage: cm.lineage });
      loaded++;
    } catch { /* skip a missing file */ }
  }
  return loaded;
}
export async function matColDelete(L, name) {
  L.paintCols = (L.paintCols || []).filter((c) => c.name !== name); L._colStats = null; L._calcFns = null; columnsChanged(L);
  try {
    if (L.storage === 'project' && S.project && S.project.dir) { const rel = await layerRelpath(L, S.project.dir); try { await removeFileAt(S.project.dir, `${rel}.cols/${name}.parquet`); } catch { /* absent */ } try { await removeFileAt(S.project.dir, `${rel}.cols/${name}.f32`); } catch { /* absent */ } await persistElement(L); }
    else { const id = matColLooseId(L); const e2 = buildElementManifest(L); if (e2) await _idb.set(`matcol:${id}:element`, e2); }
  } catch { /* best-effort */ }
}
