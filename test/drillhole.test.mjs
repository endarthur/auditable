// @gcu/drillhole tests — the oracle harness reverse-vendored from BMA (A7 Phase 0):
// analytic arcs with closed-form answers, hand-computed composites, validation counts.
// Imports the built bundle so the concat/lint path is exercised too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drillhole as DH } from '../ext/drillhole/index.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg} (|Δ|=${Math.abs(a - b).toExponential(2)} ≤ ${eps})`);
const nearV = (p, q, eps, msg) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= eps, `${msg}`);

test('desurvey — straight holes (closed form)', () => {
  // vertical: dip 90 pos-down → z decreases with depth
  const st = DH.normalizeSurveys([{ depth: 0, az: 0, dip: 90 }, { depth: 100, az: 0, dip: 90 }], 'pos-down');
  const h = DH.desurveyHole([10, 20, 500], st.stations, 'minimumCurvature');
  nearV([h.px[1], h.py[1], h.pz[1]], [10, 20, 400], 1e-9, 'vertical hole: station 100 at z−100');
  nearV(DH.positionAt(h, 37.5), [10, 20, 462.5], 1e-9, 'vertical hole: positionAt(37.5)');

  // inclined: az 135, dip 60
  const dir = [Math.sin(3 * Math.PI / 4) * 0.5, Math.cos(3 * Math.PI / 4) * 0.5, -Math.sin(Math.PI / 3)];
  const st2 = DH.normalizeSurveys([{ depth: 0, az: 135, dip: 60 }, { depth: 200, az: 135, dip: 60 }], 'pos-down');
  const h2 = DH.desurveyHole([0, 0, 0], st2.stations, 'minimumCurvature');
  nearV([h2.px[1], h2.py[1], h2.pz[1]], [200 * dir[0], 200 * dir[1], 200 * dir[2]], 1e-9, 'inclined hole endpoint');
  nearV(DH.positionAt(h2, 50), [50 * dir[0], 50 * dir[1], 50 * dir[2]], 1e-9, 'inclined positionAt(50)');
  nearV(DH.positionAt(h2, 250), [250 * dir[0], 250 * dir[1], 250 * dir[2]], 1e-9, 'straight extrapolation past last survey');
});

test('desurvey — horizontal circular arc (min curvature is EXACT on a circle)', () => {
  const R = 100;
  const surveys = [];
  for (let i = 0; i <= 20; i++) { const s = i * 10; surveys.push({ depth: s, az: (s / R) * 180 / Math.PI, dip: 0 }); }
  const st = DH.normalizeSurveys(surveys, 'pos-down');
  const h = DH.desurveyHole([0, 0, 0], st.stations, 'minimumCurvature');
  let maxErr = 0;
  for (let i = 0; i <= 20; i++) {
    const s = i * 10, exact = [R * (1 - Math.cos(s / R)), R * Math.sin(s / R), 0];
    maxErr = Math.max(maxErr, Math.hypot(h.px[i] - exact[0], h.py[i] - exact[1], h.pz[i] - exact[2]));
  }
  assert.ok(maxErr < 1e-9 * R, `all 21 stations on the circle (max ${maxErr.toExponential(2)})`);

  // D2: arc interpolation — mid-segment points land ON the circle (chord would err ~0.125)
  let maxMid = 0;
  for (let i = 0; i < 20; i++) {
    const s = i * 10 + 5, exact = [R * (1 - Math.cos(s / R)), R * Math.sin(s / R), 0];
    const p = DH.positionAt(h, s);
    maxMid = Math.max(maxMid, Math.hypot(p[0] - exact[0], p[1] - exact[1], p[2] - exact[2]));
  }
  assert.ok(maxMid < 1e-9 * R, `mid-segment positionAt arc-correct (max ${maxMid.toExponential(2)})`);

  // methods differ on a curve
  const ht = DH.desurveyHole([0, 0, 0], st.stations, 'tangential');
  const hb = DH.desurveyHole([0, 0, 0], st.stations, 'balancedTangential');
  assert.ok(Math.hypot(ht.px[20] - h.px[20], ht.py[20] - h.py[20], ht.pz[20] - h.pz[20]) > 0.01, 'tangential differs from min curvature');
  assert.ok(Math.hypot(hb.px[20] - h.px[20], hb.py[20] - h.py[20], hb.pz[20] - h.pz[20]) > 0.01, 'balanced tangential differs from min curvature');
  assert.ok(Math.hypot(hb.px[20] - ht.px[20], hb.py[20] - ht.py[20], hb.pz[20] - ht.pz[20]) > 0.01, 'balanced ≠ tangential');

  // method-consistent interpolation: positionAt(station depth) reproduces the station
  for (const hm of [h, ht, hb]) {
    let worst = 0;
    for (let i = 0; i < 21; i++) { const p = DH.positionAt(hm, i * 10); worst = Math.max(worst, Math.hypot(p[0] - hm.px[i], p[1] - hm.py[i], p[2] - hm.pz[i])); }
    assert.ok(worst < 1e-9, `${hm.method}: positionAt(station) = station (${worst.toExponential(2)})`);
  }
  nearV(DH.positionAt(ht, 15), [ht.px[1] + 5 * ht.tx[2], ht.py[1] + 5 * ht.ty[2], ht.pz[1] + 5 * ht.tz[2]], 1e-12, 'tangential mid-segment straight');
  nearV(DH.positionAt(hb, 15), [(hb.px[1] + hb.px[2]) / 2, (hb.py[1] + hb.py[2]) / 2, (hb.pz[1] + hb.pz[2]) / 2], 1e-12, 'balanced mid-segment on the chord');
});

