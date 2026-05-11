// Trace scitra _knn to find why it misses idx=925 in n=1000 d=3 case.
// Idea: rewrite _knn locally with verbose logging, run on same data, see
// where the prune decisions diverge.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KDTree } from '../ext/scitra/src/spatial/kdtree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(__dirname, '..', '.kdtree-bench-data');

function loadBin(filePath) {
  const buf = readFileSync(filePath);
  return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const n = 1000, d = 3, K = 10;
const ptsFlat = loadBin(path.join(BENCH_DIR, `pts_${n}x${d}.bin`));
const qFlat = loadBin(path.join(BENCH_DIR, `queries_${n}x${d}.bin`));
const q = qFlat.slice(0, d);
const targetIdx = 925;
const targetPt = ptsFlat.slice(targetIdx * d, (targetIdx + 1) * d);
console.log(`Target missed point: idx=${targetIdx} pt=[${Array.from(targetPt).map(x=>x.toFixed(3))}]`);
console.log(`Query point: [${Array.from(q).map(x=>x.toFixed(3))}]`);
let actualSqDist = 0;
for (let i = 0; i < d; i++) actualSqDist += (targetPt[i] - q[i]) ** 2;
console.log(`Target sq dist from q: ${actualSqDist.toFixed(3)} (dist: ${Math.sqrt(actualSqDist).toFixed(3)})`);
console.log();

// Build the tree using scitra
const tree = new KDTree({ data: ptsFlat, shape: [n, d] });

// Locate which leaf contains 925, and the path to it
// (need to find the position of 925 in tree._perm, then walk the tree)
const permIdxOf925 = Array.from(tree._perm).indexOf(925);
console.log(`Point 925 sits at perm position ${permIdxOf925}`);

// Walk the tree, find the leaf node that contains permIdxOf925
function findLeafFor(permPos, nodeId = tree._root, path = []) {
  if (nodeId < 0) return null;
  if (tree._splitDim[nodeId] === -1) {
    const lo = tree._leafStart[nodeId], hi = tree._leafEnd[nodeId];
    if (permPos >= lo && permPos < hi) {
      return { nodeId, path: [...path, { nodeId, type: 'leaf', lo, hi }] };
    }
    return null;
  }
  const axis = tree._splitDim[nodeId];
  const splitVal = tree._splitVal[nodeId];
  // Walk both children
  for (const childId of [tree._leftIdx[nodeId], tree._rightIdx[nodeId]]) {
    const r = findLeafFor(permPos, childId, [...path, { nodeId, axis, splitVal, side: childId === tree._leftIdx[nodeId] ? 'L' : 'R' }]);
    if (r) return r;
  }
  return null;
}

const result = findLeafFor(permIdxOf925);
console.log('\nPath from root to leaf containing 925:');
for (const step of result.path) {
  if (step.type === 'leaf') {
    console.log(`  [leaf nodeId=${step.nodeId}] indices ${step.lo}..${step.hi-1}`);
  } else {
    console.log(`  [internal nodeId=${step.nodeId}] axis=${step.axis} splitVal=${step.splitVal.toFixed(3)}, went ${step.side}`);
  }
}

// Now simulate the _knn traversal manually, logging decisions
console.log('\nSimulated _knn traversal with logging:');
class TraceHeap {
  constructor(k) { this.k = k; this.dist = []; this.idx = []; }
  get size() { return this.dist.length; }
  top() { return this.dist[0]; }
  push(d, i) {
    if (this.dist.length < this.k) {
      this.dist.push(d); this.idx.push(i);
      this.dist.sort((a, b) => b - a);  // dumb: just keep sorted desc
      return;
    }
    if (d < this.dist[0]) {
      this.dist[0] = d; this.idx[0] = i;
      this.dist.sort((a, b) => b - a);
    }
  }
}

const heap = new TraceHeap(K);

function knn(nodeId, depth = 0) {
  const indent = '  '.repeat(depth);
  if (nodeId < 0) return;
  if (tree._splitDim[nodeId] === -1) {
    const lo = tree._leafStart[nodeId], hi = tree._leafEnd[nodeId];
    let added = [];
    for (let i = lo; i < hi; i++) {
      let sq = 0;
      const pi = tree._perm[i];
      for (let k = 0; k < d; k++) {
        const t = ptsFlat[pi * d + k] - q[k];
        sq += t * t;
      }
      heap.push(sq, pi);
      added.push({ pi, sq });
    }
    const has925 = added.some(a => a.pi === 925);
    if (has925) {
      console.log(`${indent}LEAF nodeId=${nodeId} CONTAINS 925, heap.size=${heap.size}, heap.top=${heap.top()?.toFixed(2)}`);
    }
    return;
  }
  const axis = tree._splitDim[nodeId];
  const splitVal = tree._splitVal[nodeId];
  const diff = q[axis] - splitVal;
  const near = diff < 0 ? tree._leftIdx[nodeId] : tree._rightIdx[nodeId];
  const far = diff < 0 ? tree._rightIdx[nodeId] : tree._leftIdx[nodeId];
  knn(near, depth + 1);
  const bound = diff * diff;
  const visit = heap.size < heap.k || bound < heap.top();

  // Check if far subtree contains 925
  function containsIdx(nid, target) {
    if (nid < 0) return false;
    if (tree._splitDim[nid] === -1) {
      const lo = tree._leafStart[nid], hi = tree._leafEnd[nid];
      for (let i = lo; i < hi; i++) if (tree._perm[i] === target) return true;
      return false;
    }
    return containsIdx(tree._leftIdx[nid], target) || containsIdx(tree._rightIdx[nid], target);
  }
  const farHas925 = containsIdx(far, 925);

  if (farHas925) {
    console.log(`${indent}AT INTERNAL nodeId=${nodeId} axis=${axis} splitVal=${splitVal.toFixed(3)}: bound=${bound.toFixed(2)} heap.size=${heap.size} heap.top=${heap.top()?.toFixed(2)}`);
    console.log(`${indent}  Far subtree CONTAINS 925. visit-far decision: ${visit ? 'YES' : '✗ PRUNE'}`);
  }
  if (visit) knn(far, depth + 1);
}

knn(tree._root);

console.log('\nFinal heap (sorted descending by dist):');
for (let i = 0; i < heap.size; i++) {
  console.log(`  ${i}: idx=${heap.idx[i]} sq=${heap.dist[i].toFixed(2)} dist=${Math.sqrt(heap.dist[i]).toFixed(3)}`);
}
