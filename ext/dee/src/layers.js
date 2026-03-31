// @gcu/dee — layer implementations: block model, points, drillholes, surface, polylines, section

// ── block model layer ──

export function addBlockModelLayer(dee, name, meshes, opts = {}) {
  const THREE = dee.THREE;
  const cmap = opts.colorMap;
  const group = new THREE.Group();
  group.name = name;
  const chunkMeshes = new Map();

  function _buildChunk(chunkIdx, meshData) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(meshData.positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

    // vertex colors from bin IDs via color map
    const nVerts = meshData.positions.length / 3;
    const colors = new Float32Array(nVerts * 3);
    const nTris = meshData.binIds.length;
    for (let t = 0; t < nTris; t++) {
      const [r, g, b] = cmap ? cmap.mapBin(meshData.binIds[t]) : [0.5, 0.5, 0.5];
      // each triangle has 3 vertices; each quad = 2 tris sharing 4 verts
      // binIds is per-triangle, vertices are per-quad (4 verts per 2 tris)
      // triangles are: [v0,v1,v2, v0,v2,v3] for each quad
      // so tri 0,1 share verts 0-3, tri 2,3 share verts 4-7, etc.
      const quadIdx = (t >> 1); // which quad
      const baseVert = quadIdx * 4;
      for (let v = 0; v < 4; v++) {
        const vi = baseVert + v;
        if (vi < nVerts) { colors[vi * 3] = r; colors[vi * 3 + 1] = g; colors[vi * 3 + 2] = b; }
      }
    }
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
      clippingPlanes: opts.clippingPlanes || dee.clippingPlanes,
      clipShadows: true,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `${name}_chunk_${chunkIdx}`;

    group.add(mesh);
    chunkMeshes.set(chunkIdx, mesh);
  }

  for (const [chunkIdx, meshData] of meshes) {
    _buildChunk(chunkIdx, meshData);
  }

  // recenter: subtract origin from positions
  const ox = dee.origin[0], oy = dee.origin[1], oz = dee.origin[2];
  group.position.set(-ox, -oy, -oz);

  dee.scene.add(group);
  dee.markDirty();

  const layer = {
    name, group, type: 'blockmodel',
    gridDef: opts.gridDef || null,
    compactVar: opts.compactVar || null,
    get visible() { return group.visible; },
    set visible(v) { group.visible = v; dee.markDirty(); },
    get opacity() { return chunkMeshes.size > 0 ? chunkMeshes.values().next().value.material.opacity : 1; },
    set opacity(v) {
      for (const [_, m] of chunkMeshes) {
        m.material.opacity = v;
        m.material.transparent = v < 1;
      }
      dee.markDirty();
    },
    updateChunks(affectedMeshes) {
      for (const [chunkIdx, meshData] of affectedMeshes) {
        const old = chunkMeshes.get(chunkIdx);
        if (old) { group.remove(old); old.geometry.dispose(); old.material.dispose(); }
        _buildChunk(chunkIdx, meshData);
      }
      dee.markDirty();
    },
    replaceAll(newMeshes) {
      for (const [_, m] of chunkMeshes) {
        group.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
      chunkMeshes.clear();
      for (const [chunkIdx, meshData] of newMeshes) _buildChunk(chunkIdx, meshData);
      dee.markDirty();
    },
    _dispose() {
      for (const [_, m] of chunkMeshes) { m.geometry.dispose(); m.material.dispose(); }
      dee.scene.remove(group);
    },
  };

  dee._layers.set(name, layer);
  return layer;
}

// ── section layer ──

export function addSectionLayer(dee, name, sectionMesh, opts = {}) {
  const THREE = dee.THREE;
  const cmap = opts.colorMap;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(sectionMesh.positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(sectionMesh.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(sectionMesh.indices, 1));

  const nVerts = sectionMesh.positions.length / 3;
  const colors = new Float32Array(nVerts * 3);
  for (let t = 0; t < sectionMesh.binIds.length; t++) {
    const [r, g, b] = cmap ? cmap.mapBin(sectionMesh.binIds[t]) : [0.5, 0.5, 0.5];
    const quadIdx = (t >> 1);
    const baseVert = quadIdx * 4;
    for (let v = 0; v < 4; v++) {
      const vi = baseVert + v;
      if (vi < nVerts) { colors[vi * 3] = r; colors[vi * 3 + 1] = g; colors[vi * 3 + 2] = b; }
    }
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const secGroup = new THREE.Group();
  secGroup.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = name;
  secGroup.add(mesh);

  dee.scene.add(secGroup);
  dee.markDirty();

  const layer = {
    name, mesh, type: 'section',
    get visible() { return secGroup.visible; },
    set visible(v) { secGroup.visible = v; dee.markDirty(); },
    updateMesh(newMesh) {
      geom.setAttribute('position', new THREE.Float32BufferAttribute(newMesh.positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(newMesh.normals, 3));
      geom.setIndex(new THREE.BufferAttribute(newMesh.indices, 1));
      geom.attributes.position.needsUpdate = true;
      dee.markDirty();
    },
    _dispose() { geom.dispose(); mat.dispose(); dee.scene.remove(secGroup); },
  };
  dee._layers.set(name, layer);
  return layer;
}

// ── point cloud layer ──

export function addPointsLayer(dee, name, opts = {}) {
  const THREE = dee.THREE;
  const n = opts.positions.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = opts.positions[i * 3];
    pos[i * 3 + 1] = opts.positions[i * 3 + 1];
    pos[i * 3 + 2] = opts.positions[i * 3 + 2];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));

  if (opts.values && opts.colorMap) {
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = opts.colorMap.map(opts.values[i]);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }

  const mat = new THREE.PointsMaterial({
    size: opts.size || 4,
    vertexColors: !!(opts.values && opts.colorMap),
    color: opts.color || 0xffffff,
    sizeAttenuation: false,
    clippingPlanes: opts.clippingPlanes || dee.clippingPlanes,
  });

  const pointGroup = new THREE.Group();
  pointGroup.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);
  const points = new THREE.Points(geom, mat);
  points.name = name;
  pointGroup.add(points);
  dee.scene.add(pointGroup);
  dee.markDirty();

  const layer = {
    name, points, type: 'points',
    get visible() { return points.visible; },
    set visible(v) { points.visible = v; dee.markDirty(); },
    _dispose() { geom.dispose(); mat.dispose(); dee.scene.remove(pointGroup); },
  };
  dee._layers.set(name, layer);
  return layer;
}

// ── drillhole layer ──

export function addDrillholeLayer(dee, name, opts = {}) {
  const THREE = dee.THREE;
  const group = new THREE.Group();
  group.name = name;
  const radius = opts.radius || 1.5;
  const segments = opts.segments || 8;
  const method = opts.method || 'minimumCurvature';
  const cmap = opts.colorMap;


  for (const hole of (opts.holes || [])) {
    const path = desurvey(hole.collar, hole.surveys, { method });
    if (!hole.intervals || hole.intervals.length === 0) continue;

    const depths = [];
    for (const iv of hole.intervals) { depths.push(iv.from, iv.to); }
    const pts = interpolatePath(path, hole.surveys, new Float64Array(depths));

    const positions = [], normals = [], colors = [], indices = [];
    let vOff = 0;

    for (let iv = 0; iv < hole.intervals.length; iv++) {
      const interval = hole.intervals[iv];
      const p0 = [pts[iv * 2 * 3], pts[iv * 2 * 3 + 1], pts[iv * 2 * 3 + 2]];
      const p1 = [pts[(iv * 2 + 1) * 3], pts[(iv * 2 + 1) * 3 + 1], pts[(iv * 2 + 1) * 3 + 2]];

      const dir = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
      if (len < 1e-6) continue;
      dir[0] /= len; dir[1] /= len; dir[2] /= len;

      let perp = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = _cross(dir, perp); _normalize(u);
      const v = _cross(dir, u); _normalize(v);

      const [r, g, b] = cmap && interval.value !== undefined ? cmap.map(interval.value) : [0.5, 0.5, 0.5];

      for (let ring = 0; ring < 2; ring++) {
        const p = ring === 0 ? p0 : p1;
        for (let s = 0; s < segments; s++) {
          const angle = (s / segments) * Math.PI * 2;
          const cos = Math.cos(angle) * radius, sin = Math.sin(angle) * radius;
          positions.push(p[0] + u[0] * cos + v[0] * sin, p[1] + u[1] * cos + v[1] * sin, p[2] + u[2] * cos + v[2] * sin);
          normals.push(u[0] * Math.cos(angle) + v[0] * Math.sin(angle), u[1] * Math.cos(angle) + v[1] * Math.sin(angle), u[2] * Math.cos(angle) + v[2] * Math.sin(angle));
          colors.push(r, g, b);
}
      }

      for (let s = 0; s < segments; s++) {
        const a = vOff + s, b2 = vOff + (s + 1) % segments;
        const c2 = vOff + segments + s, d = vOff + segments + (s + 1) % segments;
        indices.push(a, b2, c2, b2, d, c2); // CCW from outside
      }
      vOff += segments * 2;
    }

    if (positions.length === 0) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);

    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `${name}_${hole.id || 'hole'}`;
    // store metadata for raycaster interval resolution
    mesh._holeData = { id: hole.id, intervals: hole.intervals, segments };
    group.add(mesh);
  }

  // offset group same as block model — world coords, group transform subtracts origin
  group.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);
  dee.scene.add(group);

  dee.markDirty();

  const layer = {
    name, group, type: 'drillholes',
    get visible() { return group.visible; },
    set visible(v) { group.visible = v; dee.markDirty(); },
    _dispose() {
      group.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); });
      dee.scene.remove(group);
    },
  };
  dee._layers.set(name, layer);
  return layer;
}