test('desurvey — vertical-plane arc + dip conventions', () => {
  const R = 80;
  const mk = (sign) => { const out = []; for (let i = 0; i <= 12; i++) { const s = i * (R * Math.PI / 2) / 12; out.push({ depth: s, az: 0, dip: sign * (s / R) * 180 / Math.PI }); } return out; };
  const stP = DH.normalizeSurveys(mk(1), 'pos-down');
  const hP = DH.desurveyHole([0, 0, 0], stP.stations, 'minimumCurvature');
  nearV([hP.px[12], hP.py[12], hP.pz[12]], [0, R, -R], 1e-9 * R, 'quarter-circle endpoint (pos-down)');
  assert.equal(DH.detectDipConvention(mk(-1)), 'neg-down', 'neg-down detected from median dip');
  const hN = DH.desurveyHole([0, 0, 0], DH.normalizeSurveys(mk(-1), 'neg-down').stations, 'minimumCurvature');
  nearV([hN.px[12], hN.py[12], hN.pz[12]], [hP.px[12], hP.py[12], hP.pz[12]], 1e-12, 'neg-down normalizes to the same path');
  assert.equal(DH.detectDipConvention(mk(1)), 'pos-down', 'pos-down detected');
});

test('normalizeSurveys — sort, dedupe, synth station 0, bad-row counts', () => {
  const st = DH.normalizeSurveys([
    { depth: 30, az: 10, dip: 60 }, { depth: 10, az: 0, dip: 60 },
    { depth: 30, az: 20, dip: 61 }, { depth: NaN, az: 0, dip: 60 }, { depth: 50, az: 5, dip: 95 },
  ], 'pos-down');
  assert.ok(st.stations.length === 3 && st.stations[0].depth === 0, 'synthetic station 0 + sort');
  assert.ok(st.stations[0].az === 0 && st.stations[0].dip === 60, 'station 0 copies first attitude');
  assert.ok(st.stations[2].az === 20 && st.stations[2].dip === 61, 'duplicate depth: last wins');
  assert.ok(st.dupCount === 1 && st.badCount === 2, 'dup + bad counts');
});

const VERT = [{ bhid: 'H1', depth: 0, az: 0, dip: 90 }];
const tables = (intervals, cols) => ({
  collars: [{ bhid: 'H1', x: 0, y: 0, z: 100, eoh: null }],
  surveys: VERT,
  intervals: { bhid: intervals.map(() => 'H1'), from: intervals.map(r => r[0]), to: intervals.map(r => r[1]), cols },
});

