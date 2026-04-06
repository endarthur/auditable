// @gcu/voxmesh — built from src/

// ── bin.js ──

// @gcu/voxmesh — binning: discretize continuous values into bin IDs

function binBreaks(values, opts) {
  const count = opts?.count || 10;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return new Float64Array(0);
  const breaks = new Float64Array(count - 1);
  for (let i = 0; i < count - 1; i++) breaks[i] = lo + (hi - lo) * (i + 1) / count;
  return breaks;
}

function binQuantiles(values, opts) {
  const count = opts?.count || 10;
  const sorted = [];
  for (let i = 0; i < values.length; i++) if (!isNaN(values[i])) sorted.push(values[i]);
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return new Float64Array(0);
  const breaks = new Float64Array(count - 1);
  for (let i = 0; i < count - 1; i++) {
    const p = (i + 1) / count;
    const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
    breaks[i] = sorted[idx];
  }
  return breaks;
}

function discretize(values, breaks) {
  const n = values.length;
  const out = new Uint8Array(n);
  const nb = breaks.length;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (isNaN(v)) { out[i] = 255; continue; }
    // binary search
    let lo = 0, hi = nb;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v > breaks[mid]) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo;
  }
  return out;
}

// ── chunk.js ──

// @gcu/voxmesh — chunking: spatial partitioning of grid into sub-ranges

function chunk(gridDef, opts) {
  const hint = opts?.hint || 32;
  const cx = Math.min(hint, gridDef.count[0]);
  const cy = Math.min(hint, gridDef.count[1]);
  const cz = Math.min(hint, gridDef.count[2]);
  const ncx = Math.ceil(gridDef.count[0] / cx);
  const ncy = Math.ceil(gridDef.count[1] / cy);
  const ncz = Math.ceil(gridDef.count[2] / cz);
  return {
    chunkDims: [cx, cy, cz],
    chunkCount: [ncx, ncy, ncz],
    nChunks: ncx * ncy * ncz,
    gridDef,
  };
}

function chunkId(chunks, i, j, k) {
  const ci = (i / chunks.chunkDims[0]) | 0;
  const cj = (j / chunks.chunkDims[1]) | 0;
  const ck = (k / chunks.chunkDims[2]) | 0;
  return ci + cj * chunks.chunkCount[0] + ck * chunks.chunkCount[0] * chunks.chunkCount[1];
}

function chunkRange(chunks, chunkIndex) {
  const ncx = chunks.chunkCount[0], ncxy = ncx * chunks.chunkCount[1];
  const ck = (chunkIndex / ncxy) | 0;
  const rem = chunkIndex - ck * ncxy;
  const ci = rem % ncx, cj = (rem / ncx) | 0;
  const g = chunks.gridDef;
  return {
    i0: ci * chunks.chunkDims[0],
    i1: Math.min((ci + 1) * chunks.chunkDims[0], g.count[0]),
    j0: cj * chunks.chunkDims[1],
    j1: Math.min((cj + 1) * chunks.chunkDims[1], g.count[1]),
    k0: ck * chunks.chunkDims[2],
    k1: Math.min((ck + 1) * chunks.chunkDims[2], g.count[2]),
  };
}

// ── bucket.js ──

// @gcu/voxmesh — bucketing: collect populated blocks into per-chunk buckets + ghost cells


function bucket(chunks, compactVar, binIds) {
  const buckets = new Map();
  const isCompact = compactVar.indices !== undefined;
  const values = isCompact ? compactVar.values : compactVar;
  const n = values.length;
  const nx = chunks.gridDef.count[0], nxy = nx * chunks.gridDef.count[1];

  for (let p = 0; p < n; p++) {
    if (binIds[p] === 255) continue; // NaN
    const gridIdx = isCompact ? compactVar.indices[p] : p;
    const kz = (gridIdx / nxy) | 0;
    const rem = gridIdx - kz * nxy;
    const i = rem % nx, j = (rem / nx) | 0;
    const cid = chunkId(chunks, i, j, kz);

    let b = buckets.get(cid);
    if (!b) {
      b = { ijkList: [], binIdList: [], valueList: [], min: Infinity, max: -Infinity, n: 0 };
      buckets.set(cid, b);
    }
    b.ijkList.push(i, j, kz);
    b.binIdList.push(binIds[p]);
    b.valueList.push(values[p]);
    if (values[p] < b.min) b.min = values[p];
    if (values[p] > b.max) b.max = values[p];
    b.n++;
  }

  // convert lists to typed arrays
  for (const [cid, b] of buckets) {
    b.ijk = new Int32Array(b.ijkList);
    b.binIds = new Uint8Array(b.binIdList);
    b.values = new Float64Array(b.valueList);
    delete b.ijkList; delete b.binIdList; delete b.valueList;
  }

  return buckets;
}

