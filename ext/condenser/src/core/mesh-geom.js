// @gcu/condenser — mesh GEOMETRY builders (core: no I/O). World-f64 vertices
// → frame-local Float32 chunks for the static indexed pipeline (gl-mesh.js),
// plus the heightfield triangulator (a regular grid IS a single-valued
// surface). The file readers (.msh/.obj/.ply) live in io/mesh-io.js.
// ── world f64 → one frame-local GPU-ready chunk ──
// Float32 positions are safe at frame-local magnitudes (the whole point of
// @gcu/frame); indices stay u32. Context meshes are ONE chunk — they draw
// whole on clear frames, no prefix, no budget.
export function buildMeshChunk({ vertices, triangles, frame }) {
  const o = frame ? frame.origin : [0, 0, 0];
  const n = (vertices.length / 3) | 0;
  const pos = new Float32Array(3 * n);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[3 * i + k] - o[k];
      pos[3 * i + k] = v;
      if (v < bb[k]) bb[k] = v;
      if (v > bb[k + 3]) bb[k + 3] = v;
    }
  }
  return {
    kind: 'mesh',
    pos,
    idx: triangles instanceof Uint32Array ? triangles : Uint32Array.from(triangles),
    count: (triangles.length / 3) | 0,                     // elements = triangles
    vertexCount: n,
    bboxLocal: Float64Array.from(bb),
  };
}

// A regular grid IS a single-valued heightfield — triangulate its lattice into a
// mesh chunk with per-vertex smooth normals (grid-gradient central differences)
// and a per-vertex value (the caller maps it to a colour via its own colormap).
// Quads touching a nodata corner are dropped → clean holes. Coords are frame-
// local. Strided to a display cap by the caller (bounded triangle count).
// flatZ (a world elevation) makes a FLAT horizontal sheet at that z instead of a
// heightfield — for a 2D data grid (grade/geochem) with no DEM; `values` stays the
// grid value so the caller still colours by it, and the normal is straight up.
export function buildHeightfieldMesh(grid, { stride = 1, frame = null, flatZ = null } = {}) {
  const { nx, ny, data, x0, y0, dx, dy, nodata } = grid;
  const o = (frame && frame.origin) || [0, 0, 0];
  const flat = flatZ != null, flatLocal = flat ? flatZ - o[2] : 0;
  const isBad = (v) => Number.isNaN(v) || (nodata != null && (nodata >= 1.7e38 ? v >= 1.7014e38 : v === nodata));
  const cols = Math.floor((nx - 1) / stride) + 1, rows = Math.floor((ny - 1) / stride) + 1;
  const vidx = new Int32Array(rows * cols).fill(-1);
  let nv = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!isBad(data[Math.min(ny - 1, r * stride) * nx + Math.min(nx - 1, c * stride)])) vidx[r * cols + c] = nv++;
  }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), values = new Float32Array(nv);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const zAt = (r, c) => { const v = data[Math.min(ny - 1, Math.max(0, r * stride)) * nx + Math.min(nx - 1, Math.max(0, c * stride))]; return isBad(v) ? NaN : v; };
  const sx = 2 * stride * dx, sy = 2 * stride * dy;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const vi = vidx[r * cols + c]; if (vi < 0) continue;
    const gr = Math.min(ny - 1, r * stride), gc = Math.min(nx - 1, c * stride), z = data[gr * nx + gc];
    const px = (x0 + gc * dx) - o[0], py = (y0 - gr * dy) - o[1], pz = flat ? flatLocal : z - o[2];
    pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz; values[vi] = z;
    if (px < bb[0]) bb[0] = px; if (py < bb[1]) bb[1] = py; if (pz < bb[2]) bb[2] = pz;
    if (px > bb[3]) bb[3] = px; if (py > bb[4]) bb[4] = py; if (pz > bb[5]) bb[5] = pz;
    if (flat) { normal[vi * 3] = 0; normal[vi * 3 + 1] = 0; normal[vi * 3 + 2] = 1; continue; }   // flat sheet → up
    // heightfield normal N = (-∂z/∂x, -∂z/∂y, 1); y decreases as row increases
    let zl = zAt(r, c - 1), zr = zAt(r, c + 1), zdn = zAt(r - 1, c), zup = zAt(r + 1, c);
    if (Number.isNaN(zl)) zl = z; if (Number.isNaN(zr)) zr = z; if (Number.isNaN(zdn)) zdn = z; if (Number.isNaN(zup)) zup = z;
    const nX = -(zr - zl) / sx, nY = -(zdn - zup) / sy, nZ = 1, nl = Math.hypot(nX, nY, nZ) || 1;
    normal[vi * 3] = nX / nl; normal[vi * 3 + 1] = nY / nl; normal[vi * 3 + 2] = nZ / nl;
  }
  const tris = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = vidx[r * cols + c], b = vidx[r * cols + c + 1], d = vidx[(r + 1) * cols + c], e = vidx[(r + 1) * cols + c + 1];
    if (a < 0 || b < 0 || d < 0 || e < 0) continue;        // drop quads touching nodata → clean holes
    tris.push(a, d, b, b, d, e);
  }
  return { kind: 'mesh', pos, idx: Uint32Array.from(tris), normal, values, count: (tris.length / 3) | 0, vertexCount: nv, bboxLocal: Float64Array.from(bb) };
}