test('compositing — hand-computed fixtures (length-weighting, gaps, overlap, missing)', () => {
  const r = DH.process(tables([[0, 1], [1, 2], [2, 3]], [{ name: 'Fe', type: 'num', values: [1, 2, 3] }]), { compositeLength: 2 });
  assert.equal(r.rows.length, 2, 'two composites');
  near(r.rows[0][7], 1.5, 1e-12, 'composite 1 grade 1.5');
  near(r.rows[0][6], 2, 1e-12, 'composite 1 SUPPORT 2');
  near(r.rows[1][7], 3, 1e-12, 'composite 2 grade 3');
  near(r.rows[1][6], 1, 1e-12, 'composite 2 SUPPORT 1 (short tail)');
  near(r.rows[0][3], 99, 1e-12, 'composite 1 z at covered centroid');

  const g = DH.process(tables([[0, 1], [2, 3]], [{ name: 'Fe', type: 'num', values: [1, 3] }]), { compositeLength: 2 });
  assert.equal(g.rows.length, 2, 'gap: two composites (none in the gap)');
  near(g.rows[0][6], 1, 1e-12, 'gap: SUPPORT 1');
  near(g.rows[0][3], 99.5, 1e-12, 'gap: centroid at covered mass');

  const o = DH.process(tables([[0, 2], [1, 2]], [{ name: 'Fe', type: 'num', values: [1, 3] }]), { compositeLength: 2 });
  near(o.rows[0][6], 3, 1e-12, 'overlap: SUPPORT double-counts');
  near(o.rows[0][7], 5 / 3, 1e-12, 'overlap: length-weighted grade 5/3');
  assert.ok(o.report.checks.some(c => c.id === 'overlap' && c.count === 1), 'overlap flagged');

  const m = DH.process(tables([[0, 1], [1, 2]], [{ name: 'Fe', type: 'num', values: [NaN, 4] }, { name: 'Si', type: 'num', values: [2, 6] }]), { compositeLength: 2 });
  near(m.rows[0][7], 4, 1e-12, 'missing assay: Fe over valued length only');
  near(m.rows[0][8], 4, 1e-12, 'missing assay: Si unaffected');
  near(m.rows[0][6], 2, 1e-12, 'missing assay: SUPPORT still covered length');
});

test('compositing — density (mass) weighting + combine rules + splits + domains', () => {
  const dens = tables([[0, 1], [1, 2]], [{ name: 'Fe', type: 'num', values: [1, 2] }, { name: 'RHO', type: 'num', values: [1, 3] }]);
  near(DH.process(dens, { compositeLength: 2 }).rows[0][7], 1.5, 1e-12, 'no density: Fe length-weighted');
  const wM = DH.process(dens, { compositeLength: 2, densityCol: 'RHO' });
  near(wM.rows[0][7], 1.75, 1e-12, 'mass-weighted Fe = (1·1+3·2)/4');
  near(wM.rows[0][8], 2, 1e-12, 'RHO stays length-weighted');
  const dm = DH.process(tables([[0, 1], [1, 2]], [{ name: 'Fe', type: 'num', values: [1, 2] }, { name: 'RHO', type: 'num', values: [NaN, 2] }]), { compositeLength: 2, densityCol: 'RHO' });
  near(dm.rows[0][7], 2, 1e-12, 'missing density: Fe from density-bearing interval only');
  assert.ok(dm.report.checks.some(c => c.id === 'missing-density' && c.count === 1), 'missing density surfaced');

  const cmbT = tables([[0, 1], [1, 2]], [{ name: 'V', type: 'num', values: [2, 4] }]);
  near(DH.process(cmbT, { compositeLength: 2 }).rows[0][7], 3, 1e-12, 'combine mean');
  near(DH.process(cmbT, { compositeLength: 2, combine: { V: 'sum' } }).rows[0][7], 6, 1e-12, 'combine sum');
  near(DH.process(cmbT, { compositeLength: 2, combine: { V: 'min' } }).rows[0][7], 2, 1e-12, 'combine min');
  near(DH.process(cmbT, { compositeLength: 2, combine: { V: 'max' } }).rows[0][7], 4, 1e-12, 'combine max');
  const cmbC = tables([[0, 0.5], [0.5, 2]], [{ name: 'L', type: 'cat', values: ['A', 'B'] }]);
  assert.equal(DH.process(cmbC, { compositeLength: 2 }).rows[0][7], 'B', 'categorical majority B');
  assert.equal(DH.process(cmbC, { compositeLength: 2, combine: { L: 'first' } }).rows[0][7], 'A', 'combine first = A');

  const ms = tables([[0, 1], [1, 2], [2, 3]], [{ name: 'LITO', type: 'cat', values: ['A', 'A', 'B'] }, { name: 'ZONE', type: 'cat', values: ['X', 'Y', 'Y'] }]);
  const s2 = DH.process(ms, { compositeLength: 10, splitCols: ['LITO', 'ZONE'] });
  assert.equal(s2.rows.length, 3, 'two splits → 3 composites');
  assert.ok(s2.rows[0][7] === 'A' && s2.rows[0][8] === 'X', 'split cols ride 1:1');
  assert.equal(DH.process(ms, { compositeLength: 10, splitCols: ['LITO'] }).rows.length, 2, 'one split → 2');
  assert.equal(DH.process(ms, { compositeLength: 10 }).rows.length, 1, 'no split → 1');
  assert.equal(DH.process(ms, { compositeLength: 10, domainCol: 'LITO' }).rows.length, 2, 'legacy domainCol = single split');

  const d = DH.process(tables([[0, 2], [2, 4]], [{ name: 'Fe', type: 'num', values: [1, 9] }, { name: 'LITO', type: 'cat', values: ['A', 'B'] }]), { compositeLength: 1.5, domainCol: 'LITO' });
  assert.equal(d.rows.length, 4, 'domain break → 4 composites');
  near(d.rows[1][5], 2, 1e-12, 'run A clipped at contact');
  near(d.rows[1][6], 0.5, 1e-12, 'short composite true SUPPORT 0.5');
  assert.ok(d.rows[1][8] === 'A' && d.rows[2][8] === 'B', 'majority per side');
  assert.ok(!d.report.checks.some(c => c.id === 'mixed-domain'), 'no mixed when breaking');

  const c = DH.process(tables([[0, 1.2], [1.2, 2]], [{ name: 'LITO', type: 'cat', values: ['A', 'B'] }]), { compositeLength: 2 });
  assert.equal(c.rows[0][7], 'A', 'majority by covered length');
  assert.ok(c.report.checks.some(x => x.id === 'mixed-domain' && x.count === 1), 'sub-100% majority counted');

  const f = DH.process(tables([[0, 0.5], [2, 4]], [{ name: 'Fe', type: 'num', values: [1, 2] }]), { compositeLength: 2, minCoverage: 0.5 });
  assert.ok(f.rows.length === 1 && f.report.checks.some(x => x.id === 'low-coverage-filtered' && x.count === 1), 'minCoverage drops + counts');
  near(DH.defaultLength({ from: [0, 1, 2, 3], to: [1, 2, 3, 3.5], cols: [] }), 1, 1e-12, 'default length = mode');
});