function _cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _normalize(v) { const l = Math.sqrt(v[0]**2+v[1]**2+v[2]**2); v[0]/=l; v[1]/=l; v[2]/=l; }

// ── desurvey ──

export function desurvey(collar, surveys, opts) {
  const method = opts?.method || 'minimumCurvature';
  if (!surveys || surveys.length === 0) return new Float64Array([collar[0], collar[1], collar[2]]);

  const n = surveys.length;
  const path = new Float64Array(n * 3);
  path[0] = collar[0]; path[1] = collar[1]; path[2] = collar[2];

  if (method === 'tangential') {
    for (let i = 1; i < n; i++) {
      const dDepth = surveys[i].depth - surveys[i - 1].depth;
      const az = surveys[i].azimuth * Math.PI / 180;
      const dip = surveys[i].dip * Math.PI / 180;
      const cosDip = Math.cos(dip);
      path[i * 3] = path[(i - 1) * 3] + dDepth * Math.sin(az) * cosDip;
      path[i * 3 + 1] = path[(i - 1) * 3 + 1] + dDepth * Math.cos(az) * cosDip;
      path[i * 3 + 2] = path[(i - 1) * 3 + 2] + dDepth * Math.sin(dip);
    }
  } else {
    // minimum curvature
    for (let i = 1; i < n; i++) {
      const dDepth = surveys[i].depth - surveys[i - 1].depth;
      const az1 = surveys[i - 1].azimuth * Math.PI / 180, dip1 = surveys[i - 1].dip * Math.PI / 180;
      const az2 = surveys[i].azimuth * Math.PI / 180, dip2 = surveys[i].dip * Math.PI / 180;

      const d1 = [Math.sin(az1) * Math.cos(dip1), Math.cos(az1) * Math.cos(dip1), Math.sin(dip1)];
      const d2 = [Math.sin(az2) * Math.cos(dip2), Math.cos(az2) * Math.cos(dip2), Math.sin(dip2)];

      const dogleg = Math.acos(Math.max(-1, Math.min(1, d1[0]*d2[0] + d1[1]*d2[1] + d1[2]*d2[2])));
      const rf = dogleg > 1e-6 ? (2 / dogleg) * Math.tan(dogleg / 2) : 1;

      path[i * 3] = path[(i-1)*3] + 0.5 * dDepth * (d1[0] + d2[0]) * rf;
      path[i * 3 + 1] = path[(i-1)*3+1] + 0.5 * dDepth * (d1[1] + d2[1]) * rf;
      path[i * 3 + 2] = path[(i-1)*3+2] + 0.5 * dDepth * (d1[2] + d2[2]) * rf;
    }
  }

  return path;
}