function addGhosts(chunks, buckets) {
  // build global lookup: "i,j,k" → binId for all populated blocks
  const globalLookup = new Map();
  for (const [_, b] of buckets) {
    for (let p = 0; p < b.n; p++) {
      const i = b.ijk[p * 3], j = b.ijk[p * 3 + 1], k = b.ijk[p * 3 + 2];
      globalLookup.set(i + j * 65536 + k * 65536 * 65536, b.binIds[p]);
    }
  }

  const nx = chunks.gridDef.count[0], ny = chunks.gridDef.count[1], nz = chunks.gridDef.count[2];

  for (const [cid, b] of buckets) {
    const range = chunkRange(chunks, cid);
    const ghostIjk = [], ghostBinIds = [];

    // 1-cell shell around the chunk range
    for (let k = range.k0 - 1; k <= range.k1; k++) {
      for (let j = range.j0 - 1; j <= range.j1; j++) {
        for (let i = range.i0 - 1; i <= range.i1; i++) {
          // skip blocks inside the chunk range
          if (i >= range.i0 && i < range.i1 && j >= range.j0 && j < range.j1 && k >= range.k0 && k < range.k1) continue;
          // skip out of grid bounds
          if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
          const key = i + j * 65536 + k * 65536 * 65536;
          const binId = globalLookup.get(key);
          if (binId !== undefined) {
            ghostIjk.push(i, j, k);
            ghostBinIds.push(binId);
          }
        }
      }
    }

    b.ghostIjk = new Int32Array(ghostIjk);
    b.ghostBinIds = new Uint8Array(ghostBinIds);
  }
}

// ── mesh.js ──

// @gcu/voxmesh — greedy mesher: face culling + quad merging


