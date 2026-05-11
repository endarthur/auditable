// Reproduce scitra KDTree bugs found in scitra-kdtree-bench.mjs.
// Goal: isolate whether the bug is in build, single-query, or batch.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KDTree } from '../ext/scitra/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(__dirname, '..', '.kdtree-bench-data');

function loadBin(filePath) {
  const buf = readFileSync(filePath);
  return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// Brute-force kNN: ground truth for any correct implementation
function bruteKnn(ptsFlat, n, d, query, k) {
  const distSq = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) {
      const diff = ptsFlat[i * d + j] - query[j];
      s += diff * diff;
    }
    distSq.push({ i, sq: s });
  }
  distSq.sort((a, b) => a.sq - b.sq);
  return {
    idx: distSq.slice(0, k).map(x => x.i),
    dist: distSq.slice(0, k).map(x => Math.sqrt(x.sq)),
  };
}

// Case n=1000 d=3, where single query fails per the bench
const n = 1000, d = 3, K = 10;
const ptsFlat = loadBin(path.join(BENCH_DIR, `pts_${n}x${d}.bin`));
const qFlat = loadBin(path.join(BENCH_DIR, `queries_${n}x${d}.bin`));

console.log(`Loaded n=${n} d=${d}, ${ptsFlat.length} floats in points, ${qFlat.length} in queries\n`);

// Try multiple leafsizes to narrow down where the bug is
for (const ls of [1, 2, 4, 16]) {
  const tree = new KDTree({ data: ptsFlat, shape: [n, d] }, { leafsize: ls });
  const r = tree.query(qFlat.slice(0, d), K);
  const matches = r.idx.every((x, i) => x === bruteKnn(ptsFlat, n, d, qFlat.slice(0, d), K).idx[i]);
  console.log(`  leafsize=${ls}: ${matches ? '✓ matches brute' : '✗ MISMATCH'}`);
}
console.log();

const tree = new KDTree({ data: ptsFlat, shape: [n, d] });

// Brute-force reference
const q0 = qFlat.slice(0, d);
const brute = bruteKnn(ptsFlat, n, d, q0, K);
console.log('Query point:', Array.from(q0));
console.log();
console.log('Brute-force k=10 nearest:');
for (let i = 0; i < K; i++) {
  console.log(`  ${i}: idx=${brute.idx[i]} dist=${brute.dist[i].toFixed(6)}`);
}
console.log();

// Scitra single query
const sciRes = tree.query(q0, K);
console.log('scitra k=10 nearest:');
for (let i = 0; i < K; i++) {
  const match = sciRes.idx[i] === brute.idx[i] ? '✓' : '✗';
  console.log(`  ${i}: idx=${sciRes.idx[i]} dist=${sciRes.dist[i].toFixed(6)} ${match}`);
}
console.log();

// What's in scitra's result that brute-force says shouldn't be there?
const bruteSet = new Set(brute.idx);
const sciSet = new Set(sciRes.idx);
console.log('In scitra but not brute:');
for (const x of sciSet) if (!bruteSet.has(x)) console.log(`  idx=${x}`);
console.log('In brute but not scitra:');
for (const x of bruteSet) if (!sciSet.has(x)) console.log(`  idx=${x}`);
console.log();

// Find what distance scitra MISSED but should have found
const missedIdxs = [...bruteSet].filter(x => !sciSet.has(x));
if (missedIdxs.length > 0) {
  console.log('scitra missed these points — their actual distances:');
  for (const idx of missedIdxs) {
    let sq = 0;
    for (let j = 0; j < d; j++) {
      const diff = ptsFlat[idx * d + j] - q0[j];
      sq += diff * diff;
    }
    console.log(`  idx=${idx} dist=${Math.sqrt(sq).toFixed(6)} (rank=${brute.idx.indexOf(idx)})`);
  }
}

// And the false-positives scitra reported
const falsePositives = [...sciSet].filter(x => !bruteSet.has(x));
if (falsePositives.length > 0) {
  console.log('scitra reported these instead — their actual distances:');
  for (const idx of falsePositives) {
    let sq = 0;
    for (let j = 0; j < d; j++) {
      const diff = ptsFlat[idx * d + j] - q0[j];
      sq += diff * diff;
    }
    console.log(`  idx=${idx} dist=${Math.sqrt(sq).toFixed(6)}`);
  }
}
