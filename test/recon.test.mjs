// @gcu/recon — unit + integration tests (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniff, detectDelimiter, detectUnit, detectAnalyte, guessCoords,
  geometryAccumulator, inferGeometry, registerHeuristic, defaultHeuristics, NULL_SENTINELS,
} from '../ext/recon/src/main.js';
import { recipe, fromText, parseCsv, scanState, sample } from '../ext/sluice/src/main.js';

const col = (m, name) => m.columns.find((c) => c.name === name);

// ── standalone detectors ──────────────────────────────────────────────
test('detectDelimiter', () => {
  assert.equal(detectDelimiter(['a,b,c', '1,2,3']), ',');
  assert.equal(detectDelimiter(['a\tb\tc', '1\t2\t3']), '\t');
  assert.equal(detectDelimiter(['a;b;c', '1;2;3']), ';');
});

test('detectUnit from column names', () => {
  assert.deepEqual(detectUnit('Au_gpt')?.unit, 'g/t');
  assert.deepEqual(detectUnit('FE_PCT')?.unit, '%');
  assert.deepEqual(detectUnit('density_gcm3')?.unit, 'g/cm3');
  assert.deepEqual(detectUnit('Cu_ppm')?.unit, 'ppm');
  assert.deepEqual(detectUnit('Au (g/t)')?.unit, 'g/t');     // parenthetical
  assert.ok(detectUnit('Au (g/t)').confidence > detectUnit('Au_gpt').confidence);
  assert.equal(detectUnit('LITHOLOGY'), null);
});

test('detectAnalyte from column names', () => {
  assert.equal(detectAnalyte('AU')?.analyte, 'Au');          // case-normalized element
  assert.equal(detectAnalyte('Au_gpt')?.analyte, 'Au');
  assert.equal(detectAnalyte('FE_PCT')?.analyte, 'Fe');
  assert.equal(detectAnalyte('SiO2')?.analyte, 'SiO2');      // oxide
  assert.equal(detectAnalyte('P2O5')?.analyte, 'P2O5');
  assert.equal(detectAnalyte('LITO'), null);
});

test('guessCoords by name + positional fallback', () => {
  const byName = guessCoords(['EASTING', 'NORTHING', 'RL', 'AU'], ['numeric', 'numeric', 'numeric', 'numeric']);
  assert.deepEqual(byName.cols, { x: 'EASTING', y: 'NORTHING', z: 'RL' });
  assert.ok(byName.confidence.x >= 0.9);
  const fallback = guessCoords(['a', 'b', 'c', 'lito'], ['numeric', 'numeric', 'numeric', 'categorical']);
  assert.deepEqual(fallback.cols, { x: 'a', y: 'b', z: 'c' });
  assert.ok(fallback.confidence.x < 0.5);                    // positional = low confidence
});

// ── sniff ─────────────────────────────────────────────────────────────
test('sniff annotates types, roles, units, analytes', () => {
  const lines = ['X,Y,Z,Au_gpt,SiO2_pct,LITO', '1005,2005,302.5,1.2,45.6,BIF', '1015,2005,302.5,0.8,48.1,SHALE'];
  const m = sniff(lines);
  assert.equal(m.delimiter, ',');
  assert.equal(col(m, 'X').role, 'coord-x');
  assert.equal(col(m, 'Z').role, 'coord-z');
  assert.equal(col(m, 'Au_gpt').unit, 'g/t');
  assert.equal(col(m, 'Au_gpt').analyte, 'Au');
  assert.equal(col(m, 'SiO2_pct').unit, '%');
  assert.equal(col(m, 'SiO2_pct').analyte, 'SiO2');
  assert.equal(col(m, 'LITO').type, 'categorical');
  assert.deepEqual(m.coordCols, { x: 'X', y: 'Y', z: 'Z' });
  assert.ok(col(m, 'X').confidence.role >= 0.9);             // confidence present
  assert.ok(Array.isArray(m.annotations) && m.annotations.length > 0);
});

test('analyte detection is coord-aware (Y axis is not Yttrium)', () => {
  // X/Y/Z are coordinates; Au_gpt is a grade. Y must NOT be tagged analyte Y.
  const lines = ['X,Y,Z,Au_gpt', '1005,2005,302.5,1.2', '1015,2015,307.5,0.8'];
  const m = sniff(lines);
  assert.equal(col(m, 'Y').role, 'coord-y');
  assert.equal(col(m, 'Y').analyte, undefined, 'Y axis not flagged as Yttrium');
  assert.equal(col(m, 'Au_gpt').analyte, 'Au', 'real grade still detected');
});

test('sniff id detection', () => {
  const lines = ['HOLEID,FROM,TO', 'DDH001,0,1', 'DDH002,1,2', 'DDH003,2,3', 'DDH004,3,4', 'DDH005,4,5', 'DDH006,5,6', 'DDH007,6,7', 'DDH008,7,8'];
  const m = sniff(lines);
  assert.equal(col(m, 'HOLEID').role, 'id');
});