// face directions: +X, -X, +Y, -Y, +Z, -Z
const _DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const _NORMALS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function meshChunk(chunkBucket, chunks, gridDef) {
  // build lookup: (i,j,k) → binId for this chunk + ghosts
  const lookup = new Map();
  const b = chunkBucket;
  for (let p = 0; p < b.n; p++) {
    const i = b.ijk[p * 3], j = b.ijk[p * 3 + 1], k = b.ijk[p * 3 + 2];
    lookup.set(_key(i, j, k), b.binIds[p]);
  }
  if (b.ghostIjk) {
    for (let p = 0; p < b.ghostBinIds.length; p++) {
      const i = b.ghostIjk[p * 3], j = b.ghostIjk[p * 3 + 1], k = b.ghostIjk[p * 3 + 2];
      lookup.set(_key(i, j, k), b.ghostBinIds[p]);
    }
  }

  // pass 1: face culling — emit face only if neighbor is absent (shell extraction)
  // bin ID determines face color, NOT face existence
  const faces = [[], [], [], [], [], []]; // per direction
  for (let p = 0; p < b.n; p++) {
    const bi = b.ijk[p * 3], bj = b.ijk[p * 3 + 1], bk = b.ijk[p * 3 + 2];
    const binId = b.binIds[p];
    for (let d = 0; d < 6; d++) {
      const ni = bi + _DIRS[d][0], nj = bj + _DIRS[d][1], nk = bk + _DIRS[d][2];
      const neighborBin = lookup.get(_key(ni, nj, nk));
      if (neighborBin === undefined) {
        faces[d].push(bi, bj, bk, binId);
      }
    }
  }

  // pass 2: greedy meshing per direction
  const positions = [], normals = [], indices = [], binIds = [];
  let vertCount = 0;

  const rot = _rotMatrix(gridDef);

  for (let d = 0; d < 6; d++) {
    const dirFaces = faces[d];
    if (dirFaces.length === 0) continue;

    const nf = dirFaces.length / 4;
    // determine the 2D plane axes for this direction
    // dir 0,1 (+X,-X): plane is (j, k), normal X
    // dir 2,3 (+Y,-Y): plane is (i, k), normal Y
    // dir 4,5 (+Z,-Z): plane is (i, j), normal Z
    const quads = _greedyMerge(dirFaces, d, gridDef);

    const n = _NORMALS[d];
    let nx = n[0], ny = n[1], nz = n[2];
    if (rot) {
      const rn = _applyRot(rot, nx, ny, nz);
      nx = rn[0]; ny = rn[1]; nz = rn[2];
    }

    for (const q of quads) {
      // q = { i0, j0, k0, w, h, binId, dir }
      // emit 4 vertices + 2 triangles
      const verts = _quadVertices(q, d, gridDef, rot);
      const vi = vertCount;
      for (let v = 0; v < 4; v++) {
        positions.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
        normals.push(nx, ny, nz);
      }
      indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      binIds.push(q.binId, q.binId); // per triangle
      vertCount += 4;
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    binIds: new Uint8Array(binIds),
  };
}

function _key(i, j, k) {
  return i + j * 65536 + k * 4294967296;
}

function _greedyMerge(dirFaces, dir, gridDef) {
  const nf = dirFaces.length / 4;
  if (nf === 0) return [];

  // map faces onto a 2D grid for greedy merging
  // axis mapping: which ijk components form the 2D plane
  let uAxis, vAxis, wAxis;
  if (dir === 0 || dir === 1) { uAxis = 1; vAxis = 2; wAxis = 0; } // Y, Z plane
  else if (dir === 2 || dir === 3) { uAxis = 0; vAxis = 2; wAxis = 1; } // X, Z plane
  else { uAxis = 0; vAxis = 1; wAxis = 2; } // X, Y plane

  // group by (wAxis value, binId) → 2D grid
  const groups = new Map();
  for (let f = 0; f < nf; f++) {
    const i = dirFaces[f * 4], j = dirFaces[f * 4 + 1], k = dirFaces[f * 4 + 2];
    const binId = dirFaces[f * 4 + 3];
    const ijk = [i, j, k];
    const w = ijk[wAxis];
    const key = w * 256 + binId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ijk[uAxis], ijk[vAxis], i, j, k);
  }

  const quads = [];

  for (const [key, facesInPlane] of groups) {
    const binId = key % 256;
    const nFaces = facesInPlane.length / 5;

    // build 2D occupancy grid
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let f = 0; f < nFaces; f++) {
      const u = facesInPlane[f * 5], v = facesInPlane[f * 5 + 1];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const uw = uMax - uMin + 1, vw = vMax - vMin + 1;
    const grid = new Uint8Array(uw * vw);
    const ijkGrid = new Int32Array(uw * vw * 3);

    for (let f = 0; f < nFaces; f++) {
      const u = facesInPlane[f * 5] - uMin;
      const v = facesInPlane[f * 5 + 1] - vMin;
      const idx = u + v * uw;
      grid[idx] = 1;
      ijkGrid[idx * 3] = facesInPlane[f * 5 + 2];
      ijkGrid[idx * 3 + 1] = facesInPlane[f * 5 + 3];
      ijkGrid[idx * 3 + 2] = facesInPlane[f * 5 + 4];
    }

    // greedy: sweep row by row, extend right then down
    for (let v = 0; v < vw; v++) {
      for (let u = 0; u < uw; u++) {
        if (!grid[u + v * uw]) continue;
        // find max width
        let w = 1;
        while (u + w < uw && grid[u + w + v * uw]) w++;
        // find max height
        let h = 1;
        outer: while (v + h < vw) {
          for (let du = 0; du < w; du++) {
            if (!grid[u + du + (v + h) * uw]) break outer;
          }
          h++;
        }
        // clear merged cells
        for (let dv = 0; dv < h; dv++) {
          for (let du = 0; du < w; du++) {
            grid[u + du + (v + dv) * uw] = 0;
          }
        }

        // emit quad using ijk of the origin face
        const baseIdx = (u + v * uw) * 3;
        quads.push({
          i0: ijkGrid[baseIdx], j0: ijkGrid[baseIdx + 1], k0: ijkGrid[baseIdx + 2],
          u: u + uMin, v: v + vMin, w, h,
          uAxis, vAxis, dir, binId,
        });
      }
    }
  }

  return quads;
}

