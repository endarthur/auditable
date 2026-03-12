// WebGPU winding number evaluation

const WGSL_SHADER = /* wgsl */`
struct Params {
  origin: vec3<f32>,
  block_size_x: f32,
  block_size: vec3<f32>,
  block_count_x: u32,
  block_count: vec3<u32>,
  resolution_x: u32,
  resolution: vec3<u32>,
  threshold: f32,
  z_block: u32,
  z_sub: u32,
  _pad: u32,
}

struct BVHNode {
  min: vec3<f32>,
  max: vec3<f32>,
  data1: f32,  // leaf: first, internal: left child
  data2: f32,  // leaf: count > 0, internal: -(right) - 1
}

@group(0) @binding(0) var<storage, read> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> tri_indices_raw: array<u32>;
@group(0) @binding(2) var<storage, read> bvh_nodes: array<f32>;
@group(0) @binding(3) var<storage, read> bvh_tri_indices: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: Params;

fn solid_angle(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
  let ap = a - p;
  let bp = b - p;
  let cp = c - p;
  let ra = length(ap);
  let rb = length(bp);
  let rc = length(cp);

  if (ra < 1e-10 || rb < 1e-10 || rc < 1e-10) { return 0.0; }

  let num = dot(ap, cross(bp, cp));
  let den = ra * rb * rc + dot(ap, bp) * rc + dot(bp, cp) * ra + dot(cp, ap) * rb;
  return 2.0 * atan2(num, den);
}

fn load_vertex(idx: u32) -> vec3<f32> {
  return vec3<f32>(vertices[idx * 3u], vertices[idx * 3u + 1u], vertices[idx * 3u + 2u]);
}

fn traverse_bvh(p: vec3<f32>) -> f32 {
  var winding: f32 = 0.0;
  var stack: array<u32, 64>;
  var sp: u32 = 0u;
  stack[0] = 0u;
  sp = 1u;

  while (sp > 0u) {
    sp -= 1u;
    let node_idx = stack[sp];
    let off = node_idx * 8u;

    let data2 = bvh_nodes[off + 7u];

    if (data2 > 0.0) {
      // Leaf: first = data1, count = data2
      let first = u32(bvh_nodes[off + 6u]);
      let count = u32(data2);
      for (var t = first; t < first + count; t++) {
        let ti = bvh_tri_indices[t];
        let a = load_vertex(tri_indices_raw[ti * 3u]);
        let b = load_vertex(tri_indices_raw[ti * 3u + 1u]);
        let c = load_vertex(tri_indices_raw[ti * 3u + 2u]);
        winding += solid_angle(p, a, b, c);
      }
    } else {
      // Internal: left = data1, right = -(data2) - 1
      let left = u32(bvh_nodes[off + 6u]);
      let right = u32(-(data2) - 1.0);
      if (sp < 62u) {
        stack[sp] = left; sp += 1u;
        stack[sp] = right; sp += 1u;
      }
    }
  }

  return winding;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let xi = gid.x;
  let yi = gid.y;

  let sx = params.resolution.x;
  let sy = params.resolution.y;

  let bi = xi / sx;
  let bj = yi / sy;
  if (bi >= params.block_count.x || bj >= params.block_count.y) { return; }

  let si = xi % sx;
  let sj = yi % sy;

  let px = params.origin.x + (f32(bi) + (f32(si) + 0.5) / f32(sx)) * params.block_size.x;
  let py = params.origin.y + (f32(bj) + (f32(sj) + 0.5) / f32(sy)) * params.block_size.y;
  let pz = params.origin.z + (f32(params.z_block) + (f32(params.z_sub) + 0.5) / f32(params.resolution.z)) * params.block_size.z;

  let w = traverse_bvh(vec3<f32>(px, py, pz));
  let threshold_scaled = params.threshold * 4.0 * 3.14159265;
  let inside = select(0u, 1u, w >= threshold_scaled);

  let block_idx = bi + bj * params.block_count.x + params.z_block * params.block_count.x * params.block_count.y;
  atomicAdd(&counters[block_idx], inside);
}
`;

const WGSL_FINALIZE = /* wgsl */`
@group(0) @binding(0) var<storage, read> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> proportions: array<f32>;
@group(0) @binding(2) var<uniform> sub_total: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&proportions)) { return; }
  proportions[idx] = f32(counters[idx]) / f32(sub_total);
}
`;

async function createGPUEvaluator(device) {
  const mainModule = device.createShaderModule({ code: WGSL_SHADER });
  const finalizeModule = device.createShaderModule({ code: WGSL_FINALIZE });

  const mainPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: mainModule, entryPoint: 'main' },
  });

  const finalizePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: finalizeModule, entryPoint: 'main' },
  });

  return { device, mainPipeline, finalizePipeline };
}

