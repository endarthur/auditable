// @gcu/sluice — grade-tonnage: a row-level accumulator.
//
// Bins a grade column; per bin accumulates tonnage and contained metal; result()
// returns the cumulative grade-tonnage curve (tonnage / mean grade / metal at or
// above each cutoff) — the resource geologist's headline view.
//
// Tonnage per block = volume × density, from a SERIALIZABLE model (a fixed
// blockVolume, or dx·dy·dz columns, × an optional density column) — column NAMES
// only, no closures, so it crosses to workers as a spec (the §7a contract).
//
// Note: this is a mining-domain accumulator living in the otherwise-generic
// sluice so that worker scans (which import only sluice) can rebuild it from a
// spec. A future spec-kind plugin registry could relocate it; the computation is
// the same wherever it lives.

import { cumulativeFromTop } from './histogram.js';

export function gradeTonnage({ grade, gradeMin, gradeMax, bins = 200, blockVolume = null, dims = null, density = null } = {}) {
  if (!grade) throw new Error('sluice: gradeTonnage needs a `grade` column');
  if (!(bins > 0) || !(gradeMax > gradeMin)) throw new Error('sluice: gradeTonnage needs bins>0 and gradeMax>gradeMin');
  const width = (gradeMax - gradeMin) / bins;

  const tonnageOf = (r) => {
    let v = blockVolume != null ? blockVolume : 1;
    if (dims) {
      const a = r[dims[0]], b = r[dims[1]], c = r[dims[2]];
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) v = Math.abs(a * b * c);
    }
    let d = 1;
    if (density) { const dv = r[density]; if (Number.isFinite(dv) && dv > 0) d = dv; }
    return v * d;
  };

  return {
    create: () => ({ min: gradeMin, width, bins, t: new Float64Array(bins), m: new Float64Array(bins), n: 0 }),
    push: (s, r) => {
      const g = r[grade];
      if (!Number.isFinite(g)) return;
      const ton = tonnageOf(r);
      if (!(ton > 0)) return;
      let i = Math.floor((g - s.min) / s.width);
      if (i < 0) i = 0; else if (i >= s.bins) i = s.bins - 1;
      s.t[i] += ton;
      s.m[i] += g * ton;
      s.n++;
    },
    merge: (a, b) => {
      const t = new Float64Array(a.bins), m = new Float64Array(a.bins);
      for (let i = 0; i < a.bins; i++) { t[i] = a.t[i] + b.t[i]; m[i] = a.m[i] + b.m[i]; }
      return { min: a.min, width: a.width, bins: a.bins, t, m, n: a.n + b.n };
    },
    result: (s) => {
      const cumT = cumulativeFromTop(s.t);
      const cumM = cumulativeFromTop(s.m);
      const curve = new Array(s.bins);
      for (let i = 0; i < s.bins; i++) {
        curve[i] = {
          cutoff: s.min + i * s.width,
          tonnage: cumT[i],
          grade: cumT[i] > 0 ? cumM[i] / cumT[i] : 0,
          metal: cumM[i],
        };
      }
      return { bins: s.bins, gradeMin: s.min, gradeMax: s.min + s.bins * s.width, count: s.n, curve };
    },
  };
}
