// Web Worker for off-main-thread winding number evaluation (CPU and GPU paths)
// Worker blob inlines all evaluation code via Function.toString() + JSON.stringify()

import { NODE_SIZE } from './bvh.js';
import { solidAngle, windingBrute, windingBVH, evaluateCPU } from './cpu.js';
import { createGPUEvaluator, evaluateGPU, WGSL_SHADER, WGSL_FINALIZE } from './gpu.js';

function createWindingWorker(opts = {}) {
  const source = `
const NODE_SIZE = ${NODE_SIZE};
const PI4 = 4 * Math.PI;

// -- CPU path --
${solidAngle.toString()}
${windingBrute.toString()}
${windingBVH.toString()}
${evaluateCPU.toString()}

// -- GPU path --
const WGSL_SHADER = ${JSON.stringify(WGSL_SHADER)};
const WGSL_FINALIZE = ${JSON.stringify(WGSL_FINALIZE)};
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
    const { name, blockModel, mode, resolution, threshold } = e.data;
    const mesh = _meshes.get(name);
    if (!mesh) {
      self.postMessage({ type: 'error', message: 'Mesh not found: ' + name });
      return;
    }
    const opts = {
      mode: mode || 'proportion',
      resolution: resolution || [4, 4, 4],
      threshold: threshold != null ? threshold : 0.5,
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
      transfer.push(result.flags.buffer);
      self.postMessage({
        type: 'result',
        proportions: result.proportions || null,
        flags: result.flags,
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

  // Send init message — caller awaits 'ready' response
  worker.postMessage({ type: 'init', gpu: !!opts.gpu });
  return worker;
}

// Wait for worker init to complete, returns { worker, hasGPU }
async function initWindingWorker(opts = {}) {
  const worker = createWindingWorker(opts);
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
      resolution: opts.resolution,
      threshold: opts.threshold,
    });
  });
}

export { initWindingWorker, evaluateWorker };
