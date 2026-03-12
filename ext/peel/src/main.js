// PEEL — Depth Peeling Surface Intersection Engine
// Main API: Peel.create({ device?, worker?, gpu? }), setMesh(), evaluate()

import { buildBVH } from './bvh.js';
import { evaluateCPU } from './cpu.js';
import { createGPUEvaluator, evaluateGPU } from './gpu.js';
import { initPeelWorker, evaluateWorker } from './worker.js';

class Peel {
  constructor() {
    this._gpu = null;       // main-thread GPU evaluator
    this._worker = null;    // Worker instance
    this._workerGPU = false; // whether worker has GPU
    this._meshes = new Map();
    this._defaultMesh = null;
  }

  // Create a Peel instance
  // opts.device: GPUDevice for main-thread WebGPU
  // opts.worker: true to run evaluation in a Web Worker
  // opts.gpu: true to let the worker request its own GPUDevice (requires worker: true)
  static async create(opts = {}) {
    const { device, worker, gpu } = opts;
    const p = new Peel();

    if (device) {
      p._gpu = await createGPUEvaluator(device);
    }

    if (worker) {
      const result = await initPeelWorker({ gpu: !!gpu });
      p._worker = result.worker;
      p._workerGPU = result.hasGPU;
    }

    return p;
  }

  // Load a mesh. Builds BVH on main thread, sends to worker if active.
  setMesh(vertices, triangles, opts = {}) {
    const name = opts.name || '_default';
    const bvh = buildBVH(vertices, triangles, {
      maxLeafSize: opts.maxLeafSize || 4,
    });
    const mesh = { vertices, triangles, bvh };
    this._meshes.set(name, mesh);
    if (name === '_default' || this._meshes.size === 1) {
      this._defaultMesh = mesh;
    }

    if (this._worker) {
      this._worker.postMessage({
        type: 'setMesh',
        name,
        vertices: new Float32Array(vertices),
        triangles: new Uint32Array(triangles),
        bvhNodes: new Float32Array(bvh.nodes),
        triIndices: new Uint32Array(bvh.triIndices),
      });
    }

    return {
      nodeCount: bvh.nodeCount,
      triangleCount: bvh.triIndices.length,
      degenerateCount: bvh.degenerateCount,
    };
  }

  // Get pre-built BVH data (for sharing with other modules)
  getBVH(name) {
    const mesh = this._meshes.get(name || '_default') || this._defaultMesh;
    if (!mesh) return null;
    return { nodes: mesh.bvh.nodes, triIndices: mesh.bvh.triIndices };
  }

  // Evaluate a single mesh against a block model
  // Priority: worker (GPU or CPU) > main-thread GPU > main-thread CPU
  async evaluate(blockModel, opts = {}) {
    const meshName = opts.mesh || '_default';
    const mesh = this._meshes.get(meshName) || this._defaultMesh;
    if (!mesh) throw new Error('No mesh loaded. Call setMesh() first.');

    if (this._worker) {
      return evaluateWorker(this._worker, meshName, blockModel, opts);
    }

    const { vertices, triangles, bvh } = mesh;

    if (this._gpu) {
      return evaluateGPU(this._gpu, vertices, triangles,
        bvh.nodes, bvh.triIndices, blockModel, opts);
    }

    return evaluateCPU(vertices, triangles,
      bvh.nodes, bvh.triIndices, blockModel, opts);
  }

  // Evaluate multiple named surfaces against the same block model
  async evaluateMultiple(blockModel, opts = {}) {
    const { surfaces = [], ...evalOpts } = opts;
    const results = {};
    for (const name of surfaces) {
      results[name] = await this.evaluate(blockModel, { ...evalOpts, mesh: name });
    }
    return results;
  }

  // true if any GPU path is active (main-thread or worker)
  get hasGPU() { return this._gpu !== null || this._workerGPU; }
  get hasWorker() { return this._worker !== null; }

  // Terminate worker. Falls back to main-thread GPU or CPU.
  terminate() {
    if (this._worker) {
      this._worker.postMessage({ type: 'terminate' });
      this._worker = null;
      this._workerGPU = false;
    }
  }
}

export { Peel, buildBVH };
