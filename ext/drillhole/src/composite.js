// @gcu/drillhole — composite: fixed-length down-hole composites over validated holes.

import { dhDesurveyHole, dhPositionAt } from './desurvey.js';

// Tidied mode of (TO−FROM) — the default composite length (D3; a seed, always
// user-editable).
export function dhDefaultLength(intervals) {
  let counts = {};
  let n = intervals.from.length; // only FROM/TO matter — callers may omit bhid
  for (let i = 0; i < n; i++) {
    let len = intervals.to[i] - intervals.from[i];
    if (!isFinite(len) || len <= 0) continue;
    let key = (Math.round(len * 100) / 100).toFixed(2); // 1cm buckets
    counts[key] = (counts[key] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (let k in counts) { if (counts[k] > bestN) { bestN = counts[k]; best = parseFloat(k); } }
  return best || 1;
}

// Fixed-length down-hole composites over validated holes.
// opts = { length, domainColName|null, splitColNames|null, densityColName|null,
//          combine|null, minCoverage (0..1)|null, method }
// Numeric: length-weighted mean over covered length WITH a value (missing assays
// shrink that column's weight, never poison the mean; no value in the window → null).
// Categorical: majority by covered length (D6). SUPPORT = total covered length (D5:
// low coverage emitted, not dropped; the optional minCoverage filter is visible and
// counted). XYZ = the covered-length centroid depth on the desurveyed path.
export function dhComposite(validated, opts) {
  let ivt = validated.intervals;
  let cols = ivt.cols || [];
  let L = opts.length;
  let densityIdx = -1;
  for (let dci = 0; dci < cols.length; dci++) {
    // optional mass weighting — numeric means weight by length × density (the density
    // column itself stays length-weighted). Missing density on an interval excludes it
    // from mass-weighting and is counted (never silent).
    if (opts.densityColName && cols[dci].name === opts.densityColName && cols[dci].type === 'num') densityIdx = dci;
  }
  // split columns — composites restart where the TUPLE of these columns changes (any
  // one flips → new composite). Generalizes the single domain break; falls back to
  // [domainColName] for back-compat. Each split column is constant within a run by
  // construction, so it rides into the output 1:1.
  let splitNames = (opts.splitColNames && opts.splitColNames.length) ? opts.splitColNames
    : (opts.domainColName ? [opts.domainColName] : []);
  let splitIdxs = [];
  for (let si = 0; si < splitNames.length; si++) {
    for (let sj = 0; sj < cols.length; sj++) { if (cols[sj].name === splitNames[si]) { splitIdxs.push(sj); break; } }
  }
  // per-column combine rules keyed by column name. Numeric: 'mean' (default,
  // length/mass-weighted), 'sum' (Σ length×value), 'min', 'max'. Categorical:
  // 'majority' (default, by covered length), 'first' (shallowest). An unknown rule for
  // a column's type falls back to that type's default.
  let combineMap = opts.combine || {};
  let checks = validated.checks;
  function hit(id, label, bhid) {
    let c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  let header = ['BHID', 'X', 'Y', 'Z', 'FROM', 'TO', 'SUPPORT'];
  for (let hc = 0; hc < cols.length; hc++) header.push(cols[hc].name);
  let rows = [];

  for (let hI = 0; hI < validated.holes.length; hI++) {
    let hole = validated.holes[hI];
    let path = dhDesurveyHole(hole.collar, hole.stations, opts.method);
    let idx = hole.iv; // sorted by FROM

    // domain runs: contiguous spans sharing the split tuple (D4) — composites restart
    // at every change; without split columns the whole hole is one run. Run extent =
    // min(FROM)…max(TO) over the run (sorted by FROM, so max(TO) needs a scan — an
    // early long interval can outrun the last one).
    function makeRun(slice) {
      let maxTo = -Infinity;
      for (let mi = 0; mi < slice.length; mi++) maxTo = Math.max(maxTo, ivt.to[slice[mi]]);
      return { from: ivt.from[slice[0]], to: maxTo, idx: slice };
    }
    let SPLIT_SEP = String.fromCharCode(31);   // unit separator → no cross-column key collisions
    function splitKey(r2) {
      let parts = [];
      for (let sk = 0; sk < splitIdxs.length; sk++) parts.push(String(cols[splitIdxs[sk]].values[r2]));
      return parts.join(SPLIT_SEP);
    }
    let runs = [];
    if (!splitIdxs.length) {
      runs.push(makeRun(idx));
    } else {
      let runStart = 0, startKey = idx.length ? splitKey(idx[0]) : '';
      for (let ri = 1; ri <= idx.length; ri++) {
        let changed = ri === idx.length || splitKey(idx[ri]) !== startKey;
        if (changed) {
          runs.push(makeRun(idx.slice(runStart, ri)));
          runStart = ri;
          if (ri < idx.length) startKey = splitKey(idx[ri]);
        }
      }
    }

    for (let rI = 0; rI < runs.length; rI++) {
      let run = runs[rI];
      let nWin = Math.ceil((run.to - run.from - 1e-9) / L);
      for (let wI = 0; wI < nWin; wI++) {
        let w0 = run.from + wI * L; // index-stepped: no float drift over long holes
        let w1 = Math.min(w0 + L, run.to);
        let covered = 0, centroidW = 0, hadMissingDensity = false;
        let numW = new Float64Array(cols.length);
        let numSum = new Float64Array(cols.length);
        let numLSum = new Float64Array(cols.length);     // Σ length×value (for 'sum')
        let numMin = new Float64Array(cols.length);
        let numMax = new Float64Array(cols.length);
        let seenNum = new Uint8Array(cols.length);
        let catW = [], catFirst = []; // per col: {value → weight}, and first value by depth
        for (let ci2 = 0; ci2 < cols.length; ci2++) { catW.push(null); catFirst.push(undefined); numMin[ci2] = Infinity; numMax[ci2] = -Infinity; }

        for (let k2 = 0; k2 < run.idx.length; k2++) {
          let r = run.idx[k2];
          let ovFrom = Math.max(w0, ivt.from[r]);
          let ovTo = Math.min(w1, ivt.to[r]);
          let ov = ovTo - ovFrom;
          if (ov <= 1e-12) continue;
          covered += ov;
          centroidW += ov * (ovFrom + ovTo) / 2;
          // mass weight for numeric grades when a density column is set; the density
          // column itself stays length-weighted (no self-reference).
          let massW = ov;
          if (densityIdx >= 0) {
            let dval = cols[densityIdx].values[r];
            if (typeof dval === 'number' && isFinite(dval) && dval > 0) massW = ov * dval;
            else { massW = 0; hadMissingDensity = true; }
          }
          for (let c3 = 0; c3 < cols.length; c3++) {
            let v = cols[c3].values[r];
            if (cols[c3].type === 'num') {
              let nw = (c3 === densityIdx) ? ov : massW;   // density col: length-weighted
              if (typeof v === 'number' && isFinite(v)) {
                numW[c3] += nw; numSum[c3] += nw * v;       // weighted mean
                numLSum[c3] += ov * v;                       // length integral (sum)
                if (v < numMin[c3]) numMin[c3] = v;
                if (v > numMax[c3]) numMax[c3] = v;
                seenNum[c3] = 1;
              }
            } else {
              if (v != null && v !== '') {
                if (!catW[c3]) catW[c3] = {};
                let sk = String(v);
                catW[c3][sk] = (catW[c3][sk] || 0) + ov;
                if (catFirst[c3] === undefined) catFirst[c3] = sk;   // run is FROM-sorted → shallowest first
              }
            }
          }
        }
        if (covered <= 1e-12) continue; // window entirely in a gap — nothing to emit

        if (opts.minCoverage && covered / (w1 - w0) < opts.minCoverage) {
          hit('low-coverage-filtered', 'Composites below the min-coverage filter (dropped — filter is user-set)', hole.bhid);
          continue;
        }
        if (hadMissingDensity) hit('missing-density', 'Composites with intervals lacking usable density (excluded from mass-weighting)', hole.bhid);

        let midDepth = centroidW / covered;
        let pos = dhPositionAt(path, midDepth);
        let row = [hole.bhid, pos[0], pos[1], pos[2], w0, w1, covered];
        for (let c4 = 0; c4 < cols.length; c4++) {
          if (cols[c4].type === 'num') {
            let nrule = combineMap[cols[c4].name];
            if (nrule === 'sum') row.push(seenNum[c4] ? numLSum[c4] : null);
            else if (nrule === 'min') row.push(seenNum[c4] ? numMin[c4] : null);
            else if (nrule === 'max') row.push(seenNum[c4] ? numMax[c4] : null);
            else row.push(numW[c4] > 0 ? numSum[c4] / numW[c4] : null);   // 'mean' (default)
          } else {
            if (combineMap[cols[c4].name] === 'first') { row.push(catFirst[c4] !== undefined ? catFirst[c4] : null); continue; }
            let bag = catW[c4];
            if (!bag) { row.push(null); continue; }
            let bestV = null, bestW = -1, total = 0;
            for (let key2 in bag) { total += bag[key2]; if (bag[key2] > bestW) { bestW = bag[key2]; bestV = key2; } }
            if (bestW < total - 1e-9) hit('mixed-domain', 'Composites whose categorical majority is < 100% of covered length', hole.bhid);
            row.push(bestV);
          }
        }
        rows.push(row);
      }
    }
  }

  return { header: header, rows: rows };
}
