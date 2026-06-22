// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/drillhole — Pure drillhole desurvey + fixed-length down-hole compositing (minimum curvature / balanced tangential / tangential), with a non-silent consistency report. Collars + surveys + intervals → composites ready for estimation.

// ── src/desurvey.js ──

// @gcu/drillhole — desurvey: collar + survey stations → the 3D hole trace, and a
// method-consistent position at any down-hole depth.
//
// Conventions (D1): azimuth = degrees clockwise from north; dip = MINING convention,
// positive DOWN (normalizeSurveys flips neg-down files; detectDipConvention infers
// from the median); depths/lengths in any consistent unit (metres in practice).
// World frame: x = east, y = north, z = up.
//
// Reverse-vendored from BMA (A7 Phase 0, Arthur 2026-06-11) — developed there in the
// concat-source style, always intended to live here. BMA + dee re-vendor from here now.

// Unit tangent from azimuth/dip (mining pos-down): x east, y north, z up.
function dhTangent(azDeg, dipDeg) {
  let az = azDeg * Math.PI / 180, dip = dipDeg * Math.PI / 180;
  let c = Math.cos(dip);
  return [Math.sin(az) * c, Math.cos(az) * c, -Math.sin(dip)];
}

// 'pos-down' (mining: +60 = 60° below horizontal) vs 'neg-down' (signed math: -60 =
// below). Inferred from the median dip — exploration holes point down, so the sign of
// the bulk tells the convention.
function dhDetectDipConvention(surveys) {
  let dips = [];
  for (let i = 0; i < surveys.length; i++) {
    let d = surveys[i].dip;
    if (typeof d === 'number' && isFinite(d) && d !== 0) dips.push(d);
  }
  if (dips.length === 0) return 'pos-down';
  dips.sort(function(a, b) { return a - b; });
  let med = dips[Math.floor(dips.length / 2)];
  return med < 0 ? 'neg-down' : 'pos-down';
}

// Sort, dedupe (last wins), normalize dip to pos-down, synthesize a station at depth 0
// when the list starts deeper (copies the first attitude). Returns { stations:
// [{depth, az, dip}], dupCount, badCount }.
function dhNormalizeSurveys(rawSurveys, dipConvention) {
  let flip = dipConvention === 'neg-down' ? -1 : 1;
  let clean = [], badCount = 0;
  for (let i = 0; i < rawSurveys.length; i++) {
    let s = rawSurveys[i];
    let depth = s.depth, az = s.az, dip = s.dip * flip;
    if (!isFinite(depth) || depth < 0 || !isFinite(az) || !isFinite(dip) || Math.abs(dip) > 90.000001) {
      badCount++;
      continue;
    }
    clean.push({ depth: depth, az: az, dip: dip });
  }
  clean.sort(function(a, b) { return a.depth - b.depth; });
  let stations = [], dupCount = 0;
  for (let j = 0; j < clean.length; j++) {
    if (stations.length && Math.abs(stations[stations.length - 1].depth - clean[j].depth) < 1e-9) {
      stations[stations.length - 1] = clean[j]; // last wins
      dupCount++;
    } else {
      stations.push(clean[j]);
    }
  }
  if (stations.length && stations[0].depth > 1e-9) {
    stations.unshift({ depth: 0, az: stations[0].az, dip: stations[0].dip });
  }
  return { stations: stations, dupCount: dupCount, badCount: badCount };
}