test('packs filter — core only drops geo annotations', () => {
  const lines = ['X,Au_gpt', '1005,1.2', '1015,0.8'];
  const m = sniff(lines, { packs: ['core'] });
  assert.equal(col(m, 'X').role, undefined);                 // no coords heuristic
  assert.equal(col(m, 'Au_gpt').unit, undefined);            // no units heuristic
});

test('registerHeuristic extends the default registry', () => {
  const before = defaultHeuristics.length;
  const h = { name: 'flagcol', pack: 'custom', detect: (ctx) => ctx.header.filter((n) => n === 'FLAG').map((n) => ({ target: n, key: 'role', value: 'myflag', confidence: 1 })) };
  registerHeuristic(h);
  assert.equal(defaultHeuristics.length, before + 1);
  const m = sniff(['FLAG,X', '1,1005']);
  assert.equal(col(m, 'FLAG').role, 'myflag');
  defaultHeuristics.pop();                                   // cleanup
});

// ── geometry (direct) ─────────────────────────────────────────────────
test('inferGeometry detects a regular grid', () => {
  const accResult = {
    axes: {
      x: { values: [0, 10, 20], min: 0, max: 20, transitions: 100, count: 100, overflow: false },
      y: { values: [0, 10, 20, 30], min: 0, max: 30, transitions: 30, count: 100, overflow: false },
      z: { values: [5, 10], min: 5, max: 10, transitions: 5, count: 100, overflow: false },
    },
    dims: { dx: [], dy: [], dz: [] },
  };
  const f = inferGeometry(accResult);
  assert.equal(f.kind, 'gridded');
  assert.deepEqual(f.size, [10, 10, 5]);
  assert.deepEqual(f.count, [3, 4, 2]);
  assert.deepEqual(f.origin, [0, 0, 5]);
  assert.equal(f.order.fastest, 'X');                        // most transitions
  assert.equal(f.subBlocked, false);
});

test('inferGeometry detects sub-blocking', () => {
  const accResult = {
    axes: {
      x: { values: [0, 5, 10, 20, 30], min: 0, max: 30, transitions: 100, count: 100, overflow: false },
      y: { values: [0, 10, 20], min: 0, max: 20, transitions: 30, count: 100, overflow: false },
      z: { values: [0, 10], min: 0, max: 10, transitions: 5, count: 100, overflow: false },
    },
    dims: { dx: [], dy: [], dz: [] },
  };
  const f = inferGeometry(accResult);
  assert.equal(f.subBlocked, true);
  assert.equal(f.size[0], 10);                               // parent
  assert.equal(f.subBlocks.x[0].ratio, 2);                  // 10/5
});

test('inferGeometry falls back to scattered without a grid', () => {
  const accResult = { axes: { x: { values: [0.1, 0.7, 1.3, 2.9], min: 0.1, max: 2.9, transitions: 4, count: 4, overflow: false }, y: { values: [], min: Infinity, max: -Infinity, transitions: 0, count: 0, overflow: false }, z: { values: [], min: Infinity, max: -Infinity, transitions: 0, count: 0, overflow: false } }, dims: { dx: [], dy: [], dz: [] } };
  assert.equal(inferGeometry(accResult).kind, 'scattered');
});

// ── integration: sniff → geometry scan via sluice → facet ─────────────
test('end-to-end: sniff + geometry scan over a generated grid', async () => {
  // 3×3×2 regular grid, X-fastest; centroids origin(1000,2000,300) size(10,10,5).
  let csv = 'X,Y,Z,Au_gpt,LITO\n';
  for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const x = 1005 + i * 10, y = 2005 + j * 10, z = 302.5 + k * 5;
    csv += `${x},${y},${z},${(i + j + k) * 0.5},${i % 2 ? 'A' : 'B'}\n`;
  }
  const m = sniff(await sample(fromText(csv), 50));
  assert.deepEqual(m.coordCols, { x: 'X', y: 'Y', z: 'Z' });
  assert.equal(col(m, 'Au_gpt').unit, 'g/t');

  const acc = geometryAccumulator(m.coordCols);
  const state = await scanState(recipe(fromText(csv), parseCsv({ delimiter: m.delimiter, columns: m.columns, header: true })), acc);
  const f = inferGeometry(acc.result(state));
  assert.equal(f.kind, 'gridded');
  assert.deepEqual(f.size, [10, 10, 5]);
  assert.deepEqual(f.count, [3, 3, 2]);
  assert.equal(f.order.fastest, 'X');
});

test('NULL_SENTINELS mirrors the mining null vocabulary', () => {
  assert.ok(NULL_SENTINELS.has('-9999') && NULL_SENTINELS.has('-1e+32'));
});
