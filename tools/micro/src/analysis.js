// micro analysis core — the pure compute behind the GT / swath / validation
// windows: numeric-column census, block-support volumes (sub-blocked aware),
// grade-tonnage, swath profiles, and the drillhole sample extract + declustered
// sample swath. Streams via layerRecords (record numbering + census-extended
// rows come from there); ensureStoredValues faults evicted matcols back in at
// every scan head. No DOM — the windows drive these and own the drawing.
import { convert as unitConvert } from '../../../ext/units/index.js';
import { layerTableHeader, colIsNumeric, schemaExt, layerRecords, attrRowCountOf } from './records.js';
import { ensureStoredValues } from './columns.js';
import { gridAxesOf } from './grid-ops.js';

export function numericColsOf(L) {
  const h = layerTableHeader(L); if (!h) return []; const m = h.mapping || {};
  const base = h.columns.filter((_, i) => colIsNumeric(L, h, i) && ![m.x, m.y, m.z].includes(i));
  const calc = (L.calcCols || []).filter((c) => c.ty !== 'string').map((c) => c.name);       // computed columns
  const paintNum = (L.paintCols || []).filter((c) => c.kind === 'ratio').map((c) => c.name);   // ratio incl. MATERIALIZED (estimated) columns
  return [...base, ...calc, ...paintNum];                                                       // GT/swath/stats read these via schemaExt + extendRow
}
export function blockVolumeOf(L) { const a = gridAxesOf(L); return a ? (Math.abs((a.x.pitch || 1) * (a.y.pitch || 1) * (a.z.pitch || 1)) || 1) : 1; }
// A sub-blocked model's blocks are NOT all the fine-lattice size — each carries
// its own DIMX/Y/Z. GT/swath weighted every block by the constant fine pitch, so
// a big parent block counted as one fine cell: tonnage silently under-weighted.
// This returns a per-record volume from the row when the model is sub-blocked
// (the dim columns are indices into the same row layerRecords yields), and the
// constant otherwise. `vc` is the precomputed {dc, base} so the hot path is a
// multiply, not a header lookup per record.
export function volumeContextOf(L) {
  const bd = L.docs && L.docs.blockDoc, h = bd && bd.header;
  const base = blockVolumeOf(L);
  const dc = h && h.subBlocked && h.dimCols;               // { x, y, z } → column indices, or falsy
  return { base, dc };
}
export function volumeAt(vc, f) {
  if (!vc.dc) return vc.base;
  const dx = +f[vc.dc.x], dy = +f[vc.dc.y], dz = +f[vc.dc.z];
  const v = Math.abs(dx * dy * dz);
  return v > 0 ? v : vc.base;                              // a missing/zero dim → the fine pitch, honest not zero
}
// grade-tonnage: for each series column, cutoff → (tonnage above, mean grade above)
// weight: a column name (back-compat) or { col?, const?, unit? } — `unit` is a
// DECLARED density unit ('t/m3' | 'kg/m3' | 'lb/ft3'…), converted to t/m³ via
// @gcu/units so tonnage comes out in actual tonnes; `const` is a fixed density
// for models without a density column.
export async function computeGT(L, cols, weightCol, nCut, onProgress, selMask) {
  const wspec = typeof weightCol === 'string' ? { col: weightCol } : (weightCol || {});
  await ensureStoredValues(L, new Set([...cols, wspec.col].filter(Boolean).map((x) => String(x).toLowerCase())));
  const h = layerTableHeader(L), schema = schemaExt(L, h), nameIdx = (nm) => schema.findIndex((c) => c.name === nm);
  const idx = cols.map(nameIdx);                            // via schemaExt → source AND derived (calc/estimated) columns
  const wi = wspec.col ? nameIdx(wspec.col) : -1, vol = blockVolumeOf(L);
  const dScale = wspec.unit ? unitConvert(1, wspec.unit, 't/m3') : 1;
  const dConst = wspec.const != null && Number.isFinite(+wspec.const) ? +wspec.const : null;
  const ser = cols.map(() => ({ g: [], w: [] }));
  let gmin = Infinity, gmax = -Infinity, rc = 0;
  for await (const { f, rec: rAt } of layerRecords(L)) {
    rc++;
    if (!selMask || (rAt < selMask.length && selMask[rAt])) {
      const wt = (wi >= 0 ? (+f[wi] || 0) : dConst != null ? dConst : 1) * dScale * vol;
      for (let s = 0; s < idx.length; s++) { const v = +f[idx[s]]; if (Number.isFinite(v)) { ser[s].g.push(v); ser[s].w.push(wt); if (v < gmin) gmin = v; if (v > gmax) gmax = v; } }
    }
    if ((rc & 0xffff) === 0) { if (onProgress) onProgress(rc); await new Promise((r) => setTimeout(r)); }   // yield per 64k, not per batch
  }
  if (onProgress) onProgress(rc);
  if (!Number.isFinite(gmin)) return null;
  const cuts = []; for (let i = 0; i <= nCut; i++) cuts.push(gmin + (gmax - gmin) * i / nCut);
  const gt = ser.map((d) => {
    const ord = [...d.g.keys()].sort((a, b) => d.g[b] - d.g[a]);   // grade desc
    const cw = new Float64Array(ord.length + 1), cwg = new Float64Array(ord.length + 1);
    for (let k = 0; k < ord.length; k++) { cw[k + 1] = cw[k] + d.w[ord[k]]; cwg[k + 1] = cwg[k] + d.w[ord[k]] * d.g[ord[k]]; }
    const gsorted = ord.map((i) => d.g[i]);
    return cuts.map((c) => {
      let lo = 0, hi = gsorted.length; while (lo < hi) { const md = (lo + hi) >> 1; if (gsorted[md] >= c) lo = md + 1; else hi = md; }
      return { cut: c, tonnage: cw[lo], grade: cw[lo] > 0 ? cwg[lo] / cw[lo] : NaN };
    });
  });
  return { cuts, gt, gmin, gmax, weighted: wi >= 0 || dConst != null };
}
// per band along dir: tonnage-weighted mean grade for each series + count/tonnage
export async function computeSwath(L, cols, dir, bandWidth, offset, weightCol, onProgress, selMask) {
  await ensureStoredValues(L, new Set([...cols, weightCol].filter(Boolean).map((x) => String(x).toLowerCase())));
  const h = layerTableHeader(L), m = h.mapping, schema = schemaExt(L, h), nameIdx = (nm) => schema.findIndex((c) => c.name === nm);
  const idx = cols.map(nameIdx);                            // source AND derived (calc/estimated) columns
  const wi = weightCol ? nameIdx(weightCol) : -1, vol = blockVolumeOf(L);
  const bands = new Map(); let rc = 0;                     // layerRecords owns the record number now
  for await (const { f, rec: rAt } of layerRecords(L)) {
    {
      rc++;
      const inSel = !selMask || (rAt < selMask.length && selMask[rAt]);
      if (!inSel) continue;
      const x = +f[m.x], y = +f[m.y], z = +f[m.z]; if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const t = x * dir[0] + y * dir[1] + z * dir[2], bi = Math.floor((t - offset) / bandWidth);
      let e = bands.get(bi); if (!e) { e = { w: new Float64Array(cols.length), wg: new Float64Array(cols.length), tw: 0, n: 0 }; bands.set(bi, e); }
      const wt = (wi >= 0 ? (+f[wi] || 0) : 1) * vol; e.tw += wt; e.n++;
      for (let s = 0; s < idx.length; s++) { const v = +f[idx[s]]; if (Number.isFinite(v)) { e.w[s] += wt; e.wg[s] += wt * v; } }
    }
    if ((rc & 0xffff) === 0) { if (onProgress) onProgress(rc); await new Promise((r) => setTimeout(r)); }   // yield per 64k, not per batch
  }
  if (onProgress) onProgress(rc);
  const keys = [...bands.keys()].sort((a, b) => a - b);
  const profile = keys.map((bi) => { const e = bands.get(bi); return { band: bi, center: offset + (bi + 0.5) * bandWidth, mean: cols.map((_, s) => (e.w[s] > 0 ? e.wg[s] / e.w[s] : NaN)), tonnage: e.tw, count: e.n }; });
  return { profile, weighted: wi >= 0 };
}
// drillhole samples for validation: desurveyed interval midpoints + one grade
export function extractSamples(D, gradeCol) {
  const dh = D.docs && D.docs.dhDoc, h = layerTableHeader(D); if (!dh || !h) return [];
  const gi = h.columns.indexOf(gradeCol); if (gi < 0) return [];
  const n = attrRowCountOf(D), rows = [];
  for (let r = 0; r < n; r++) { const pos = dh.recordPosition(r); if (!pos) continue; const rec = dh.fetchRecord(r); const g = rec ? +rec[gi] : NaN; if (Number.isFinite(g)) rows.push([pos[0], pos[1], pos[2], g]); }
  return rows;
}
export function autoDeclusterSizes(samples) {
  let xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity;
  for (const s of samples) { if (s[0] < xmn) xmn = s[0]; if (s[0] > xmx) xmx = s[0]; if (s[1] < ymn) ymn = s[1]; if (s[1] > ymx) ymx = s[1]; }
  const ext = Math.max(xmx - xmn, ymx - ymn) || 100;
  // GEOMETRIC sweep fine → ~half-extent, so it spans the drill spacing (the
  // scale that matters) whatever it is, not just the fine end
  const lo = ext / 100, hi = ext / 2, N = 24, sizes = [];
  for (let k = 0; k < N; k++) sizes.push(+(lo * Math.pow(hi / lo, k / (N - 1))).toPrecision(3));
  return sizes;
}
export function computeSampleSwath(samples, weights, dir, bandWidth, offset) {
  const bands = new Map();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], t = s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2], bi = Math.floor((t - offset) / bandWidth), w = weights ? weights[i] : 1;
    let e = bands.get(bi); if (!e) { e = { sw: 0, swg: 0, n: 0 }; bands.set(bi, e); }
    e.sw += w; e.swg += w * s[3]; e.n++;
  }
  return [...bands.keys()].sort((a, b) => a - b).map((bi) => { const e = bands.get(bi); return { center: offset + (bi + 0.5) * bandWidth, mean: e.sw > 0 ? e.swg / e.sw : NaN, count: e.n }; });
}
