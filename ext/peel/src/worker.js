// Web Worker for off-main-thread depth peeling evaluation (CPU and GPU paths)
// Worker blob inlines all evaluation code via Function.toString() + JSON.stringify()

import { NODE_SIZE } from './bvh.js';
import { rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, evaluateCPU, AXIS_MAP } from './cpu.js';
import { createGPUEvaluator, evaluateGPU, generatePeelShader, FINALIZE_SHADER } from './gpu.js';

function createPeelWorker(opts = {}) {
  const source = `
const NODE_SIZE = ${NODE_SIZE};
const AXIS_MAP = ${JSON.stringify(AXIS_MAP)};
const DEPTH_EPS = 1e-6;

// -- CPU path --
${rayTriangle.toString()}
${rayAABB.toString()}

function insertDepth(depths, count, maxPeels, t) {
  const n = Math.min(count, maxPeels);
  for (let i = 0; i < n; i++) {
    if (Math.abs(depths[i] - t) < DEPTH_EPS) return count;
  }
  if (count < maxPeels) {
    let pos = count;
    while (pos > 0 && depths[pos - 1] > t) { depths[pos] = depths[pos - 1]; pos--; }
    depths[pos] = t;
    return count + 1;
  } else if (t < depths[maxPeels - 1]) {
    let pos = maxPeels - 1;
    while (pos > 0 && depths[pos - 1] > t) { depths[pos] = depths[pos - 1]; pos--; }
    depths[pos] = t;
    return count;
  }
  return count;
}

${peelColumnBrute.toString()}
${peelColumnBVH.toString()}

function getIntervals(depths, count, surfaceType) {
  const intervals = [];
  if (count === 0) return intervals;
  if (surfaceType === 'open') {
    intervals.push([-Infinity, depths[0]]);
  } else {
    for (let i = 0; i + 1 < count; i += 2) {
      intervals.push([depths[i], depths[i + 1]]);
    }
    if (count % 2 === 1) {
      intervals.push([depths[count - 1], Infinity]);
    }
  }
  return intervals;
}

function intervalOverlap(intervals, lo, hi) {
  let overlap = 0;
  for (let i = 0; i < intervals.length; i++) {
    const a = intervals[i][0], b = intervals[i][1];
    overlap += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
  }
  return overlap;
}

${evaluateCPU.toString()}

// -- GPU path --
const generatePeelShader = ${generatePeelShader.toString()};
const FINALIZE_SHADER = ${JSON.stringify(FINALIZE_SHADER)};
${createGPUEvaluator.toString()}
${evaluateGPU.toString()}

const _meshes = new Map();
let _gpu = null;

async function init(tryGPU) {
  if (tryGPU) {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        _gpu = await createGPUEvaluator(device);
      }
    } catch (e) {}
  }
  self.postMessage({ type: 'ready', hasGPU: !!_gpu });
}

self.onmessage = async function(e) {
  const { type } = e.data;

  if (type === 'init') {
    await init(e.data.gpu);

  } else if (type === 'setMesh') {
    const { name, vertices, triangles, bvhNodes, triIndices } = e.data;
    _meshes.set(name, { vertices, triangles, bvhNodes, triIndices });

  } else if (type === 'evaluate') {
    const { name, blockModel, mode, axis, surfaceType, maxPeels, resolution } = e.data;
    const mesh = _meshes.get(name);
    if (!mesh) {
      self.postMessage({ type: 'error', message: 'Mesh not found: ' + name });
      return;
    }
    const opts = {
      mode: mode || 'proportion',
      axis: axis || 'z',
      surfaceType: surfaceType || 'closed',
      maxPeels: maxPeels || 16,
      resolution: resolution || [1, 1],
      onProgress: (frac) => self.postMessage({ type: 'progress', fraction: frac }),
    };
    try {
      let result;
      if (_gpu) {
        result = await evaluateGPU(_gpu, mesh.vertices, mesh.triangles,
          mesh.bvhNodes, mesh.triIndices, blockModel, opts);
      } else {
        result = await evaluateCPU(mesh.vertices, mesh.triangles,
          mesh.bvhNodes, mesh.triIndices, blockModel, opts);
      }
      const transfer = [];
      if (result.proportions) transfer.push(result.proportions.buffer);
      if (result.flags) transfer.push(result.flags.buffer);
      if (result.depths) transfer.push(result.depths.buffer);
      if (result.counts) transfer.push(result.counts.buffer);
      self.postMessage({
        type: 'result',
        proportions: result.proportions || null,
        flags: result.flags || null,
        depths: result.depths || null,
        counts: result.counts || null,
        overflow: result.overflow || 0,
      }, transfer);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }

  } else if (type === 'terminate') {
    self.close();
  }
};
`;
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);

  worker.postMessage({ type: 'init', gpu: !!opts.gpu });
  return worker;
}

async function initPeelWorker(opts = {}) {
  const worker = createPeelWorker(opts);
  const hasGPU = await new Promise((resolve, reject) => {
    function handler(e) {
      if (e.data.type === 'ready') {
        worker.removeEventListener('message', handler);
        resolve(e.data.hasGPU);
      }
    }
    worker.addEventListener('message', handler);
    worker.addEventListener('error', reject, { once: true });
  });
  return { worker, hasGPU };
}

function evaluateWorker(worker, meshName, blockModel, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress } = opts;

    function handler(e) {
      const { type } = e.data;
      if (type === 'progress') {
        if (onProgress) onProgress(e.data.fraction);
      } else if (type === 'result') {
        worker.removeEventListener('message', handler);
        resolve({
          proportions: e.data.proportions,
          flags: e.data.flags,
          depths: e.data.depths,
          counts: e.data.counts,
          overflow: e.data.overflow,
        });
      } else if (type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message));
      }
    }

    worker.addEventListener('message', handler);
    worker.addEventListener('error', reject, { once: true });

    worker.postMessage({
      type: 'evaluate',
      name: meshName,
      blockModel,
      mode: opts.mode,
      axis: opts.axis,
      surfaceType: opts.surfaceType,
      maxPeels: opts.maxPeels,
      resolution: opts.resolution,
    });
  });
}

export { initPeelWorker, evaluateWorker };
