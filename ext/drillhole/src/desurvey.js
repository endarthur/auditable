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
export function dhTangent(azDeg, dipDeg) {
  let az = azDeg * Math.PI / 180, dip = dipDeg * Math.PI / 180;
  let c = Math.cos(dip);
  return [Math.sin(az) * c, Math.cos(az) * c, -Math.sin(dip)];
}

// 'pos-down' (mining: +60 = 60° below horizontal) vs 'neg-down' (signed math: -60 =
// below). Inferred from the median dip — exploration holes point down, so the sign of
// the bulk tells the convention.
export function dhDetectDipConvention(surveys) {
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
export function dhNormalizeSurveys(rawSurveys, dipConvention) {
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
// depths, px, py, pz, tx, ty, tz } — tangents + method ride along so dhPositionAt
// interpolates consistently.
export function dhDesurveyHole(collar, stations, method) {
  method = method || 'minimumCurvature';
  let n = stations.length;
  let out = {
    method: method,
    depths: new Float64Array(n),
    px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), tz: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    out.depths[i] = stations[i].depth;
    let t = dhTangent(stations[i].az, stations[i].dip);
    out.tx[i] = t[0]; out.ty[i] = t[1]; out.tz[i] = t[2];
  }
  out.px[0] = collar[0]; out.py[0] = collar[1]; out.pz[0] = collar[2];

  for (let k = 1; k < n; k++) {
    let dl = out.depths[k] - out.depths[k - 1];
    if (method === 'tangential') {
      out.px[k] = out.px[k - 1] + dl * out.tx[k];
      out.py[k] = out.py[k - 1] + dl * out.ty[k];
      out.pz[k] = out.pz[k - 1] + dl * out.tz[k];
    } else {
      let rf = 1; // balanced tangential
      if (method !== 'balancedTangential') {
        // minimum curvature: RF = (2/θ)·tan(θ/2)
        let dot = out.tx[k - 1] * out.tx[k] + out.ty[k - 1] * out.ty[k] + out.tz[k - 1] * out.tz[k];
        let dogleg = Math.acos(Math.max(-1, Math.min(1, dot)));
        rf = dogleg > 1e-6 ? (2 / dogleg) * Math.tan(dogleg / 2) : 1;
      }
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
export function dhPositionAt(hole, depth) {
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