test('validation — non-silent consistency report', () => {
  const t = {
    collars: [
      { bhid: 'H1', x: 0, y: 0, z: 100, eoh: 10 }, { bhid: 'H2', x: 50, y: 0, z: 100, eoh: null },
      { bhid: 'H1', x: 9, y: 9, z: 9, eoh: null }, { bhid: 'H3', x: NaN, y: 0, z: 0, eoh: null },
      { bhid: 'H4', x: 10, y: 10, z: 100, eoh: null },
    ],
    surveys: [{ bhid: 'H1', depth: 0, az: 0, dip: 90 }, { bhid: 'H1', depth: 12, az: 0, dip: 90 }, { bhid: 'HX', depth: 0, az: 0, dip: 90 }],
    intervals: { bhid: ['H1', 'H1', 'HY', 'H1', 'H4'], from: [0, 5, 0, 3, 0], to: [5, 3, 1, 3, 2], cols: [{ name: 'Fe', type: 'num', values: [1, 2, 3, 4, 5] }] },
  };
  const r = DH.process(t, { compositeLength: 5 });
  const byId = {}; r.report.checks.forEach(c => { byId[c.id] = c; });
  assert.ok(byId['dup-collar'] && byId['dup-collar'].count === 1, 'dup collar');
  assert.ok(byId['bad-collar'] && byId['bad-collar'].count === 1, 'bad collar coords');
  assert.ok(byId['collar-no-intervals'].bhids.includes('H2'), 'collar without intervals');
  assert.ok(byId['collar-no-survey'].bhids.includes('H4'), 'no-survey hole straight down');
  assert.ok(byId['orphan-survey'].bhids.includes('HX'), 'orphan survey');
  assert.ok(byId['orphan-interval'].bhids.includes('HY'), 'orphan interval');
  assert.ok(byId['bad-interval'].count === 2, 'FROM≥TO excluded');
  assert.ok(byId['past-eoh'].count >= 1, 'past-EOH advisory');
  assert.equal(r.report.nHoles, 2, 'two usable holes');
  const h4 = r.rows.find(row => row[0] === 'H4');
  nearV([h4[1], h4[2], h4[3]], [10, 10, 99], 1e-12, 'straight-down fallback geometry');
});

test('process — output shape + auto length + detected convention', () => {
  const r = DH.process(tables([[0, 1], [1, 2]], [{ name: 'Fe', type: 'num', values: [1, 2] }, { name: 'LITO', type: 'cat', values: ['A', 'A'] }]), {});
  assert.deepEqual(r.header, ['BHID', 'X', 'Y', 'Z', 'FROM', 'TO', 'SUPPORT', 'Fe', 'LITO']);
  assert.equal(r.report.compositeLength, 1, 'auto length from mode');
  assert.equal(r.report.dipConvention, 'pos-down', 'detected convention reported');
});

