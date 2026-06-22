// @gcu/drillhole — validate: join + check the three tables. Nothing is silently
// dropped; every exclusion lands in the report with a count and a BHID list.
//
// The collar+survey join (dhJoinHoles) and per-hole station normalization
// (dhNormalizeHoleStations) are factored out so the point-sample locator
// (dhDesurveySamples) reuses the exact same hole-building — one join, two consumers.

import { dhDetectDipConvention, dhNormalizeSurveys } from './desurvey.js';

// Build the per-hole structure from collars + surveys (NOT normalized yet — callers
// normalize only the holes that pass their own gate, so a skipped hole doesn't accrue
// advisory counts). Returns { holes: bhid→{bhid,collar,eoh,rawSurveys}, order: [] }.
export function dhJoinHoles(tables, dipConvention, hit) {
  let holes = {}, order = [];
  for (let ci = 0; ci < (tables.collars || []).length; ci++) {
    let c0 = tables.collars[ci];
    let bid = String(c0.bhid).trim();
    if (!bid) { hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', null); continue; }
    if (!isFinite(c0.x) || !isFinite(c0.y) || !isFinite(c0.z)) {
      hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', bid);
      continue;
    }
    if (holes[bid]) { hit('dup-collar', 'Duplicate collar BHIDs (first kept)', bid); continue; }
    holes[bid] = { bhid: bid, collar: [c0.x, c0.y, c0.z], eoh: isFinite(c0.eoh) ? c0.eoh : null, rawSurveys: [] };
    order.push(bid);
  }
  for (let si = 0; si < (tables.surveys || []).length; si++) {
    let s0 = tables.surveys[si];
    let sb = String(s0.bhid).trim();
    let h = holes[sb];
    if (!h) { hit('orphan-survey', 'Survey rows whose BHID has no collar (excluded)', sb); continue; }
    h.rawSurveys.push({ depth: s0.depth, az: s0.az, dip: s0.dip });
  }
  return { holes: holes, order: order };
}

// Normalize one hole's raw surveys → hole.stations (pos-down, sorted, deduped, depth-0
// synthesized), with the no-usable-survey straight-down fallback and the survey-side
// past-EOH advisory. Counts ride into `hit`. Mutates + returns the hole.
export function dhNormalizeHoleStations(hole, dipConvention, hit) {
  let norm = dhNormalizeSurveys(hole.rawSurveys, dipConvention);
  if (norm.badCount) for (let bi = 0; bi < norm.badCount; bi++) hit('bad-survey', 'Survey rows with non-numeric depth/azimuth or |dip| > 90 (excluded)', hole.bhid);
  if (norm.dupCount) for (let di = 0; di < norm.dupCount; di++) hit('dup-survey-depth', 'Duplicate survey depths in a hole (last kept)', hole.bhid);
  if (norm.stations.length === 0) {
    hit('collar-no-survey', 'Holes with no usable survey (desurveyed straight down)', hole.bhid);
    norm.stations = [{ depth: 0, az: 0, dip: 90 }];
  }
  hole.stations = norm.stations;
  if (hole.eoh != null && norm.stations[norm.stations.length - 1].depth > hole.eoh + 1e-9) {
    hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hole.bhid);
  }
  return hole;
}

// tables = {
//   collars:  [{ bhid, x, y, z, eoh }],            // eoh optional/null
//   surveys:  [{ bhid, depth, az, dip }],          // dip raw (per file)
//   intervals: { bhid: [], from: [], to: [],
//                cols: [{ name, type: 'num'|'cat', values: [] }] }
// }
// opts = { dipConvention: 'auto'|'pos-down'|'neg-down', method }
export function dhValidate(tables, opts) {
  opts = opts || {};
  let checks = {};
  function hit(id, label, bhid) {
    let c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  let dipConvention = opts.dipConvention || 'auto';
  if (dipConvention === 'auto') dipConvention = dhDetectDipConvention(tables.surveys || []);

  let joined = dhJoinHoles(tables, dipConvention, hit);
  let holes = joined.holes, order = joined.order;
  for (let oi = 0; oi < order.length; oi++) holes[order[oi]].iv = [];

  // intervals
  let iv = tables.intervals || { bhid: [], from: [], to: [], cols: [] };
  let nIv = iv.bhid.length;
  for (let ii = 0; ii < nIv; ii++) {
    let ib = String(iv.bhid[ii]).trim();
    let h2 = holes[ib];
    if (!h2) { hit('orphan-interval', 'Interval rows whose BHID has no collar (excluded)', ib); continue; }
    let f = iv.from[ii], t = iv.to[ii];
    if (!isFinite(f) || !isFinite(t) || f < 0 || t <= f) {
      hit('bad-interval', 'Interval rows with FROM ≥ TO, negative or non-numeric depths (excluded)', ib);
      continue;
    }
    h2.iv.push(ii);
  }

  // per-hole structure (normalize only the holes that have intervals)
  let ready = [];
  for (let oi = 0; oi < order.length; oi++) {
    let hh = holes[order[oi]];
    if (hh.iv.length === 0) { hit('collar-no-intervals', 'Collars with no interval rows (hole skipped)', hh.bhid); continue; }

    dhNormalizeHoleStations(hh, dipConvention, hit);

    // interval-side past-EOH advisory (kept, counted)
    if (hh.eoh != null) {
      for (let ei = 0; ei < hh.iv.length; ei++) {
        if (iv.to[hh.iv[ei]] > hh.eoh + 1e-9) {
          hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
          break;
        }
      }
    }

    // overlap flag (composited as-is; SUPPORT double-counts — flagged per hole)
    let idx = hh.iv.slice().sort(function(a, b) { return iv.from[a] - iv.from[b]; });
    for (let vi = 1; vi < idx.length; vi++) {
      if (iv.from[idx[vi]] < iv.to[idx[vi - 1]] - 1e-9) {
        hit('overlap', 'Holes with overlapping intervals (composited as-is; SUPPORT double-counts)', hh.bhid);
        break;
      }
    }
    hh.iv = idx;
    ready.push(hh);
  }

  return { holes: ready, checks: checks, dipConvention: dipConvention, intervals: iv };
}