function _quadVertices(q, dir, gridDef, rot) {
  const s = gridDef.size;
  const o = gridDef.origin;
  // the 4 corners of the quad in ijk space, then transform to world
  const verts = new Float32Array(12);

  // face offset: positive dir → face at +0.5 block, negative → at -0.5
  const sign = (dir % 2 === 0) ? 0.5 : -0.5;

  for (let c = 0; c < 4; c++) {
    // corner offsets in uv space: (0,0), (w,0), (w,h), (0,h)
    const du = (c === 1 || c === 2) ? q.w : 0;
    const dv = (c === 2 || c === 3) ? q.h : 0;

    let i, j, k;
    if (q.uAxis === 0 && q.vAxis === 1) { // XY plane (dir 4,5: ±Z)
      i = q.u + du; j = q.v + dv; k = q.k0;
      k += sign > 0 ? 1 : 0; // offset face position
      // vertex at corner of block
      let x = (i - 0.5) * s[0], y = (j - 0.5) * s[1], z = (k - 0.5) * s[2];
      if (rot) { const r = _applyRot(rot, x, y, z); x = r[0]; y = r[1]; z = r[2]; }
      verts[c * 3] = o[0] + x; verts[c * 3 + 1] = o[1] + y; verts[c * 3 + 2] = o[2] + z;
    } else if (q.uAxis === 1 && q.vAxis === 2) { // YZ plane (dir 0,1: ±X)
      j = q.u + du; k = q.v + dv; i = q.i0;
      i += sign > 0 ? 1 : 0;
      let x = (i - 0.5) * s[0], y = (j - 0.5) * s[1], z = (k - 0.5) * s[2];
      if (rot) { const r = _applyRot(rot, x, y, z); x = r[0]; y = r[1]; z = r[2]; }
      verts[c * 3] = o[0] + x; verts[c * 3 + 1] = o[1] + y; verts[c * 3 + 2] = o[2] + z;
    } else { // XZ plane (dir 2,3: ±Y)
      i = q.u + du; k = q.v + dv; j = q.j0;
      j += sign > 0 ? 1 : 0;
      let x = (i - 0.5) * s[0], y = (j - 0.5) * s[1], z = (k - 0.5) * s[2];
      if (rot) { const r = _applyRot(rot, x, y, z); x = r[0]; y = r[1]; z = r[2]; }
      verts[c * 3] = o[0] + x; verts[c * 3 + 1] = o[1] + y; verts[c * 3 + 2] = o[2] + z;
    }
  }
  return verts;
}

// rotation helpers (duplicated from grid to keep voxmesh self-contained if needed)
function _rotMatrix(gridDef) {
  const rot = gridDef.rotation;
  if (!rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0)) return null;
  const dd = rot[0] * Math.PI / 180, dip = rot[1] * Math.PI / 180, rake = rot[2] * Math.PI / 180;
  const cd = Math.cos(dd), sd = Math.sin(dd), cp = Math.cos(dip), sp = Math.sin(dip), cr = Math.cos(rake), sr = Math.sin(rake);
  return [cd*cr-sd*sp*sr, -sd*cp, cd*sr+sd*sp*cr, sd*cr+cd*sp*sr, cd*cp, sd*sr-cd*sp*cr, -cp*sr, sp, cp*cr];
}

function _applyRot(m, x, y, z) {
  return [m[0]*x+m[1]*y+m[2]*z, m[3]*x+m[4]*y+m[5]*z, m[6]*x+m[7]*y+m[8]*z];
}

function meshAll(buckets, chunks, gridDef) {
  const meshes = new Map();
  for (const [cid, b] of buckets) {
    meshes.set(cid, meshChunk(b, chunks, gridDef));
  }
  return meshes;
}