export function interpolatePath(path, surveys, depths) {
  const n = depths.length;
  const out = new Float64Array(n * 3);
  const nSurveys = surveys.length;

  if (nSurveys <= 1) {
    // single survey — straight line along survey direction
    const az = (surveys[0]?.azimuth || 0) * Math.PI / 180;
    const dip = (surveys[0]?.dip || -90) * Math.PI / 180;
    const dx = Math.sin(az) * Math.cos(dip);
    const dy = Math.cos(az) * Math.cos(dip);
    const dz = Math.sin(dip);
    for (let i = 0; i < n; i++) {
      const d = depths[i];
      out[i * 3] = path[0] + d * dx;
      out[i * 3 + 1] = path[1] + d * dy;
      out[i * 3 + 2] = path[2] + d * dz;
    }
    return out;
  }

  for (let i = 0; i < n; i++) {
    const d = depths[i];
    let seg = 0;
    for (let s = 1; s < nSurveys; s++) {
      if (surveys[s].depth >= d) { seg = s - 1; break; }
      seg = s - 1;
    }
    seg = Math.max(0, Math.min(seg, nSurveys - 2));

    const d0 = surveys[seg].depth, d1 = surveys[seg + 1].depth;
    const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    out[i * 3] = path[seg * 3] + t * (path[(seg + 1) * 3] - path[seg * 3]);
    out[i * 3 + 1] = path[seg * 3 + 1] + t * (path[(seg + 1) * 3 + 1] - path[seg * 3 + 1]);
    out[i * 3 + 2] = path[seg * 3 + 2] + t * (path[(seg + 1) * 3 + 2] - path[seg * 3 + 2]);
  }

  return out;
}

