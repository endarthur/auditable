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
export function dhMergeIntervals(A, B, opts) {
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
