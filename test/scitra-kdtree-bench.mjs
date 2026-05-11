// scitra KDTree vs scipy.spatial.KDTree — same data, correctness + perf.
//
// scipy script writes points + queries to .bin files and reference
// results (indices, distances) to results.json. This script reads those
// EXACT same data and verifies scitra matches index-for-index.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KDTree } from '../ext/scitra/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(__dirname, '..', '.kdtree-bench-data');

console.log('Running scipy reference to generate datasets…');
try {
  execSync('python test/perf_scipy_kdtree.py', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('  scipy ready\n');
} catch (e) {
  console.error('  scipy FAILED:', e.message.slice(0, 200));
  process.exit(1);
}

const scipy = JSON.parse(readFileSync(path.join(BENCH_DIR, 'results.json'), 'utf8'));

function bench(fn, warmup = 2, samples = 10) {
  for (let i = 0; i < warmup; i++) fn();
  const ts = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

function loadBin(filePath) {
  const buf = readFileSync(filePath);
  // Use a subarray so we don't share buffer over an aligned chunk
  return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const K = scipy.k;
const NUM_BATCH = scipy.num_batch;

// ── correctness check on each case ──────────────────────────────────

console.log('## Correctness — scitra vs scipy on identical data\n');
console.log('| n      | d  | single idx | single dist | batch idx     | ball | pairs |');
console.log('|--------|----|------------|-------------|---------------|------|-------|');

const issues = [];

for (const c of scipy.cases) {
  const { n, d } = c;
  const ptsFlat = loadBin(path.join(BENCH_DIR, `pts_${n}x${d}.bin`));
  const qFlat = loadBin(path.join(BENCH_DIR, `queries_${n}x${d}.bin`));
  if (ptsFlat.length !== n * d) {
    throw new Error(`points file size mismatch for n=${n} d=${d}: expected ${n*d}, got ${ptsFlat.length}`);
  }
  if (qFlat.length !== NUM_BATCH * d) {
    throw new Error(`queries file size mismatch for n=${n} d=${d}`);
  }

  // Build tree from same data
  const pts = { data: ptsFlat, shape: [n, d] };
  const tree = new KDTree(pts);

  // Single query
  const q1 = qFlat.slice(0, d);
  const r1 = tree.query(q1, K);

  // Compare indices
  let sameIdxSingle = true;
  for (let i = 0; i < K; i++) {
    if (r1.idx[i] !== c.idxs_single[i]) { sameIdxSingle = false; break; }
  }
  // Compare distances within tolerance
  let maxDistErrSingle = 0;
  for (let i = 0; i < K; i++) {
    const e = Math.abs(r1.dist[i] - c.dists_single[i]);
    if (e > maxDistErrSingle) maxDistErrSingle = e;
  }

  // Batch query — use the new queryBatch API
  const bRes = tree.queryBatch({ data: qFlat, shape: [NUM_BATCH, d] }, K);
  let sameIdxBatch = true;
  let firstBatchDiff = -1;
  for (let i = 0; i < NUM_BATCH * K; i++) {
    if (bRes.idx[i] !== c.idxs_batch_flat[i]) {
      sameIdxBatch = false;
      if (firstBatchDiff < 0) firstBatchDiff = i;
      // keep scanning
    }
  }
  let maxDistErrBatch = 0;
  for (let i = 0; i < NUM_BATCH * K; i++) {
    const e = Math.abs(bRes.dist[i] - c.dists_batch_flat[i]);
    if (e > maxDistErrBatch) maxDistErrBatch = e;
  }

  // Ball query
  const ballRes = Array.from(tree.query_ball_point(q1, c.r_ball)).sort((a, b) => a - b);
  const sameBall = ballRes.length === c.ball_single.length
    && ballRes.every((v, i) => v === c.ball_single[i]);

  // Pairs (count only — full list could be huge)
  let pairsTag = '–';
  if (c.pairs_count != null) {
    const pairs = tree.query_pairs(c.r_pair);
    const samePairsCount = pairs.length === c.pairs_count;
    if (samePairsCount) {
      // Verify first 20 pairs match (sorted)
      const sortedPairs = pairs.map(p => p[0] < p[1] ? p : [p[1], p[0]])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let allMatch = true;
      for (let i = 0; i < Math.min(20, c.pairs_sample.length); i++) {
        if (sortedPairs[i][0] !== c.pairs_sample[i][0] || sortedPairs[i][1] !== c.pairs_sample[i][1]) {
          allMatch = false; break;
        }
      }
      pairsTag = allMatch ? `✓ ${pairs.length}` : `✗ count ok but sample mismatch`;
    } else {
      pairsTag = `✗ ${pairs.length} vs ${c.pairs_count}`;
    }
  }

  const tag = (ok) => ok ? '✓' : '✗';
  console.log(
    `| ${String(n).padStart(6)} | ${String(d).padStart(2)} | ${tag(sameIdxSingle).padEnd(10)} | ${maxDistErrSingle.toExponential(1).padStart(11)} | ${tag(sameIdxBatch)} (${maxDistErrBatch.toExponential(1)}) | ${tag(sameBall).padStart(4)} | ${pairsTag.padStart(5)} |`
  );

  if (!sameIdxSingle || !sameIdxBatch || !sameBall || maxDistErrSingle > 1e-9 || maxDistErrBatch > 1e-9) {
    issues.push({ n, d, sameIdxSingle, maxDistErrSingle, sameIdxBatch, firstBatchDiff, maxDistErrBatch, sameBall, pairsTag });
  }
}

if (issues.length === 0) {
  console.log('\n  ✓ ALL correctness checks pass — scitra matches scipy index-for-index.\n');
} else {
  console.log(`\n  ✗ ${issues.length} cases with discrepancies:\n`);
  for (const x of issues) console.log('  ', JSON.stringify(x));
  console.log();
}

// ── perf bench on same data ─────────────────────────────────────────

console.log(`## Performance — same data, ${NUM_BATCH} batch queries, k=${K}\n`);
console.log('| n      | d  | build (sci/sct) | kNN single  | kNN batch    | ball single | pairs        |');
console.log('|--------|----|-----------------|-------------|--------------|-------------|--------------|');

let sink = 0;
for (const c of scipy.cases) {
  const { n, d } = c;
  const ptsFlat = loadBin(path.join(BENCH_DIR, `pts_${n}x${d}.bin`));
  const qFlat = loadBin(path.join(BENCH_DIR, `queries_${n}x${d}.bin`));
  const pts = { data: ptsFlat, shape: [n, d] };
  const queriesNda = { data: qFlat, shape: [NUM_BATCH, d] };
  const q1 = qFlat.slice(0, d);

  const tBuild = bench(() => {
    const t = new KDTree(pts);
    sink += t.n;
  }, 1, 5);

  const tree = new KDTree(pts);

  const tQuery1 = bench(() => {
    const r = tree.query(q1, K);
    sink += r.idx[0];
  }, 2, 30);

  const tQueryBatch = bench(() => {
    const r = tree.queryBatch(queriesNda, K);
    sink += r.idx[0];
  }, 1, 10);

  const tBall1 = bench(() => {
    const r = tree.query_ball_point(q1, c.r_ball);
    sink += r.length;
  }, 2, 30);

  let tPairs = null;
  if (n <= 10000 && c.r_pair != null) {
    tPairs = bench(() => {
      const r = tree.query_pairs(c.r_pair);
      sink += r.length;
    }, 1, 5);
  }

  const f = (v) => v == null ? '   n/a   ' : v.toFixed(3).padStart(8);
  const ratio = (sci, sct) => (sci == null || sct == null) ? '' : `${(sct/sci).toFixed(2)}×`;
  const pair = (sci, sct) => `${f(sci)} / ${f(sct)} ${ratio(sci, sct).padStart(6)}`;

  console.log(`| ${String(n).padStart(6)} | ${String(d).padStart(2)} | ${pair(c.build_ms, tBuild)} | ${pair(c.query1_ms, tQuery1)} | ${pair(c.query_batch_ms, tQueryBatch)} | ${pair(c.ball1_ms, tBall1)} | ${pair(c.pairs_ms, tPairs)} |`);
}

console.log('\nsink:', sink);