function meshSection(gridDef, compactVar, binIds, plane) {
  const nx = gridDef.count[0], ny = gridDef.count[1], nz = gridDef.count[2], nxy = nx * ny;
  const n = plane.normal;
  const mag = Math.sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);
  const nn = [n[0]/mag, n[1]/mag, n[2]/mag];
  const halfDist = 0.5 * (Math.abs(nn[0])*gridDef.size[0] + Math.abs(nn[1])*gridDef.size[1] + Math.abs(nn[2])*gridDef.size[2]);
  const d = nn[0]*plane.point[0] + nn[1]*plane.point[1] + nn[2]*plane.point[2];

  const isCompact = compactVar.indices !== undefined;
  const rot = _rotMatrix(gridDef);

  // build lookup for compact vars
  let valueLookup, binLookup;
  if (isCompact) {
    valueLookup = new Map();
    binLookup = new Map();
    for (let p = 0; p < compactVar.indices.length; p++) {
      valueLookup.set(compactVar.indices[p], compactVar.values[p]);
      binLookup.set(compactVar.indices[p], binIds[p]);
    }
  }

  // for each block near the plane, compute plane-cuboid intersection polygon
  const positions = [], normals = [], indices = [], binIdOut = [];
  let vertCount = 0;
  const s = gridDef.size, o = gridDef.origin;
  const hx = s[0]/2, hy = s[1]/2, hz = s[2]/2;

  // 12 edges of a cuboid: pairs of corner indices
  // corners: 0(-,-,-) 1(+,-,-) 2(+,+,-) 3(-,+,-) 4(-,-,+) 5(+,-,+) 6(+,+,+) 7(-,+,+)
  const _edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const _cornerSigns = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];

  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let dx = i * s[0], dy = j * s[1], dz = kz * s[2];
        if (rot) { const r = _applyRot(rot, dx, dy, dz); dx = r[0]; dy = r[1]; dz = r[2]; }
        const cx = o[0] + dx, cy = o[1] + dy, cz = o[2] + dz;

        const idx = i + j * nx + kz * nxy;
        let binId;
        if (isCompact) {
          binId = binLookup.get(idx);
          if (binId === undefined) continue;
        } else {
          binId = binIds[idx];
          if (binId === 255) continue;
        }

        // classify 8 corners against the plane
        const cornerDists = [];
        const cornerPos = [];
        for (let c = 0; c < 8; c++) {
          const px = cx + _cornerSigns[c][0] * hx;
          const py = cy + _cornerSigns[c][1] * hy;
          const pz = cz + _cornerSigns[c][2] * hz;
          cornerPos.push(px, py, pz);
          cornerDists.push(nn[0]*px + nn[1]*py + nn[2]*pz - d);
        }

        // find edge intersections (where sign changes)
        const polyPts = [];
        for (const [a, b] of _edges) {
          if ((cornerDists[a] > 0) !== (cornerDists[b] > 0)) {
            const t = cornerDists[a] / (cornerDists[a] - cornerDists[b]);
            polyPts.push(
              cornerPos[a*3]   + t * (cornerPos[b*3]   - cornerPos[a*3]),
              cornerPos[a*3+1] + t * (cornerPos[b*3+1] - cornerPos[a*3+1]),
              cornerPos[a*3+2] + t * (cornerPos[b*3+2] - cornerPos[a*3+2]),
            );
          }
        }

        const nPts = polyPts.length / 3;
        if (nPts < 3) continue;

        // order polygon vertices by angle around centroid on the plane
        let pcx = 0, pcy = 0, pcz = 0;
        for (let p = 0; p < nPts; p++) { pcx += polyPts[p*3]; pcy += polyPts[p*3+1]; pcz += polyPts[p*3+2]; }
        pcx /= nPts; pcy /= nPts; pcz /= nPts;

        // tangent basis for angle sorting
        let t1x = polyPts[0] - pcx, t1y = polyPts[1] - pcy, t1z = polyPts[2] - pcz;
        const t1len = Math.sqrt(t1x*t1x + t1y*t1y + t1z*t1z);
        if (t1len < 1e-10) continue;
        t1x /= t1len; t1y /= t1len; t1z /= t1len;
        let t2x = nn[1]*t1z - nn[2]*t1y, t2y = nn[2]*t1x - nn[0]*t1z, t2z = nn[0]*t1y - nn[1]*t1x;

        const angles = [];
        for (let p = 0; p < nPts; p++) {
          const dx = polyPts[p*3] - pcx, dy = polyPts[p*3+1] - pcy, dz = polyPts[p*3+2] - pcz;
          angles.push(Math.atan2(dx*t2x+dy*t2y+dz*t2z, dx*t1x+dy*t1y+dz*t1z));
        }
        const order = Array.from({length: nPts}, (_, k) => k).sort((a, b) => angles[a] - angles[b]);

        // emit fan triangulation
        const vi = vertCount;
        for (let p = 0; p < nPts; p++) {
          const oi = order[p];
          positions.push(polyPts[oi*3], polyPts[oi*3+1], polyPts[oi*3+2]);
          normals.push(nn[0], nn[1], nn[2]);
        }
        for (let p = 1; p < nPts - 1; p++) {
          indices.push(vi, vi + p, vi + p + 1);
          binIdOut.push(binId);
        }
        vertCount += nPts;
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    binIds: new Uint8Array(binIdOut),
  };
}