async function evaluateGPU(gpu, vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const { device, mainPipeline, finalizePipeline } = gpu;
  const { mode = 'proportion', resolution = [4, 4, 4], threshold = 0.5, onProgress } = opts;
  const { origin, size, count } = blockModel;
  const [nx, ny, nz] = count;
  const [sx, sy, sz] = resolution;
  const total = nx * ny * nz;
  const subTotal = sx * sy * sz;

  // Create GPU buffers
  const vertBuf = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const triBuf = device.createBuffer({ size: triangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhBuf = device.createBuffer({ size: bvhNodes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhTriBuf = device.createBuffer({ size: triIndices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const counterBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const propBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Params: 16 floats (64 bytes), padded to 16-byte alignment
  // origin(3) + pad + block_size(3) + block_count_x + block_count(3) + resolution_x
  // + resolution(3) + threshold + z_block + z_sub + pad
  const paramData = new ArrayBuffer(80);
  const paramF = new Float32Array(paramData);
  const paramU = new Uint32Array(paramData);
  paramF[0] = origin[0]; paramF[1] = origin[1]; paramF[2] = origin[2]; paramF[3] = 0;
  paramF[4] = size[0]; paramF[5] = size[1]; paramF[6] = size[2]; paramU[7] = nx;
  paramU[8] = nx; paramU[9] = ny; paramU[10] = nz; paramU[11] = sx;
  paramU[12] = sx; paramU[13] = sy; paramU[14] = sz; paramF[15] = threshold;
  // z_block and z_sub set per dispatch

  const paramBuf = device.createBuffer({ size: paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Upload static data
  device.queue.writeBuffer(vertBuf, 0, vertices);
  device.queue.writeBuffer(triBuf, 0, triangles);
  device.queue.writeBuffer(bvhBuf, 0, bvhNodes);
  device.queue.writeBuffer(bvhTriBuf, 0, triIndices);

  const mainBindGroup = device.createBindGroup({
    layout: mainPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: vertBuf } },
      { binding: 1, resource: { buffer: triBuf } },
      { binding: 2, resource: { buffer: bvhBuf } },
      { binding: 3, resource: { buffer: bvhTriBuf } },
      { binding: 4, resource: { buffer: counterBuf } },
      { binding: 5, resource: { buffer: paramBuf } },
    ],
  });

  // Dispatch: for each z-block and z-sub-layer
  // Each z-layer gets its own submit so writeBuffer is visible to the dispatch
  const dispatchX = Math.ceil((nx * sx) / 8);
  const dispatchY = Math.ceil((ny * sy) / 8);

  // Clear counters to zero
  {
    const enc = device.createCommandEncoder();
    enc.clearBuffer(counterBuf);
    device.queue.submit([enc.finish()]);
  }

  for (let zb = 0; zb < nz; zb++) {
    for (let zs = 0; zs < sz; zs++) {
      paramU[16] = zb;
      paramU[17] = zs;
      device.queue.writeBuffer(paramBuf, 0, paramData);

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(mainPipeline);
      pass.setBindGroup(0, mainBindGroup);
      pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    if (onProgress) onProgress((zb + 1) / nz);
  }

  if (mode === 'proportion') {
    // Finalize: convert counters to proportions
    const subTotalBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(subTotalBuf, 0, new Uint32Array([subTotal]));

    const finalizeBindGroup = device.createBindGroup({
      layout: finalizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: counterBuf } },
        { binding: 1, resource: { buffer: propBuf } },
        { binding: 2, resource: { buffer: subTotalBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(finalizePipeline);
    pass.setBindGroup(0, finalizeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(total / 64), 1, 1);
    pass.end();

    enc.copyBufferToBuffer(propBuf, 0, readBuf, 0, total * 4);
    device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const proportions = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    const flags = new Uint8Array(total);
    for (let i = 0; i < total; i++) flags[i] = proportions[i] >= threshold ? 1 : 0;

    // Cleanup
    vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
    counterBuf.destroy(); propBuf.destroy(); readBuf.destroy(); paramBuf.destroy();
    subTotalBuf.destroy();

    return { proportions, flags };
  }

  // Flag mode: read counters (each is 0 or 1 for centroid-only)
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(counterBuf, 0, readBuf, 0, total * 4);
    device.queue.submit([enc.finish()]);
  }

  await readBuf.mapAsync(GPUMapMode.READ);
  const rawCounters = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  const flags = new Uint8Array(total);
  for (let i = 0; i < total; i++) flags[i] = rawCounters[i] > 0 ? 1 : 0;

  vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
  counterBuf.destroy(); propBuf.destroy(); readBuf.destroy(); paramBuf.destroy();

  return { flags };
}

export { createGPUEvaluator, evaluateGPU, WGSL_SHADER, WGSL_FINALIZE };
