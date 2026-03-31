// WebGPU depth peeling evaluation

function generatePeelShader(maxPeels) {
  return /* wgsl */`
const MAX_PEELS: u32 = ${maxPeels}u;
const DEPTH_EPS: f32 = 1e-6;

struct Params {
  origin: vec3<f32>,
  _pad0: f32,
  block_size: vec3<f32>,
  _pad1: f32,
  block_count: vec3<u32>,
  axis: u32,          // 0=x, 1=y, 2=z
  sub_uv: vec2<u32>,  // su, sv
  grid_uv: vec2<u32>, // gridU, gridV
  mode: u32,          // 0=depths, 1=flag, 2=proportion
  surface_type: u32,  // 0=closed, 1=open
  scale: u32,         // proportion scale factor
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> tri_indices: array<u32>;
@group(0) @binding(2) var<storage, read> bvh_nodes: array<f32>;
@group(0) @binding(3) var<storage, read> bvh_tri_indices: array<u32>;
@group(0) @binding(4) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> counts_out: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> params: Params;

fn load_vertex(idx: u32) -> vec3<f32> {
  return vec3<f32>(vertices[idx * 3u], vertices[idx * 3u + 1u], vertices[idx * 3u + 2u]);
}

fn ray_triangle(o: vec3<f32>, d: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
  let e1 = b - a;
  let e2 = c - a;
  let h = cross(d, e2);
  let det = dot(e1, h);
  if (abs(det) < 1e-8) { return -1.0; }
  let f = 1.0 / det;
  let s = o - a;
  let u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(s, e1);
  let v = f * dot(d, q);
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let t = f * dot(e2, q);
  if (t > 0.0) { return t; }
  return -1.0;
}

fn ray_aabb(o: vec3<f32>, inv_d: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> bool {
  let t1 = (bmin - o) * inv_d;
  let t2 = (bmax - o) * inv_d;
  let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
  let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
  return tmax >= max(tmin, 0.0);
}

fn insert_depth(depths: ptr<function, array<f32, MAX_PEELS>>, count: ptr<function, u32>, t: f32) -> bool {
  let n = min(*count, MAX_PEELS);
  for (var i = 0u; i < n; i++) {
    if (abs((*depths)[i] - t) < DEPTH_EPS) { return false; }
  }
  if (*count < MAX_PEELS) {
    var pos = *count;
    while (pos > 0u && (*depths)[pos - 1u] > t) {
      (*depths)[pos] = (*depths)[pos - 1u];
      pos -= 1u;
    }
    (*depths)[pos] = t;
    *count += 1u;
    return false;
  } else if (t < (*depths)[MAX_PEELS - 1u]) {
    var pos = MAX_PEELS - 1u;
    while (pos > 0u && (*depths)[pos - 1u] > t) {
      (*depths)[pos] = (*depths)[pos - 1u];
      pos -= 1u;
    }
    (*depths)[pos] = t;
    return true; // overflow
  }
  return false;
}

// Get axis component from vec3
fn axis_val(v: vec3<f32>, a: u32) -> f32 {
  return select(select(v.x, v.y, a == 1u), v.z, a == 2u);
}

fn axis_valu(v: vec3<u32>, a: u32) -> u32 {
  return select(select(v.x, v.y, a == 1u), v.z, a == 2u);
}

// Plane axes for given block axis
fn plane_axis_0(a: u32) -> u32 { return select(select(1u, 0u, a == 1u), 0u, a == 2u); }
fn plane_axis_1(a: u32) -> u32 { return select(select(2u, 2u, a == 1u), 1u, a == 2u); }

fn set_axis(v: ptr<function, vec3<f32>>, a: u32, val: f32) {
  if (a == 0u) { (*v).x = val; }
  else if (a == 1u) { (*v).y = val; }
  else { (*v).z = val; }
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ray_idx = gid.x;
  let total_u = params.grid_uv.x * params.sub_uv.x;
  let total_v = params.grid_uv.y * params.sub_uv.y;
  let total_rays = total_u * total_v;
  if (ray_idx >= total_rays) { return; }

  let ui = ray_idx % total_u;
  let vi = ray_idx / total_u;
  let col_u = ui / params.sub_uv.x;
  let col_v = vi / params.sub_uv.y;
  let sub_u = ui % params.sub_uv.x;
  let sub_v = vi % params.sub_uv.y;

  let ba = params.axis;
  let pa0 = plane_axis_0(ba);
  let pa1 = plane_axis_1(ba);

  // Ray origin
  var ray_origin = vec3<f32>(0.0, 0.0, 0.0);
  let u_pos = axis_val(params.origin, pa0) + (f32(col_u) + (f32(sub_u) + 0.5) / f32(params.sub_uv.x)) * axis_val(params.block_size, pa0);
  let v_pos = axis_val(params.origin, pa1) + (f32(col_v) + (f32(sub_v) + 0.5) / f32(params.sub_uv.y)) * axis_val(params.block_size, pa1);
  let ray_start = axis_val(params.origin, ba) - 1.0;
  set_axis(&ray_origin, pa0, u_pos);
  set_axis(&ray_origin, pa1, v_pos);
  set_axis(&ray_origin, ba, ray_start);

  // Ray direction (unit along axis)
  var ray_dir = vec3<f32>(0.0, 0.0, 0.0);
  set_axis(&ray_dir, ba, 1.0);
  let inv_d = 1.0 / ray_dir; // will have Inf for non-axis components

  // BVH traversal
  var depths: array<f32, MAX_PEELS>;
  for (var i = 0u; i < MAX_PEELS; i++) { depths[i] = 1e30; }
  var count: u32 = 0u;
  var overflow: bool = false;

  var stack: array<u32, 64>;
  var sp: u32 = 1u;
  stack[0] = 0u;

  while (sp > 0u) {
    sp -= 1u;
    let node_idx = stack[sp];
    let off = node_idx * 8u;
    let bmin = vec3<f32>(bvh_nodes[off], bvh_nodes[off + 1u], bvh_nodes[off + 2u]);
    let bmax = vec3<f32>(bvh_nodes[off + 3u], bvh_nodes[off + 4u], bvh_nodes[off + 5u]);

    if (!ray_aabb(ray_origin, inv_d, bmin, bmax)) { continue; }

    let data2 = bvh_nodes[off + 7u];
    if (data2 > 0.0) {
      let first = u32(bvh_nodes[off + 6u]);
      let cnt = u32(data2);
      for (var ti = first; ti < first + cnt; ti++) {
        let tri = bvh_tri_indices[ti];
        let a = load_vertex(tri_indices[tri * 3u]);
        let b = load_vertex(tri_indices[tri * 3u + 1u]);
        let c = load_vertex(tri_indices[tri * 3u + 2u]);
        let t = ray_triangle(ray_origin, ray_dir, a, b, c);
        if (t > 0.0) {
          let did_overflow = insert_depth(&depths, &count, t);
          overflow = overflow || did_overflow;
        }
      }
    } else {
      let left = u32(bvh_nodes[off + 6u]);
      let right = u32(-(data2) - 1.0);
      if (sp < 62u) {
        stack[sp] = left; sp += 1u;
        stack[sp] = right; sp += 1u;
      }
    }
  }

  let n = min(count, MAX_PEELS);
  let col_idx = col_u + col_v * params.grid_uv.x;

  // Overflow tracking (first slot of counts_out is used for per-column count,
  // overflow is tracked by atomicAdd on a separate counter at end of counts_out)
  if (overflow) {
    atomicAdd(&counts_out[params.grid_uv.x * params.grid_uv.y], 1u);
  }

  if (params.mode == 0u) {
    // Depths mode: write depths and count
    // Store depths as f32 bits in atomic u32 output
    for (var i = 0u; i < MAX_PEELS; i++) {
      atomicStore(&output[col_idx * MAX_PEELS + i], bitcast<u32>(depths[i]));
    }
    atomicStore(&counts_out[col_idx], n);
    return;
  }

  // Proportion/flag mode: compute interval overlaps
  let n_blocks = axis_valu(params.block_count, ba);
  let block_step = axis_val(params.block_size, ba);
  let block_origin = axis_val(params.origin, ba);

  // Build intervals based on surface type
  // For closed: [d0,d1], [d2,d3], ...
  // For open: [-inf, d0] (below first intersection)
  for (var bk = 0u; bk < n_blocks; bk++) {
    let lo = block_origin + f32(bk) * block_step;
    let hi = lo + block_step;
    var overlap: f32 = 0.0;

    if (params.surface_type == 1u) {
      // Open: inside is [-inf, first_intersection]
      if (n > 0u) {
        let abs_d = ray_start + depths[0];
        overlap = max(0.0, min(abs_d, hi) - lo);
        overlap = max(overlap, 0.0);
      }
    } else {
      // Closed: paired intervals
      for (var p = 0u; p + 1u < n; p += 2u) {
        let abs_a = ray_start + depths[p];
        let abs_b = ray_start + depths[p + 1u];
        overlap += max(0.0, min(abs_b, hi) - max(abs_a, lo));
      }
      // Odd count: last unpaired extends to +inf
      if (n % 2u == 1u) {
        let abs_a = ray_start + depths[n - 1u];
        overlap += max(0.0, hi - max(abs_a, lo));
      }
    }

    let proportion = overlap / block_step;
    let scaled = u32(proportion * f32(params.scale) + 0.5);

    // Map (col_u, col_v, bk) to block index i + j*nx + k*nx*ny
    var ijk = vec3<u32>(0u, 0u, 0u);
    if (ba == 0u) { ijk = vec3<u32>(bk, col_u, col_v); }
    else if (ba == 1u) { ijk = vec3<u32>(col_u, bk, col_v); }
    else { ijk = vec3<u32>(col_u, col_v, bk); }
    let block_idx = ijk.x + ijk.y * params.block_count.x + ijk.z * params.block_count.x * params.block_count.y;

    atomicAdd(&output[block_idx], scaled);
  }
}
`;
}

