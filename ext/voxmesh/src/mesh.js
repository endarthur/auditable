// @gcu/voxmesh — greedy mesher: face culling + quad merging

import { chunkRange } from './chunk.js';

// face directions: +X, -X, +Y, -Y, +Z, -Z
const _DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const _NORMALS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

export function meshChunk(chunkBucket, chunks, gridDef) {
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

export function meshAll(buckets, chunks, gridDef) {
  const meshes = new Map();
  for (const [cid, b] of buckets) {
    meshes.set(cid, meshChunk(b, chunks, gridDef));
  }
  return meshes;
}

export function meshSection(gridDef, compactVar, binIds, plane) {
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