// ── surface mesh layer ──

export function addSurfaceLayer(dee, name, opts = {}) {
  const THREE = dee.THREE;
  const n = opts.positions.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = opts.positions[i * 3];
    pos[i * 3 + 1] = opts.positions[i * 3 + 1];
    pos[i * 3 + 2] = opts.positions[i * 3 + 2];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(opts.indices), 1));
  if (opts.normals) geom.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(opts.normals), 3));
  else geom.computeVertexNormals();

  const mat = new THREE.MeshPhongMaterial({
    color: opts.color || 0x6699cc,
    opacity: opts.opacity ?? 1,
    transparent: (opts.opacity ?? 1) < 1,
    side: opts.doubleSided !== false ? THREE.DoubleSide : THREE.FrontSide,
    wireframe: !!opts.wireframe,
    clippingPlanes: opts.clippingPlanes || dee.clippingPlanes,
  });

  const surfGroup = new THREE.Group();
  surfGroup.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = name;
  if (opts.pickable === false) mesh._noPick = true;
  surfGroup.add(mesh);
  dee.scene.add(surfGroup);
  dee.markDirty();

  const layer = {
    name, mesh, type: 'surface',
    get visible() { return surfGroup.visible; },
    set visible(v) { surfGroup.visible = v; dee.markDirty(); },
    get opacity() { return mat.opacity; },
    set opacity(v) { mat.opacity = v; mat.transparent = v < 1; dee.markDirty(); },
    _dispose() { geom.dispose(); mat.dispose(); dee.scene.remove(surfGroup); },
  };
  dee._layers.set(name, layer);
  return layer;
}

// ── polylines layer ──

export function addPolylinesLayer(dee, name, opts = {}) {
  const THREE = dee.THREE;
  const group = new THREE.Group();
  group.name = name;
  group.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);

  for (const line of (opts.lines || [])) {
    const n = line.vertices.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = line.vertices[i * 3];
      pos[i * 3 + 1] = line.vertices[i * 3 + 1];
      pos[i * 3 + 2] = line.vertices[i * 3 + 2];
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: line.color || 0xffffff });
    const lineObj = line.closed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat);
    group.add(lineObj);
  }

  dee.scene.add(group);
  dee.markDirty();

  const layer = {
    name, group, type: 'polylines',
    get visible() { return group.visible; },
    set visible(v) { group.visible = v; dee.markDirty(); },
    _dispose() {
      group.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); });
      dee.scene.remove(group);
    },
  };
  dee._layers.set(name, layer);
  return layer;
}

// ── clipping planes ──

export function addClipPlane(dee, opts = {}) {
  const THREE = dee.THREE;
  const ox = dee.origin[0], oy = dee.origin[1], oz = dee.origin[2];
  const p = opts.point || [0, 0, 0];
  const n = opts.normal || [0, 1, 0];
  const plane = new THREE.Plane(
    new THREE.Vector3(n[0], n[1], n[2]).normalize(),
    -(n[0] * (p[0] - ox) + n[1] * (p[1] - oy) + n[2] * (p[2] - oz))
  );
  dee.clippingPlanes.push(plane);
  dee.markDirty();

  return {
    plane,
    moveTo(newOpts) {
      const np = newOpts.point || p;
      const nn = newOpts.normal || n;
      plane.normal.set(nn[0], nn[1], nn[2]).normalize();
      plane.constant = -(nn[0] * (np[0] - ox) + nn[1] * (np[1] - oy) + nn[2] * (np[2] - oz));
      dee.markDirty();
    },
    flip() { plane.negate(); dee.markDirty(); },
    remove() {
      const idx = dee.clippingPlanes.indexOf(plane);
      if (idx >= 0) dee.clippingPlanes.splice(idx, 1);
      dee.markDirty();
    },
  };
}
