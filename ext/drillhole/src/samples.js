// @gcu/drillhole — point-sample locator. Some data is point-support, not intervals:
// single-depth assays (handheld XRF, density readings) or already-composited samples
// re-imported. Compositing (length-weighting into windows) doesn't apply — you just
// want each sample placed in 3D on the desurveyed trace. This is that path; it reuses
// the same collar+survey join + station normalization as dhValidate.

import { dhDetectDipConvention, dhDesurveyHole, dhPositionAt } from './desurvey.js';
import { dhJoinHoles, dhNormalizeHoleStations } from './validate.js';

// tables = { collars, surveys, samples: { bhid:[], depth:[], cols:[{name,type,values}] } }
// opts   = { dipConvention, method }
// Returns { header: ['BHID','X','Y','Z','DEPTH', ...cols], rows, report } — one located
// row per valid sample (sorted down-hole within each hole), with the same non-silent
// consistency report style as the interval pipeline.
export function dhDesurveySamples(tables, opts) {
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