// ── convenience.js ──

// @gcu/voxmesh — convenience wrappers and incremental updates





function prepare(gridDef, compactVar, opts) {
  const hint = opts?.hint || 32;

  // determine bin breaks
  const values = compactVar.values || compactVar;
  let breaks;
  if (opts?.breaks) {
    breaks = opts.breaks;
  } else if (opts?.count) {
    breaks = binBreaks(values, { count: opts.count });
  } else if (opts?.quantiles) {
    breaks = binQuantiles(values, { count: opts.quantiles });
  } else {
    breaks = null; // categorical — values are bin IDs directly
  }

  let binIds;
  if (breaks) {
    binIds = discretize(values, breaks);
  } else {
    // categorical: cast to Uint8
    binIds = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      binIds[i] = isNaN(values[i]) ? 255 : values[i];
    }
  }

  const chunks = chunk(gridDef, { hint });
  const buckets = bucket(chunks, compactVar, binIds);
  addGhosts(chunks, buckets);
  const meshes = meshAll(buckets, chunks, gridDef);

  return { meshes, chunks, buckets, binIds, breaks: breaks || new Float64Array(0), _compactVar: compactVar };
}

function diffBins(buckets, oldBinIds, newBinIds) {
  // find chunks where at least one block changed bin ID
  // requires mapping compact indices to chunks — use bucket's stored ijk
  const affected = new Set();
  // simplified: for each bucket, check if its min/max straddles any changed region
  // full implementation would track compact index → bucket mapping
  // for now, compare old vs new bin IDs directly
  if (oldBinIds.length !== newBinIds.length) {
    for (const cid of buckets.keys()) affected.add(cid);
    return affected;
  }
  // build set of changed compact indices
  const changed = new Set();
  for (let i = 0; i < oldBinIds.length; i++) {
    if (oldBinIds[i] !== newBinIds[i]) changed.add(i);
  }
  if (changed.size === 0) return affected;
  // mark all chunks as affected if any change (conservative but correct)
  for (const cid of buckets.keys()) affected.add(cid);
  return affected;
}

function rebin(prepared, opts) {
  const compactVar = prepared._compactVar;
  const values = compactVar.values || compactVar;

  let breaks;
  if (opts?.breaks) breaks = opts.breaks;
  else if (opts?.count) breaks = binBreaks(values, { count: opts.count });
  else if (opts?.quantiles) breaks = binQuantiles(values, { count: opts.quantiles });
  else breaks = prepared.breaks;

  const oldBinIds = prepared.binIds;
  const newBinIds = discretize(values, breaks);

  // re-bucket with new bin IDs and re-mesh
  const buckets = bucket(prepared.chunks, compactVar, newBinIds);
  addGhosts(prepared.chunks, buckets);
  const meshes = meshAll(buckets, prepared.chunks, prepared.chunks.gridDef);

  // update prepared state
  prepared.meshes = meshes;
  prepared.buckets = buckets;
  prepared.binIds = newBinIds;
  prepared.breaks = breaks;

  return { affected: meshes, meshes, binIds: newBinIds, breaks };
}

// ── exports ──
export {
  // binning
  binBreaks, binQuantiles, discretize,
  // chunking
  chunk, chunkId, chunkRange,
  // bucketing
  bucket, addGhosts,
  // meshing
  meshChunk, meshAll, meshSection,
  // convenience
  prepare, diffBins, rebin,
};
