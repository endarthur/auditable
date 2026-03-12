// WINDING — Generalized Winding Number Block Model Evaluator
// Main API: Winding.create(device?), setMesh(), evaluate(), evaluateMultiple()

import { buildBVH } from './bvh.js';
import { evaluateCPU } from './cpu.js';
import { createGPUEvaluator, evaluateGPU } from './gpu.js';

class Winding {
  constructor(gpu) {
    this._gpu = gpu; // null for CPU-only mode
    this._meshes = new Map(); // name -> { vertices, triangles, bvh }
    this._defaultMesh = null;
  }

  // Create a Winding instance
  // device: GPUDevice (optional — omit for CPU-only mode)
  static async create(device) {
    let gpu = null;
    if (device) {
      gpu = await createGPUEvaluator(device);
    }
    return new Winding(gpu);
  }

  // Load a mesh. Builds BVH internally.
  // vertices: Float32Array [x0,y0,z0, x1,y1,z1, ...]
  // triangles: Uint32Array [a0,b0,c0, a1,b1,c1, ...]
  // opts.name: string (for multi-surface workflows, default: '_default')
  // opts.maxLeafSize: number (BVH leaf size, default: 4)
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
    return {
      nodeCount: bvh.nodeCount,
      triangleCount: bvh.triIndices.length,
      degenerateCount: bvh.degenerateCount,
    };
  }

  // Evaluate a single mesh against a block model
  // blockModel: { origin: [x,y,z], size: [dx,dy,dz], count: [nx,ny,nz] }
  // opts.mode: 'flag' | 'proportion' (default: 'proportion')
  // opts.resolution: [sx,sy,sz] (default: [4,4,4])
  // opts.threshold: number (default: 0.5)
  // opts.mesh: string (mesh name, default: '_default')
  async evaluate(blockModel, opts = {}) {
    const meshName = opts.mesh || '_default';
    const mesh = this._meshes.get(meshName) || this._defaultMesh;
    if (!mesh) throw new Error('No mesh loaded. Call setMesh() first.');

    const { vertices, triangles, bvh } = mesh;

    if (this._gpu) {
      return evaluateGPU(this._gpu, vertices, triangles,
        bvh.nodes, bvh.triIndices, blockModel, opts);
    }

    return evaluateCPU(vertices, triangles,
      bvh.nodes, bvh.triIndices, blockModel, opts);
  }

  // Evaluate multiple named surfaces against the same block model
  // opts.surfaces: string[] (mesh names)
  // Other opts same as evaluate()
  async evaluateMultiple(blockModel, opts = {}) {
    const { surfaces = [], ...evalOpts } = opts;
    const results = {};
    for (const name of surfaces) {
      results[name] = await this.evaluate(blockModel, { ...evalOpts, mesh: name });
    }
    return results;
  }

  // Check if GPU acceleration is available
  get hasGPU() {
    return this._gpu !== null;
  }
}

export { Winding, buildBVH };