const FINALIZE_SHADER = /* wgsl */`
@group(0) @binding(0) var<storage, read> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> proportions: array<f32>;
@group(0) @binding(2) var<uniform> divisor: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&proportions)) { return; }
  proportions[idx] = f32(counters[idx]) / f32(divisor);
}
`;

async function createGPUEvaluator(device) {
  const finalizeModule = device.createShaderModule({ code: FINALIZE_SHADER });
  const finalizePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: finalizeModule, entryPoint: 'main' },
  });

  // Cache compiled pipelines by maxPeels
  const pipelineCache = new Map();

  function getPipeline(maxPeels) {
    if (pipelineCache.has(maxPeels)) return pipelineCache.get(maxPeels);
    const mod = device.createShaderModule({ code: generatePeelShader(maxPeels) });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'main' },
    });
    pipelineCache.set(maxPeels, pipeline);
    return pipeline;
  }

  return { device, getPipeline, finalizePipeline };
}

async function evaluateGPU(gpu, vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const { device, getPipeline, finalizePipeline } = gpu;
  const {
    mode = 'proportion', axis = 'z', surfaceType = 'closed',
    maxPeels = 16, resolution = [1, 1], onProgress,
  } = opts;

  const { origin: _origin, size, count } = blockModel;
  // origin is block (0,0,0) centroid — convert to corner for internal math
  const origin = [_origin[0] - size[0] / 2, _origin[1] - size[1] / 2, _origin[2] - size[2] / 2];
  const [nx, ny, nz] = count;
  const total = nx * ny * nz;

  const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const planeAxes = axisIdx === 0 ? [1, 2] : axisIdx === 1 ? [0, 2] : [0, 1];
  const [su, sv] = resolution;
  const gridU = count[planeAxes[0]], gridV = count[planeAxes[1]];
  const nColumns = gridU * gridV;
  const totalRays = gridU * su * gridV * sv;

  const SCALE = 10000;
  const pipeline = getPipeline(maxPeels);

  // Output size depends on mode
  const outputSize = mode === 'depths' ? maxPeels * nColumns * 4 : total * 4;
  const countsSize = (nColumns + 1) * 4; // +1 for overflow counter

  // Create buffers
  const vertBuf = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const triBuf = device.createBuffer({ size: triangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhBuf = device.createBuffer({ size: bvhNodes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhTriBuf = device.createBuffer({ size: triIndices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const countsBuf = device.createBuffer({ size: countsSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const countsReadBuf = device.createBuffer({ size: countsSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Params: 80 bytes
  const paramData = new ArrayBuffer(80);
  const paramF = new Float32Array(paramData);
  const paramU = new Uint32Array(paramData);
  paramF[0] = origin[0]; paramF[1] = origin[1]; paramF[2] = origin[2]; paramF[3] = 0;
  paramF[4] = size[0]; paramF[5] = size[1]; paramF[6] = size[2]; paramF[7] = 0;
  paramU[8] = nx; paramU[9] = ny; paramU[10] = nz; paramU[11] = axisIdx;
  paramU[12] = su; paramU[13] = sv; paramU[14] = gridU; paramU[15] = gridV;
  paramU[16] = mode === 'depths' ? 0 : mode === 'flag' ? 1 : 2;
  paramU[17] = surfaceType === 'open' ? 1 : 0;
  paramU[18] = SCALE;
  paramU[19] = 0;

  const paramBuf = device.createBuffer({ size: paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Upload
  device.queue.writeBuffer(vertBuf, 0, vertices);
  device.queue.writeBuffer(triBuf, 0, triangles);
  device.queue.writeBuffer(bvhBuf, 0, bvhNodes);
  device.queue.writeBuffer(bvhTriBuf, 0, triIndices);
  device.queue.writeBuffer(paramBuf, 0, paramData);

  // Clear output and counts
  {
    const enc = device.createCommandEncoder();
    enc.clearBuffer(outputBuf);
    enc.clearBuffer(countsBuf);
    device.queue.submit([enc.finish()]);
  }

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: vertBuf } },
      { binding: 1, resource: { buffer: triBuf } },
      { binding: 2, resource: { buffer: bvhBuf } },
      { binding: 3, resource: { buffer: bvhTriBuf } },
      { binding: 4, resource: { buffer: outputBuf } },
      { binding: 5, resource: { buffer: countsBuf } },
      { binding: 6, resource: { buffer: paramBuf } },
    ],
  });

  // Dispatch in batches for pacing
  const BATCH = 65536;
  const nDispatches = Math.ceil(totalRays / 64);
  // For simplicity, dispatch all at once (rays are independent)
  {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(nDispatches, 1, 1);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  if (onProgress) onProgress(0.5);

  if (mode !== 'depths' && mode !== 'flag') {
    // Finalize: counters → proportions
    const divisor = su * sv * SCALE;
    const divisorBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(divisorBuf, 0, new Uint32Array([divisor]));

    const propBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const finalBindGroup = device.createBindGroup({
      layout: finalizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: outputBuf } },
        { binding: 1, resource: { buffer: propBuf } },
        { binding: 2, resource: { buffer: divisorBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(finalizePipeline);
    pass.setBindGroup(0, finalBindGroup);
    pass.dispatchWorkgroups(Math.ceil(total / 64), 1, 1);
    pass.end();

    enc.copyBufferToBuffer(propBuf, 0, readBuf, 0, total * 4);
    enc.copyBufferToBuffer(countsBuf, 0, countsReadBuf, 0, countsSize);
    device.queue.submit([enc.finish()]);

    await device.queue.onSubmittedWorkDone();
    if (onProgress) onProgress(1.0);

    await readBuf.mapAsync(GPUMapMode.READ);
    const proportions = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    await countsReadBuf.mapAsync(GPUMapMode.READ);
    const countsData = new Uint32Array(countsReadBuf.getMappedRange().slice(0));
    countsReadBuf.unmap();
    const overflow = countsData[nColumns]; // overflow counter

    const flags = new Uint8Array(total);
    for (let i = 0; i < total; i++) flags[i] = proportions[i] > 0 ? 1 : 0;

    // Cleanup
    vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
    outputBuf.destroy(); countsBuf.destroy(); readBuf.destroy(); countsReadBuf.destroy();
    paramBuf.destroy(); propBuf.destroy(); divisorBuf.destroy();

    return { proportions, flags, overflow };
  }

  // Depths or flag mode: read output directly
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(outputBuf, 0, readBuf, 0, outputSize);
    enc.copyBufferToBuffer(countsBuf, 0, countsReadBuf, 0, countsSize);
    device.queue.submit([enc.finish()]);
  }

  await device.queue.onSubmittedWorkDone();
  if (onProgress) onProgress(1.0);

  await readBuf.mapAsync(GPUMapMode.READ);
  const outputData = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  await countsReadBuf.mapAsync(GPUMapMode.READ);
  const countsData = new Uint32Array(countsReadBuf.getMappedRange().slice(0));
  countsReadBuf.unmap();
  const overflow = countsData[nColumns];

  // Cleanup
  vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
  outputBuf.destroy(); countsBuf.destroy(); readBuf.destroy(); countsReadBuf.destroy();
  paramBuf.destroy();

  if (mode === 'depths') {
    // Reinterpret u32 bits as f32
    const depths = new Float32Array(outputData.buffer);
    const counts = new Uint32Array(nColumns);
    for (let i = 0; i < nColumns; i++) counts[i] = countsData[i];
    return { depths, counts, overflow };
  }

  // Flag mode: output contains scaled proportions, threshold at > 0
  const flags = new Uint8Array(total);
  for (let i = 0; i < total; i++) flags[i] = outputData[i] > 0 ? 1 : 0;
  return { flags, overflow };
}

export { generatePeelShader, createGPUEvaluator, evaluateGPU, FINALIZE_SHADER };