const ivt = (rows, cols) => ({ bhid: rows.map(r => r[0]), from: rows.map(r => r[1]), to: rows.map(r => r[2]), cols });
const colVals = (table, name) => { const c = table.cols.find(x => x.name === name); return c ? c.values : null; };

test('merge — down-hole interval join (union re-segment)', () => {
  const A1 = ivt([['H1', 0, 1], ['H1', 1, 2]], [{ name: 'Fe', type: 'num', values: [1, 2] }]);
  const B1 = ivt([['H1', 0, 1], ['H1', 1, 2]], [{ name: 'LITO', type: 'cat', values: ['X', 'Y'] }]);
  const m1 = DH.mergeIntervals(A1, B1);
  assert.equal(m1.bhid.length, 2, 'aligned: 2 segments');
  assert.deepEqual(m1.cols.map(c => c.name), ['Fe', 'LITO']);
  assert.deepEqual(colVals(m1, 'Fe'), [1, 2]); assert.deepEqual(colVals(m1, 'LITO'), ['X', 'Y']);

  const A2 = ivt([['H1', 0, 2]], [{ name: 'Fe', type: 'num', values: [1] }]);
  const B2 = ivt([['H1', 0, 1], ['H1', 1, 2]], [{ name: 'LITO', type: 'cat', values: ['X', 'Y'] }]);
  const m2 = DH.mergeIntervals(A2, B2);
  assert.deepEqual(m2.from, [0, 1]); assert.deepEqual(m2.to, [1, 2]);
  assert.deepEqual(colVals(m2, 'Fe'), [1, 1]); assert.deepEqual(colVals(m2, 'LITO'), ['X', 'Y']);

  const m3 = DH.mergeIntervals(A2, ivt([['H1', 0, 1]], [{ name: 'LITO', type: 'cat', values: ['X'] }]));
  assert.equal(m3.bhid.length, 2); assert.equal(colVals(m3, 'LITO')[1], null);
  assert.ok(m3.report.checks.some(c => c.id === 'gap-b' && c.count === 1), 'gap-b counted');

  const m4 = DH.mergeIntervals(ivt([['H1', 0, 1]], [{ name: 'Fe', type: 'num', values: [1] }]), ivt([['H1', 2, 3]], [{ name: 'LITO', type: 'cat', values: ['X'] }]));
  assert.deepEqual(m4.from, [0, 2]);
  assert.ok(m4.report.checks.some(c => c.id === 'gap-a') && m4.report.checks.some(c => c.id === 'gap-b'), 'both-gap counted');

  const m5 = DH.mergeIntervals(ivt([['H1', 0, 1]], [{ name: 'X', type: 'num', values: [1] }]), ivt([['H1', 0, 1]], [{ name: 'X', type: 'cat', values: ['p'] }]));
  assert.deepEqual(m5.cols.map(c => c.name), ['X', 'X_2']);
  assert.ok(m5.report.checks.some(c => c.id === 'column-collision'), 'collision counted');

  const m6 = DH.mergeIntervals(ivt([['H1', 0, 1], ['H2', 0, 1]], [{ name: 'Fe', type: 'num', values: [1, 5] }]), ivt([['H1', 0, 1]], [{ name: 'LITO', type: 'cat', values: ['X'] }]));
  assert.ok(m6.bhid.length === 2 && m6.bhid[1] === 'H2', 'H2 (A-only) emitted');
  assert.ok(colVals(m6, 'LITO')[1] === null && m6.report.checks.some(c => c.id === 'hole-only-a'), 'H2 null + hole-only-a');

  const m7 = DH.mergeIntervals(ivt([['H1', 0, 2], ['H1', 1, 3]], [{ name: 'Fe', type: 'num', values: [1, 9] }]), ivt([['H1', 0, 3]], [{ name: 'LITO', type: 'cat', values: ['X'] }]));
  assert.ok(m7.report.checks.some(c => c.id === 'overlap-a'), 'overlap-a flagged');

  // the merged table composites cleanly through the pipeline
  const merged = DH.mergeIntervals(A2, B2);
  const proc = DH.process({ collars: [{ bhid: 'H1', x: 0, y: 0, z: 100, eoh: null }], surveys: [{ bhid: 'H1', depth: 0, az: 0, dip: 90 }], intervals: merged }, { compositeLength: 1, splitCols: ['LITO'] });
  assert.ok(proc.rows.length === 2 && proc.report.nHoles === 1, 'merged table composites cleanly');
});