// Desurvey one hole. Methods:
// - 'minimumCurvature' (default): circular-arc model, RF = (2/θ)·tan(θ/2)
// - 'balancedTangential': the same without RF — averages the two end tangents per
//   segment (matches legacy desurveys from several packages)
// - 'tangential': straight segments along the LOWER station's attitude (sparse/legacy
//   surveys; matches dee's simple-tangential seed)
// collar = [x, y, z]; stations from dhNormalizeSurveys (pos-down). Returns { method,
// depths, px, py, pz, tx, ty, tz, dogleg, dls } — tangents + method ride along so
// dhPositionAt interpolates consistently. `dogleg[k]` is the angular change (degrees)
// between stations k−1 and k; `dls[k]` is the dogleg SEVERITY in °/30 length-units (the
// metric drilling-QC convention — multiply by ⅓ for °/10 m, or recompute from `dogleg`
// for °/100 ft). Both are geometry of the survey attitudes — independent of `method` —
// so they're the same whichever desurvey you pick. dogleg[0] = dls[0] = 0.
function dhDesurveyHole(collar, stations, method) {
  method = method || 'minimumCurvature';
  let n = stations.length;
  let out = {
    method: method,
    depths: new Float64Array(n),
    px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), tz: new Float64Array(n),
    dogleg: new Float64Array(n), dls: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    out.depths[i] = stations[i].depth;
    let t = dhTangent(stations[i].az, stations[i].dip);
    out.tx[i] = t[0]; out.ty[i] = t[1]; out.tz[i] = t[2];
  }
  out.px[0] = collar[0]; out.py[0] = collar[1]; out.pz[0] = collar[2];

  for (let k = 1; k < n; k++) {
    let dl = out.depths[k] - out.depths[k - 1];
    // dogleg angle between the two station tangents — drives both the min-curvature RF
    // and the QC severity, and is the same for every method (it's the survey geometry).
    let dot = out.tx[k - 1] * out.tx[k] + out.ty[k - 1] * out.ty[k] + out.tz[k - 1] * out.tz[k];
    let doglegRad = Math.acos(Math.max(-1, Math.min(1, dot)));
    out.dogleg[k] = doglegRad * 180 / Math.PI;
    out.dls[k] = dl > 1e-12 ? out.dogleg[k] / dl * 30 : 0;
    if (method === 'tangential') {
      out.px[k] = out.px[k - 1] + dl * out.tx[k];
      out.py[k] = out.py[k - 1] + dl * out.ty[k];
      out.pz[k] = out.pz[k - 1] + dl * out.tz[k];
    } else {
      let rf = 1; // balanced tangential
      // minimum curvature: RF = (2/θ)·tan(θ/2)
      if (method !== 'balancedTangential') rf = doglegRad > 1e-6 ? (2 / doglegRad) * Math.tan(doglegRad / 2) : 1;
      out.px[k] = out.px[k - 1] + 0.5 * dl * (out.tx[k - 1] + out.tx[k]) * rf;
      out.py[k] = out.py[k - 1] + 0.5 * dl * (out.ty[k - 1] + out.ty[k]) * rf;
      out.pz[k] = out.pz[k - 1] + 0.5 * dl * (out.tz[k - 1] + out.tz[k]) * rf;
    }
  }
  return out;
}

// Position at an arbitrary down-hole depth, consistent with the hole's desurvey method
// (depths between stations land on the SAME path the stations were placed on):
// - minimumCurvature: arc-correct (D2) — the closed-form integral of the slerp of the
//   end tangents: p(s) = p1 + L/(θ·sinθ)·[(cos(θ−φ) − cosθ)·d1 + (1 − cosφ)·d2],
//   φ = θ·s/L (at s = L this reduces to the RF endpoint formula; the harness pins
//   mid-segment points to an analytic circle at 1e-14)
// - tangential: straight along the lower station's attitude (how the segment was built)
// - balancedTangential: linear along the segment chord
// Beyond the last station: straight extrapolation along the last tangent (standard
// practice — intervals routinely outrun the survey).
function dhPositionAt(hole, depth) {
  let d = hole.depths, n = d.length;
  if (n === 0) return null;
  if (depth <= d[0]) {
    let s0 = depth - d[0]; // above collar station (negative) — straight
    return [hole.px[0] + s0 * hole.tx[0], hole.py[0] + s0 * hole.ty[0], hole.pz[0] + s0 * hole.tz[0]];
  }
  if (depth >= d[n - 1]) {
    let sE = depth - d[n - 1];
    return [hole.px[n - 1] + sE * hole.tx[n - 1], hole.py[n - 1] + sE * hole.ty[n - 1], hole.pz[n - 1] + sE * hole.tz[n - 1]];
  }
  // binary search: segment [lo, lo+1] with d[lo] <= depth < d[lo+1]
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    let mid = (lo + hi) >> 1;
    if (d[mid] <= depth) lo = mid; else hi = mid;
  }
  let L = d[lo + 1] - d[lo], s = depth - d[lo];
  if (L < 1e-12) return [hole.px[lo], hole.py[lo], hole.pz[lo]];

  if (hole.method === 'tangential') {
    return [
      hole.px[lo] + s * hole.tx[lo + 1],
      hole.py[lo] + s * hole.ty[lo + 1],
      hole.pz[lo] + s * hole.tz[lo + 1],
    ];
  }
  if (hole.method === 'balancedTangential') {
    let t = s / L;
    return [
      hole.px[lo] + t * (hole.px[lo + 1] - hole.px[lo]),
      hole.py[lo] + t * (hole.py[lo + 1] - hole.py[lo]),
      hole.pz[lo] + t * (hole.pz[lo + 1] - hole.pz[lo]),
    ];
  }

  let d1 = [hole.tx[lo], hole.ty[lo], hole.tz[lo]];
  let d2 = [hole.tx[lo + 1], hole.ty[lo + 1], hole.tz[lo + 1]];
  let dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  let theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (theta < 1e-9) {
    return [hole.px[lo] + s * d1[0], hole.py[lo] + s * d1[1], hole.pz[lo] + s * d1[2]];
  }
  let phi = theta * s / L;
  let kk = L / (theta * Math.sin(theta));
  let a = (Math.cos(theta - phi) - Math.cos(theta)) * kk;
  let b = (1 - Math.cos(phi)) * kk;
  return [
    hole.px[lo] + a * d1[0] + b * d2[0],
    hole.py[lo] + a * d1[1] + b * d2[1],
    hole.pz[lo] + a * d1[2] + b * d2[2],
  ];
}

// ── src/validate.js ──

// @gcu/drillhole — validate: join + check the three tables. Nothing is silently
// dropped; every exclusion lands in the report with a count and a BHID list.
//
// The collar+survey join (dhJoinHoles) and per-hole station normalization
// (dhNormalizeHoleStations) are factored out so the point-sample locator
// (dhDesurveySamples) reuses the exact same hole-building — one join, two consumers.


// Build the per-hole structure from collars + surveys (NOT normalized yet — callers
// normalize only the holes that pass their own gate, so a skipped hole doesn't accrue
// advisory counts). Returns { holes: bhid→{bhid,collar,eoh,rawSurveys}, order: [] }.
function dhJoinHoles(tables, dipConvention, hit) {
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
function dhNormalizeHoleStations(hole, dipConvention, hit) {
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
function dhValidate(tables, opts) {
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

// ── src/composite.js ──

// @gcu/drillhole — composite: fixed-length down-hole composites over validated holes.


// Tidied mode of (TO−FROM) — the default composite length (D3; a seed, always
// user-editable).
function dhDefaultLength(intervals) {
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
function dhComposite(validated, opts) {
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

// ── src/samples.js ──

// @gcu/drillhole — point-sample locator. Some data is point-support, not intervals:
// single-depth assays (handheld XRF, density readings) or already-composited samples
// re-imported. Compositing (length-weighting into windows) doesn't apply — you just
// want each sample placed in 3D on the desurveyed trace. This is that path; it reuses
// the same collar+survey join + station normalization as dhValidate.


// tables = { collars, surveys, samples: { bhid:[], depth:[], cols:[{name,type,values}] } }
// opts   = { dipConvention, method }
// Returns { header: ['BHID','X','Y','Z','DEPTH', ...cols], rows, report } — one located
// row per valid sample (sorted down-hole within each hole), with the same non-silent
// consistency report style as the interval pipeline.
function dhDesurveySamples(tables, opts) {
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
  for (let oi = 0; oi < order.length; oi++) holes[order[oi]].smp = [];

  // samples → per-hole index lists
  let smp = tables.samples || { bhid: [], depth: [], cols: [] };
  let cols = smp.cols || [];
  let nS = smp.bhid.length;
  for (let ii = 0; ii < nS; ii++) {
    let bid = String(smp.bhid[ii]).trim();
    let h = holes[bid];
    if (!h) { hit('orphan-sample', 'Sample rows whose BHID has no collar (excluded)', bid); continue; }
    let d = smp.depth[ii];
    if (!isFinite(d) || d < 0) { hit('bad-sample', 'Sample rows with negative or non-numeric depth (excluded)', bid); continue; }
    h.smp.push(ii);
  }

  let header = ['BHID', 'X', 'Y', 'Z', 'DEPTH'];
  for (let hc = 0; hc < cols.length; hc++) header.push(cols[hc].name);
  let rows = [];
  let nHoles = 0;

  for (let oi = 0; oi < order.length; oi++) {
    let hh = holes[order[oi]];
    if (hh.smp.length === 0) { hit('collar-no-samples', 'Collars with no sample rows (hole skipped)', hh.bhid); continue; }
    dhNormalizeHoleStations(hh, dipConvention, hit);
    let path = dhDesurveyHole(hh.collar, hh.stations, opts.method);
    nHoles++;

    // EOH advisory (kept, counted)
    if (hh.eoh != null) {
      for (let ei = 0; ei < hh.smp.length; ei++) {
        if (smp.depth[hh.smp[ei]] > hh.eoh + 1e-9) {
          hit('past-eoh', 'Sample depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
          break;
        }
      }
    }

    let idx = hh.smp.slice().sort(function(a, b) { return smp.depth[a] - smp.depth[b]; });
    for (let k = 0; k < idx.length; k++) {
      let ii = idx[k], d = smp.depth[ii];
      let pos = dhPositionAt(path, d);
      let row = [hh.bhid, pos[0], pos[1], pos[2], d];
      for (let c = 0; c < cols.length; c++) row.push(cols[c].values[ii]);
      rows.push(row);
    }
  }

  let checkList = [];
  for (let k in checks) checkList.push(checks[k]);
  return { header: header, rows: rows, report: { checks: checkList, nHoles: nHoles, nSamples: rows.length, dipConvention: dipConvention } };
}

// ── src/merge.js ──

// @gcu/drillhole — merge: the down-hole interval join (A11 P4).
//
// Merge two down-hole interval tables on (BHID, FROM/TO) where their breaks need not
// align. UNION RE-SEGMENT (the design default): the merged breaks per hole are the
// sorted union of both tables' FROM/TO, so every output segment lies within at most
// ONE interval of each table — columns are CARRIED verbatim, no aggregation. A segment
// with no counterpart on one side null-fills that side's columns and is COUNTED (never
// a silent drop); a segment covered by neither is not a real interval and is skipped.
// Overlapping intervals within one table over a segment are flagged (first wins).
// Column-name clashes between the tables are renamed (suffix tagB) and counted.
//
// Inputs are the columnar interval shape { bhid:[], from:[], to:[],
// cols:[{name,type,values}] } (same as validate().intervals). Returns the merged table
// in that shape + a { checks, nRows, nHoles } report. Pure; no aggregation rules here —
// those belong to compositing, which runs on the merged table.
function dhMergeIntervals(A, B, opts) {
  opts = opts || {};
  let tagB = opts.tagB || '2';
  let checks = {};
  function hit(id, label, bhid) {
    let c = checks[id] || (checks[id] = { id: id, label: label, count: 0, bhids: [] });
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }
  function groupByHole(T) {
    let g = {};
    for (let i = 0; i < T.bhid.length; i++) (g[T.bhid[i]] || (g[T.bhid[i]] = [])).push(i);
    return g;
  }
  // covering intervals of table T (index list idxList) at down-hole midpoint mid
  function covering(T, idxList, mid) {
    let out = [];
    for (let i = 0; i < idxList.length; i++) {
      let r = idxList[i];
      if (T.from[r] <= mid && mid <= T.to[r]) out.push(r);
    }
    return out;
  }

  // merged column layout: A's columns keep their names; a B column clashing with an
  // existing name gets suffixed (and counted).
  let used = {}, outCols = [];
  for (let a = 0; a < A.cols.length; a++) { used[A.cols[a].name] = true; outCols.push({ name: A.cols[a].name, type: A.cols[a].type, side: 'A', src: a }); }
  for (let b = 0; b < B.cols.length; b++) {
    let nm = B.cols[b].name;
    if (used[nm]) { let nn = nm + '_' + tagB, kk = 2; while (used[nn]) nn = nm + '_' + tagB + (kk++); hit('column-collision', 'Columns renamed to avoid a clash with the other table', null); nm = nn; }
    used[nm] = true;
    outCols.push({ name: nm, type: B.cols[b].type, side: 'B', src: b });
  }

  let gA = groupByHole(A), gB = groupByHole(B);
  let holeOrder = [], seen = {};
  for (let ai = 0; ai < A.bhid.length; ai++) if (!seen[A.bhid[ai]]) { seen[A.bhid[ai]] = true; holeOrder.push(A.bhid[ai]); }
  for (let bi = 0; bi < B.bhid.length; bi++) if (!seen[B.bhid[bi]]) { seen[B.bhid[bi]] = true; holeOrder.push(B.bhid[bi]); }

  let outBhid = [], outFrom = [], outTo = [];
  let outVals = outCols.map(function() { return []; });

  for (let ho = 0; ho < holeOrder.length; ho++) {
    let hole = holeOrder[ho];
    let ia = gA[hole] || [], ib = gB[hole] || [];
    if (!ia.length) hit('hole-only-b', 'Holes only in the second table (first-table columns null)', hole);
    if (!ib.length) hit('hole-only-a', 'Holes only in the first table (second-table columns null)', hole);

    let bps = [];
    for (let x = 0; x < ia.length; x++) { bps.push(A.from[ia[x]]); bps.push(A.to[ia[x]]); }
    for (let y = 0; y < ib.length; y++) { bps.push(B.from[ib[y]]); bps.push(B.to[ib[y]]); }
    bps.sort(function(p, q) { return p - q; });
    let uniq = [];
    for (let u = 0; u < bps.length; u++) if (!uniq.length || bps[u] - uniq[uniq.length - 1] > 1e-9) uniq.push(bps[u]);

    for (let s = 0; s + 1 < uniq.length; s++) {
      let a0 = uniq[s], a1 = uniq[s + 1];
      if (a1 - a0 <= 1e-9) continue;
      let mid = (a0 + a1) / 2;
      let ca = covering(A, ia, mid), cb = covering(B, ib, mid);
      if (ca.length > 1) hit('overlap-a', 'Merged segments covered by overlapping first-table intervals (first wins)', hole);
      if (cb.length > 1) hit('overlap-b', 'Merged segments covered by overlapping second-table intervals (first wins)', hole);
      let ra = ca.length ? ca[0] : -1, rb = cb.length ? cb[0] : -1;
      if (ra < 0 && rb < 0) continue;   // gap on both sides — not a real interval
      if (ra < 0) hit('gap-a', 'Merged segments with no first-table interval (its columns null)', hole);
      if (rb < 0) hit('gap-b', 'Merged segments with no second-table interval (its columns null)', hole);
      outBhid.push(hole); outFrom.push(a0); outTo.push(a1);
      for (let oc = 0; oc < outCols.length; oc++) {
        let col = outCols[oc];
        let src = col.side === 'A' ? ra : rb, T = col.side === 'A' ? A : B;
        outVals[oc].push(src >= 0 ? T.cols[col.src].values[src] : null);
      }
    }
  }

  let cols = outCols.map(function(c, i) { return { name: c.name, type: c.type, values: outVals[i] }; });
  let checkList = []; for (let ck in checks) checkList.push(checks[ck]);
  return { bhid: outBhid, from: outFrom, to: outTo, cols: cols,
    report: { checks: checkList, nRows: outBhid.length, nHoles: holeOrder.length } };
}

// ── src/process.js ──

// @gcu/drillhole — process: the one-call pipeline (validate → desurvey → composite).
// What BMA's ingestion calls; everything else is exposed for tests and reuse.


// Returns { header, rows, report }.
function dhProcess(tables, opts) {
  opts = opts || {};
  let validated = dhValidate(tables, opts);
  let length = (typeof opts.compositeLength === 'number' && opts.compositeLength > 0)
    ? opts.compositeLength
    : dhDefaultLength(validated.intervals);
  let result = dhComposite(validated, {
    length: length,
    method: opts.method || 'minimumCurvature',
    domainColName: opts.domainCol || null,
    splitColNames: opts.splitCols || null,
    densityColName: opts.densityCol || null,
    combine: opts.combine || null,
    minCoverage: opts.minCoverage || null,
  });
  let checkList = [];
  for (let k in validated.checks) checkList.push(validated.checks[k]);
  return {
    header: result.header,
    rows: result.rows,
    report: {
      checks: checkList,
      nHoles: validated.holes.length,
      nComposites: result.rows.length,
      dipConvention: validated.dipConvention,
      compositeLength: length,
    },
  };
}

// ── src/main.js ──

// @gcu/drillhole — module manifest (the @gcu/build concat order) + the `Drillhole`
// namespace BMA/dee call through. Reverse-vendored home of bma's vendor-drillhole.js.
//
//   desurvey.js — tangent, detectDipConvention, normalizeSurveys, desurveyHole, positionAt
//   validate.js — validate (join + consistency report)
//   composite.js — defaultLength, composite (fixed-length, length/mass-weighted, split-aware)
//   samples.js   — desurveySamples (point-support locator; reuses validate's hole join)
//   merge.js     — mergeIntervals (down-hole union re-segment join)
//   process.js   — process (validate → desurvey → composite, one call)



// The `Drillhole.*` facade (the surface app code + the BMA re-vendor call through).
const Drillhole = {
  tangent: dhTangent,
  detectDipConvention: dhDetectDipConvention,
  normalizeSurveys: dhNormalizeSurveys,
  desurveyHole: dhDesurveyHole,
  positionAt: dhPositionAt,
  validate: dhValidate,
  defaultLength: dhDefaultLength,
  composite: dhComposite,
  desurveySamples: dhDesurveySamples,
  process: dhProcess,
  mergeIntervals: dhMergeIntervals,
};

export {
  Drillhole,
  dhTangent,
  dhDetectDipConvention,
  dhNormalizeSurveys,
  dhDesurveyHole,
  dhPositionAt,
  dhJoinHoles,
  dhNormalizeHoleStations,
  dhValidate,
  dhDefaultLength,
  dhComposite,
  dhDesurveySamples,
  dhMergeIntervals,
  dhProcess,
};
