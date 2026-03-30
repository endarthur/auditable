// @gcu/dee — built from src/

// ── color.js ──

// @gcu/dee — color maps: continuous, categorical, palettes, colorbar

// ── named palettes (256 samples each, [r,g,b] 0-1) ──

const _palettes = {};

// Generate viridis-like palette (approximation)
function _viridis(t) {
  const r = 0.267 + t * (0.003 + t * (2.168 + t * (-5.044 + t * 2.163)));
  const g = 0.004 + t * (1.396 + t * (-1.118 + t * (0.546 - t * 0.453)));
  const b = 0.329 + t * (1.442 + t * (-4.894 + t * (6.560 - t * 3.110)));
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _inferno(t) {
  const r = t < 0.5 ? t * 2.6 : 1.0 - (t - 0.8) * 3;
  const g = t < 0.3 ? 0 : t < 0.7 ? (t - 0.3) * 2.5 : 1.0;
  const b = t < 0.25 ? t * 3.2 : t < 0.5 ? 0.8 - (t - 0.25) * 2.4 : 0.2 - (t - 0.5) * 0.4;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _coolwarm(t) {
  const r = t < 0.5 ? 0.3 + t * 1.0 : 0.8 + (t - 0.5) * 0.4;
  const g = t < 0.5 ? 0.3 + t * 0.8 : 0.7 - (t - 0.5) * 1.4;
  const b = t < 0.5 ? 0.8 - t * 0.4 : 0.6 - (t - 0.5) * 1.2;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

function _turbo(t) {
  const r = 0.13572 + t * (4.61539 + t * (-42.6603 + t * (132.130 + t * (-152.548 + t * 56.298))));
  const g = 0.09140 + t * (2.26400 + t * (-14.0191 + t * (34.637 + t * (-38.073 + t * 14.178))));
  const b = 0.10667 + t * (12.5925 + t * (-60.5820 + t * (109.370 + t * (-83.440 + t * 21.798))));
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

const _paletteFns = { viridis: _viridis, inferno: _inferno, coolwarm: _coolwarm, turbo: _turbo };

function _getPalette(name) {
  if (_palettes[name]) return _palettes[name];
  const fn = _paletteFns[name];
  if (!fn) return null;
  const p = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    p[i * 3] = r; p[i * 3 + 1] = g; p[i * 3 + 2] = b;
  }
  _palettes[name] = p;
  return p;
}

// ── continuous color map ──

function colorMap(opts) {
  const breaks = opts.breaks;
  const nBins = breaks.length + 1;
  const nanColor = opts.nanColor || [0.3, 0.3, 0.3];
  const palette = typeof opts.palette === 'string' ? _getPalette(opts.palette) : opts.palette;
  const belowColor = opts.belowColor || (palette ? [palette[0], palette[1], palette[2]] : [0.1, 0.1, 0.4]);
  const aboveColor = opts.aboveColor || (palette ? [palette[(255) * 3], palette[255 * 3 + 1], palette[255 * 3 + 2]] : [0.9, 0.1, 0.1]);

  function _binColor(binId) {
    if (binId === 255) return nanColor;
    if (!palette) return nanColor;
    const t = nBins > 1 ? (binId + 0.5) / nBins : 0.5;
    const idx = Math.min(255, Math.max(0, Math.round(t * 255)));
    return [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]];
  }

  const cmap = {
    breaks, nBins, nanColor, palette,
    map(value) {
      if (isNaN(value)) return nanColor;
      if (value <= breaks[0]) return belowColor;
      if (value > breaks[breaks.length - 1]) return aboveColor;
      let bin = 0;
      for (let i = 0; i < breaks.length; i++) { if (value > breaks[i]) bin = i + 1; }
      return _binColor(bin);
    },
    mapBin(binId) { return _binColor(binId); },
    texture(THREE) {
      if (!THREE) return null;
      const data = new Uint8Array(nBins * 4);
      for (let i = 0; i < nBins; i++) {
        const [r, g, b] = _binColor(i);
        data[i * 4] = r * 255; data[i * 4 + 1] = g * 255; data[i * 4 + 2] = b * 255; data[i * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(data, nBins, 1, THREE.RGBAFormat);
      tex.needsUpdate = true;
      return tex;
    },
  };
  return cmap;
}

// ── categorical color map ──

function categoricalMap(opts) {
  const codes = opts.codes;
  const colors = opts.colors;
  const labels = opts.labels;
  const nanColor = opts.nanColor || [0.3, 0.3, 0.3];
  const codeToColor = new Map();
  for (let i = 0; i < codes.length; i++) {
    const c = colors[i];
    if (typeof c === 'number') {
      codeToColor.set(codes[i], [(c >> 16 & 0xFF) / 255, (c >> 8 & 0xFF) / 255, (c & 0xFF) / 255]);
    } else {
      codeToColor.set(codes[i], c);
    }
  }
  return {
    codes, colors, labels, nanColor,
    map(value) { return codeToColor.get(value) || nanColor; },
    mapBin(binId) { return codeToColor.get(binId) || nanColor; },
  };
}

// ── colorbar ──

function colorBar(cmap, opts = {}) {
  const position = opts.position || 'right';
  const title = opts.title || '';
  const width = opts.width || 30;
  const tickCount = opts.tickCount || 6;
  const format = opts.format || (v => v.toPrecision(3));

  const container = document.createElement('div');
  container.style.cssText = `position:absolute;${position === 'right' ? 'right:10px;top:50%;transform:translateY(-50%)' : position === 'left' ? 'left:10px;top:50%;transform:translateY(-50%)' : 'bottom:10px;left:50%;transform:translateX(-50%)'};z-index:10;pointer-events:none;font:11px monospace;color:#ccc;`;

  const canvas = document.createElement('canvas');
  const height = 200;
  canvas.width = width; canvas.height = height;
  canvas.style.cssText = 'display:block;border:1px solid #444;';
  container.appendChild(canvas);

  if (title) {
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'text-align:center;margin-top:4px;font-size:11px;';
    container.appendChild(t);
  }

  function _draw(cm) {
    const ctx = canvas.getContext('2d');
    const nBins = cm.nBins || (cm.breaks ? cm.breaks.length + 1 : 10);
    for (let y = 0; y < height; y++) {
      const t = 1 - y / height;
      const binId = Math.min(nBins - 1, Math.floor(t * nBins));
      const [r, g, b] = cm.mapBin(binId);
      ctx.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
      ctx.fillRect(0, y, width, 1);
    }
    // ticks
    if (cm.breaks) {
      const lo = cm.breaks[0], hi = cm.breaks[cm.breaks.length - 1];
      // remove old tick labels
      container.querySelectorAll('.dee-tick').forEach(e => e.remove());
      const step = Math.max(1, Math.floor(cm.breaks.length / tickCount));
      for (let i = 0; i < cm.breaks.length; i += step) {
        const t = (cm.breaks[i] - lo) / (hi - lo);
        const y = (1 - t) * height;
        const label = document.createElement('div');
        label.className = 'dee-tick';
        label.textContent = format(cm.breaks[i]);
        label.style.cssText = `position:absolute;right:${width + 6}px;top:${y - 6}px;font-size:10px;white-space:nowrap;`;
        container.appendChild(label);
      }
    }
  }

  _draw(cmap);

  const bar = {
    element: container,
    update(newCmap) { _draw(newCmap); },
    dispose() { container.remove(); },
  };

  return bar;
}

// ── layers.js ──

// @gcu/dee — layer implementations: block model, points, drillholes, surface, polylines, section

// ── shared pick material ──

let _pickMat = null;
function _getPickMaterial(THREE, dee) {
  if (_pickMat) return _pickMat;
  _pickMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec4 aPickColor;
      varying vec4 vPick;
      void main() {
        vPick = aPickColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec4 vPick;
      void main() {
        gl_FragColor = vPick;
      }
    `,
    side: 2, // THREE.DoubleSide = 2
    blending: 0, // THREE.NoBlending = 0
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
  return _pickMat;
}

// ── block model layer ──

function addBlockModelLayer(dee, name, meshes, opts = {}) {
  const THREE = dee.THREE;
  const cmap = opts.colorMap;
  const group = new THREE.Group();
  group.name = name;
  const chunkMeshes = new Map();
  // pre-count quads for ID allocation
  let totalQuadCount = 0;
  for (const [_, md] of meshes) totalQuadCount += Math.ceil(md.binIds.length / 2);
  const idStart = dee.pick ? dee.pick.allocateIds(totalQuadCount + 1) : 0;
  let idOffset = 0;

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

    // pick: per-vertex ID as vec4 attribute
    if (dee.pick) {
      const pickColors = new Float32Array(nVerts * 4);
      for (let t = 0; t < nTris; t++) {
        const quadIdx = (t >> 1);
        const id = idStart + idOffset + quadIdx;
        const r = (id & 0xFF) / 255;
        const g = ((id >> 8) & 0xFF) / 255;
        const b = ((id >> 16) & 0xFF) / 255;
        const a = ((id >>> 24) & 0xFF) / 255;
        const baseVert = quadIdx * 4;
        for (let v = 0; v < 4; v++) {
          const vi = baseVert + v;
          if (vi < nVerts) {
            pickColors[vi * 4] = r; pickColors[vi * 4 + 1] = g;
            pickColors[vi * 4 + 2] = b; pickColors[vi * 4 + 3] = a;
          }
        }
      }
      geom.setAttribute('aPickColor', new THREE.Float32BufferAttribute(pickColors, 4));
      mesh._pickMaterial = _getPickMaterial(THREE, dee);
      idOffset += Math.ceil(nTris / 2);
    }

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

  // register pick resolve
  if (dee.pick && idStart) {
    dee.pick.registerLayer(name, {
      idStart,
      idEnd: idStart + idOffset,
      resolve(localId, layerName) {
        return { layer: layerName, type: 'block', quadIndex: localId };
      },
    });
    dee.pick.markDirty();
  }

  dee.markDirty();

  const layer = {
    name, group, type: 'blockmodel',
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
        if (m.material !== _pickMat) m.material.dispose();
      }
      chunkMeshes.clear();
      idOffset = 0;
      for (const [chunkIdx, meshData] of newMeshes) _buildChunk(chunkIdx, meshData);
      if (dee.pick) {
        dee.pick.registerLayer(name, { idStart, idEnd: idStart + idOffset,
          resolve(localId, layerName) { return { layer: layerName, type: 'block', quadIndex: localId }; },
        });
      }
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

function addSectionLayer(dee, name, sectionMesh, opts = {}) {
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

function addPointsLayer(dee, name, opts = {}) {
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

function addDrillholeLayer(dee, name, opts = {}) {
  const THREE = dee.THREE;
  const group = new THREE.Group();
  group.name = name;
  const radius = opts.radius || 1.5;
  const segments = opts.segments || 8;
  const method = opts.method || 'minimumCurvature';
  const cmap = opts.colorMap;

  // count total intervals for pick ID allocation
  let totalIntervals = 0;
  for (const hole of (opts.holes || [])) totalIntervals += (hole.intervals || []).length;
  const idStart = dee.pick ? dee.pick.allocateIds(totalIntervals + 1) : 0;
  let idOffset = 0;
  // map: localId → { holeId, intervalIndex, from, to }
  const pickMap = [];

  for (const hole of (opts.holes || [])) {
    const path = desurvey(hole.collar, hole.surveys, { method });
    if (!hole.intervals || hole.intervals.length === 0) continue;

    const depths = [];
    for (const iv of hole.intervals) { depths.push(iv.from, iv.to); }
    const pts = interpolatePath(path, hole.surveys, new Float64Array(depths));

    const positions = [], normals = [], colors = [], indices = [];
    const pickColors = [];
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

      // pick ID for this interval
      const pickId = idStart + idOffset;
      const pr = (pickId & 0xFF) / 255;
      const pg = ((pickId >> 8) & 0xFF) / 255;
      const pb = ((pickId >> 16) & 0xFF) / 255;
      const pa = ((pickId >>> 24) & 0xFF) / 255;
      pickMap.push({ holeId: hole.id, intervalIndex: iv, from: interval.from, to: interval.to, value: interval.value, category: interval.category });
      idOffset++;

      for (let ring = 0; ring < 2; ring++) {
        const p = ring === 0 ? p0 : p1;
        for (let s = 0; s < segments; s++) {
          const angle = (s / segments) * Math.PI * 2;
          const cos = Math.cos(angle) * radius, sin = Math.sin(angle) * radius;
          positions.push(p[0] + u[0] * cos + v[0] * sin, p[1] + u[1] * cos + v[1] * sin, p[2] + u[2] * cos + v[2] * sin);
          normals.push(u[0] * Math.cos(angle) + v[0] * Math.sin(angle), u[1] * Math.cos(angle) + v[1] * Math.sin(angle), u[2] * Math.cos(angle) + v[2] * Math.sin(angle));
          colors.push(r, g, b);
          pickColors.push(pr, pg, pb, pa);
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

    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `${name}_${hole.id || 'hole'}`;
    if (dee.pick) {
      geom.setAttribute('aPickColor', new THREE.Float32BufferAttribute(new Float32Array(pickColors), 4));
      mesh._pickMaterial = _getPickMaterial(THREE, dee);
    }
    group.add(mesh);
  }

  // offset group same as block model — world coords, group transform subtracts origin
  group.position.set(-dee.origin[0], -dee.origin[1], -dee.origin[2]);
  dee.scene.add(group);

  if (dee.pick && idStart) {
    dee.pick.registerLayer(name, {
      idStart,
      idEnd: idStart + idOffset,
      resolve(localId, layerName) {
        const info = pickMap[localId];
        if (!info) return { layer: layerName, type: 'drillhole' };
        return { layer: layerName, type: 'drillhole', holeId: info.holeId, intervalIndex: info.intervalIndex, from: info.from, to: info.to, value: info.value, category: info.category };
      },
    });
    dee.pick.markDirty();
  }

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

function desurvey(collar, surveys, opts) {
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

function interpolatePath(path, surveys, depths) {
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

function addSurfaceLayer(dee, name, opts = {}) {
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

function addPolylinesLayer(dee, name, opts = {}) {
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

function addClipPlane(dee, opts = {}) {
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

// ── hud.js ──

// @gcu/dee — HUD overlays: north arrow, scale bar, coordinate readout, axes, bounding box

function createHUD(dee) {
  const THREE = dee.THREE;
  const container = dee.renderer.domElement.parentElement;

  return {
    northArrow(opts = {}) {
      const size = opts.size || 60;
      const pos = opts.position || 'top-right';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'top-right' ? 'top:10px;right:10px' : 'top:10px;left:10px'};width:${size}px;height:${size}px;pointer-events:none;z-index:10;`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('width', size); svg.setAttribute('height', size);
      svg.innerHTML = `<polygon points="50,10 40,60 50,50 60,60" fill="#c89b3c" stroke="#888" stroke-width="1"/>
        <text x="50" y="8" text-anchor="middle" fill="#ccc" font-size="14" font-family="monospace">N</text>`;
      el.appendChild(svg);
      container.appendChild(el);

      // update rotation on render
      dee.onAfterRender(() => {
        const cam = dee.camera;
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const angle = Math.atan2(dir.x, dir.y) * 180 / Math.PI;
        svg.style.transform = `rotate(${angle}deg)`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    scaleBar(opts = {}) {
      const pos = opts.position || 'bottom-left';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'bottom-left' ? 'bottom:10px;left:10px' : 'bottom:10px;right:10px'};z-index:10;pointer-events:none;font:11px monospace;color:#ccc;`;
      const barEl = document.createElement('div');
      barEl.style.cssText = 'border:1px solid #ccc;border-top:none;height:6px;width:100px;';
      const labelEl = document.createElement('div');
      labelEl.style.cssText = 'text-align:center;margin-top:2px;';
      el.appendChild(barEl);
      el.appendChild(labelEl);
      container.appendChild(el);

      dee.onAfterRender(() => {
        const cam = dee.camera;
        const w = dee.renderer.domElement.clientWidth;
        // approximate world units per pixel
        const dist = cam.position.distanceTo(dee.controls._controls.target);
        const vFov = cam.fov * Math.PI / 180;
        const worldH = 2 * dist * Math.tan(vFov / 2);
        const worldPerPx = worldH / dee.renderer.domElement.clientHeight;
        const targetPx = 100;
        const worldLen = worldPerPx * targetPx;
        // round to nice number
        const mag = Math.pow(10, Math.floor(Math.log10(worldLen)));
        const nice = worldLen / mag >= 5 ? 5 * mag : worldLen / mag >= 2 ? 2 * mag : mag;
        const barPx = nice / worldPerPx;
        barEl.style.width = `${barPx}px`;
        labelEl.textContent = nice >= 1000 ? `${(nice / 1000).toFixed(1)} km` : `${nice.toFixed(0)} m`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    coordReadout(opts = {}) {
      const pos = opts.position || 'bottom-right';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'bottom-right' ? 'bottom:10px;right:10px' : 'bottom:10px;left:120px'};z-index:10;pointer-events:none;font:11px monospace;color:#999;`;
      container.appendChild(el);

      dee.pick.on('hover', (result) => {
        if (!result || !result.worldPosition) { el.textContent = ''; return; }
        const [x, y, z] = result.worldPosition;
        el.textContent = `E: ${x.toFixed(1)}  N: ${y.toFixed(1)}  Z: ${z.toFixed(1)}`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    axes(opts = {}) {
      const length = opts.length || 100;
      const labels = opts.labels || ['E', 'N', 'Z'];
      const group = new THREE.Group();
      group.name = '_hud_axes';

      const colors = [0xff4444, 0x44ff44, 0x4444ff];
      for (let i = 0; i < 3; i++) {
        const dir = [0, 0, 0]; dir[i] = length;
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(dir[0], dir[1], dir[2]),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: colors[i] });
        group.add(new THREE.Line(geom, mat));
      }

      dee.scene.add(group);
      dee.markDirty();
      return { group, dispose() { group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); dee.scene.remove(group); } };
    },

    boundingBox(gridDefOrBounds) {
      let min, max;
      if (gridDefOrBounds.min && gridDefOrBounds.max) {
        min = gridDefOrBounds.min; max = gridDefOrBounds.max;
      } else {
        // assume grid definition — import not available here, compute manually
        const g = gridDefOrBounds;
        const nx = g.count[0] - 1, ny = g.count[1] - 1, nz = g.count[2] - 1;
        const hx = g.size[0] / 2, hy = g.size[1] / 2, hz = g.size[2] / 2;
        min = [g.origin[0] - hx, g.origin[1] - hy, g.origin[2] - hz];
        max = [g.origin[0] + nx * g.size[0] + hx, g.origin[1] + ny * g.size[1] + hy, g.origin[2] + nz * g.size[2] + hz];
      }
      const ox = dee.origin[0], oy = dee.origin[1], oz = dee.origin[2];
      const box = new THREE.Box3(
        new THREE.Vector3(min[0] - ox, min[1] - oy, min[2] - oz),
        new THREE.Vector3(max[0] - ox, max[1] - oy, max[2] - oz),
      );
      const helper = new THREE.Box3Helper(box, 0x888888);
      helper.name = '_hud_bbox';
      dee.scene.add(helper);
      dee.markDirty();
      return { helper, dispose() { dee.scene.remove(helper); } };
    },
  };
}

// ── scene.js ──

// @gcu/dee — scene setup, render loop, disposal

function create(container, opts = {}) {
  const THREE = opts.THREE || globalThis.THREE;
  if (!THREE) throw new Error('dee: THREE.js not found — pass opts.THREE or set globalThis.THREE');

  const origin = opts.origin || [0, 0, 0];

  // renderer
  const renderer = new THREE.WebGLRenderer({ antialias: opts.antialias !== false, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(opts.background ?? 0x1a1a2e);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  // scene — rotate so Z is up (geological convention → Three.js Y-up)
  const scene = new THREE.Scene();
  scene.rotation.x = -Math.PI / 2;

  // camera
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100000);
  camera.position.set(500, 500, 500);
  let _orthoCamera = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 100000);
  let _activeCamera = camera;
  let _isOrtho = false;

  // lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const headlamp = new THREE.DirectionalLight(0xffffff, 0.6);
  scene.add(headlamp);
  const lighting = {
    ambient,
    headlamp,
    get enabled() { return headlamp.visible; },
    set enabled(v) { headlamp.visible = v; },
  };

  // controls (OrbitControls)
  const controls = _createControls(THREE, _activeCamera, renderer.domElement, origin, scene);

  // pick system
  const _bgColor = opts.background ?? 0x1a1a2e;
  // pass a getter so pick always uses the current camera
  const pick = _createPickSystem(THREE, renderer, scene, () => _activeCamera, origin, container, _bgColor);

  // layers
  const _layers = new Map();

  // clipping planes
  const clippingPlanes = [];

  // render loop — on-demand by default
  let _dirty = true;
  let _rafId = null;
  let _continuous = false;
  const _beforeRender = [];
  const _afterRender = [];

  function _renderFrame() {
    _rafId = null;

    if (controls._controls.update) controls._controls.update();
    headlamp.position.copy(_activeCamera.position);

    for (const fn of _beforeRender) fn();
    renderer.render(scene, _activeCamera);
    pick._render(_activeCamera);
    for (const fn of _afterRender) fn();

    _dirty = false;
    if (_continuous) _rafId = requestAnimationFrame(_renderFrame);
  }

  function markDirty() {
    _dirty = true;
    pick.markDirty();
    if (!_rafId) _rafId = requestAnimationFrame(_renderFrame);
  }

  function renderOnce() {
    headlamp.position.copy(_activeCamera.position);
    renderer.render(scene, _activeCamera);
  }

  // controls change → dirty
  controls._controls.addEventListener('change', () => markDirty());

  // resize
  const _resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    _updateOrtho();
    pick._resize(w, h);
    markDirty();
  });
  _resizeObs.observe(container);

  function _updateOrtho() {
    const w = container.clientWidth, h = container.clientHeight;
    const dist = _activeCamera.position.distanceTo(controls._controls.target);
    const vFov = camera.fov * Math.PI / 180;
    const halfH = dist * Math.tan(vFov / 2);
    const halfW = halfH * (w / h);
    _orthoCamera.left = -halfW; _orthoCamera.right = halfW;
    _orthoCamera.top = halfH; _orthoCamera.bottom = -halfH;
    _orthoCamera.position.copy(_activeCamera.position);
    _orthoCamera.quaternion.copy(_activeCamera.quaternion);
    _orthoCamera.updateProjectionMatrix();
  }

  // initial render
  markDirty();

  const dee = {
    THREE, renderer, scene, camera, controls, pick, lighting,
    origin, clippingPlanes,

    // layers
    addBlockModel: (name, meshes, layerOpts) => _addBlockModelLayer(dee, name, meshes, layerOpts),
    addSection: (name, sectionMesh, layerOpts) => _addSectionLayer(dee, name, sectionMesh, layerOpts),
    addPoints: (name, layerOpts) => _addPointsLayer(dee, name, layerOpts),
    addDrillholes: (name, layerOpts) => _addDrillholeLayer(dee, name, layerOpts),
    addSurface: (name, layerOpts) => _addSurfaceLayer(dee, name, layerOpts),
    addPolylines: (name, layerOpts) => _addPolylinesLayer(dee, name, layerOpts),
    addClipPlane: (opts) => _addClipPlane(dee, opts),
    getLayer: (name) => _layers.get(name),
    removeLayer: (name) => {
      const l = _layers.get(name);
      if (l) { l._dispose(); _layers.delete(name); markDirty(); }
    },
    _layers,

    // render loop
    markDirty, renderOnce,
    loop: {
      start() { _continuous = true; markDirty(); },
      stop() { _continuous = false; },
    },
    onBeforeRender: (fn) => _beforeRender.push(fn),
    onAfterRender: (fn) => _afterRender.push(fn),

    // camera projection
    ortho() {
      _isOrtho = true;
      _updateOrtho();
      _activeCamera = _orthoCamera;
      controls._controls.object = _activeCamera;
      // camera updated via getCamera()
      markDirty();
    },
    perspective() {
      _isOrtho = false;
      _activeCamera = camera;
      controls._controls.object = _activeCamera;
      // camera updated via getCamera()
      markDirty();
    },

    // screenshot
    screenshot: (sopts) => _screenshot(dee, sopts),

    // resize
    resize() { _resizeObs.disconnect(); _resizeObs.observe(container); },

    // disposal
    dispose() {
      if (_rafId) cancelAnimationFrame(_rafId);
      _resizeObs.disconnect();
      controls._controls.dispose();
      pick._dispose();
      for (const [_, l] of _layers) l._dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  dee.hud = createHUD(dee);
  return dee;
}

// ── controls wrapper ──

function _createControls(THREE, camera, domElement, origin, scene) {
  // OrbitControls from Three.js — must be loaded externally
  const OC = THREE.OrbitControls || globalThis.OrbitControls;
  let _controls;
  if (OC) {
    _controls = new OC(camera, domElement);
    _controls.enableDamping = false;
    _controls.target.set(0, 0, 0);
  } else {
    // stub if OrbitControls not loaded
    _controls = { update() {}, dispose() {}, target: new THREE.Vector3(), addEventListener() {}, object: camera };
  }

  const _changeCallbacks = [];
  if (_controls.addEventListener) {
    _controls.addEventListener('change', () => {
      const state = ctrl.save();
      for (const fn of _changeCallbacks) fn(state);
    });
  }

  const ctrl = {
    _controls,
    _damping: true,

    lookAt(worldPos) {
      const t = new THREE.Vector3(worldPos[0] - origin[0], worldPos[1] - origin[1], worldPos[2] - origin[2]);
      _controls.target.copy(t);
    },
    distance(d) {
      const dir = new THREE.Vector3().subVectors(camera.position, _controls.target).normalize();
      camera.position.copy(_controls.target).addScaledVector(dir, d);
    },

    // standard mining views — reposition camera, don't touch camera.up
    // scene rotation maps geological (E, N, Z) → world (X, Y, -Z)
    // so: world X = easting, world Y = elevation, world Z = -northing
    planView() {
      const t = _controls.target;
      const d = camera.position.distanceTo(t) || 500;
      camera.position.set(t.x, t.y + d, t.z); // above, looking down
      _controls.update();
    },
    sectionNorth(y) {
      const t = _controls.target;
      const d = camera.position.distanceTo(t) || 500;
      if (y != null) t.z = -(y - origin[1]);
      camera.position.set(t.x, t.y, t.z + d); // south of target, looking north
      _controls.update();
    },
    sectionEast(x) {
      const t = _controls.target;
      const d = camera.position.distanceTo(t) || 500;
      if (x != null) t.x = x - origin[0];
      camera.position.set(t.x - d, t.y, t.z); // west of target, looking east
      _controls.update();
    },
    perspective() {},

    fitAll() { /* requires bounding box of all layers — filled in by scene */ },
    fitTo(layer) {},

    // ortho/perspective toggles delegated to parent scene object

    on(event, fn) { if (event === 'change') _changeCallbacks.push(fn); },
    save() {
      return {
        position: [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]],
        target: [_controls.target.x + origin[0], _controls.target.y + origin[1], _controls.target.z + origin[2]],
      };
    },
    restore(state) {
      camera.position.set(state.position[0] - origin[0], state.position[1] - origin[1], state.position[2] - origin[2]);
      _controls.target.set(state.target[0] - origin[0], state.target[1] - origin[1], state.target[2] - origin[2]);
    },
  };

  // fitAll: compute bounding box of scene and frame
  ctrl.fitAll = function() {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    scene.traverse(obj => {
      if (obj.isMesh || obj.isPoints || obj.isLine) {
        obj.geometry?.computeBoundingBox?.();
        if (obj.geometry?.boundingBox) {
          const b = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
          box.union(b);
        }
      }
    });
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    _controls.target.copy(center);
    const dir = new THREE.Vector3().subVectors(camera.position, center).normalize();
    if (dir.lengthSq() < 0.001) dir.set(1, 1, 1).normalize();
    camera.position.copy(center).addScaledVector(dir, maxDim * 1.5);
    camera.lookAt(center);
    _controls.target.copy(center);
    camera.updateProjectionMatrix();
  };

  return ctrl;
}

// ── pick system ──

function _createPickSystem(THREE, renderer, scene, getCamera, origin, container, clearColor) {
  const _clearColor = clearColor;
  let _w = Math.max(1, container.clientWidth);
  let _h = Math.max(1, container.clientHeight);
  let _depthTex = new THREE.DepthTexture(_w, _h);
  let _rt = new THREE.WebGLRenderTarget(_w, _h, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthTexture: _depthTex,
    depthBuffer: true, stencilBuffer: false,
  });
  const _pixel = new Uint8Array(4);
  let _dirty = true;
  let _enabled = true;
  let _debug = false;
  const _layers = new Map();
  let _nextId = 1;
  const _callbacks = { hover: [], click: [], dblclick: [] };

  let _debugNoSwap = false; // diagnostic: render normal materials to pick target

  function _render(cam) {
    if (!_enabled) return;
    const swapped = [];
    const hidden = [];
    if (!_debugNoSwap) {
      scene.traverse(obj => {
        if (obj._pickMaterial) {
          swapped.push([obj, obj.material]);
          obj.material = obj._pickMaterial;
        } else if ((obj.isMesh || obj.isPoints || obj.isLine) && obj.visible) {
          hidden.push(obj);
          obj.visible = false;
        }
      });
    }
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(_rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(_clearColor, 1);
    renderer.autoClear = prevAutoClear;
    for (const [obj, origMat] of swapped) obj.material = origMat;
    for (const obj of hidden) obj.visible = true;
    _dirty = false;
  }

  function _query(x, y) {
    if (!_enabled) return null;
    _render(getCamera()); // always use current camera
    const px = Math.floor(x * _w / container.clientWidth);
    const py = _h - 1 - Math.floor(y * _h / container.clientHeight);
    renderer.readRenderTargetPixels(_rt, px, py, 1, 1, _pixel);
    const id = (_pixel[0] | (_pixel[1] << 8) | (_pixel[2] << 16) | (_pixel[3] << 24)) >>> 0;
    if (_debug) console.log('pick:', px, py, '→ rgba', _pixel[0], _pixel[1], _pixel[2], _pixel[3], '= id', id);
    if (id === 0) return null;
    for (const [name, info] of _layers) {
      if (id >= info.idStart && id < info.idEnd) {
        return info.resolve(id - info.idStart, name);
      }
    }
    return null;
  }

  // mouse events
  let _hoverRaf = null;
  container.addEventListener('mousemove', (e) => {
    if (_hoverRaf) return;
    _hoverRaf = requestAnimationFrame(() => {
      _hoverRaf = null;
      const result = _query(e.offsetX, e.offsetY);
      for (const fn of _callbacks.hover) fn(result);
    });
  });
  container.addEventListener('click', (e) => {
    const result = _query(e.offsetX, e.offsetY);
    for (const fn of _callbacks.click) fn(result);
  });
  container.addEventListener('dblclick', (e) => {
    const result = _query(e.offsetX, e.offsetY);
    for (const fn of _callbacks.dblclick) fn(result);
  });

  return {
    _render,
    _layers,
    _dirty: true,
    _resize(w, h) {
      _w = Math.max(1, w);
      _h = Math.max(1, h);
      _rt.dispose();
      _depthTex = new THREE.DepthTexture(_w, _h);
      _rt = new THREE.WebGLRenderTarget(_w, _h, {
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthTexture: _depthTex,
        depthBuffer: true, stencilBuffer: false,
      });
      _dirty = true;
    },
    _dispose() { _rt.dispose(); },
    enable() { _enabled = true; },
    disable() { _enabled = false; },
    at(x, y) { return _query(x, y); },
    on(event, fn) { if (_callbacks[event]) _callbacks[event].push(fn); },
    allocateIds(count) {
      const start = _nextId;
      _nextId += count;
      return start;
    },
    registerLayer(name, info) {
      _layers.set(name, info);
    },
    markDirty() { _dirty = true; },
    set debug(v) { _debug = v; },
    set debugNoSwap(v) { _debugNoSwap = v; },
    // render pick materials to main canvas for visual diagnostic
    debugPickToScreen() {
      const swapped = [];
      const hidden = [];
      scene.traverse(obj => {
        if (obj._pickMaterial) {
          swapped.push([obj, obj.material]);
          obj.material = obj._pickMaterial;
        } else if ((obj.isMesh || obj.isPoints || obj.isLine) && obj.visible) {
          hidden.push(obj);
          obj.visible = false;
        }
      });
      renderer.setClearColor(0x000000, 1);
      renderer.render(scene, getCamera());
      renderer.setClearColor(_clearColor, 1);
      for (const [obj, origMat] of swapped) obj.material = origMat;
      for (const obj of hidden) obj.visible = true;
    },
    // render pick buffer to a visible canvas for debugging
    debugCanvas() {
      _render(getCamera());
      const pixels = new Uint8Array(_w * _h * 4);
      renderer.readRenderTargetPixels(_rt, 0, 0, _w, _h, pixels);
      const c = document.createElement('canvas');
      c.width = _w; c.height = _h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(_w, _h);
      // flip Y and amplify colors for visibility
      for (let y = 0; y < _h; y++) {
        for (let x = 0; x < _w; x++) {
          const srcIdx = ((_h - 1 - y) * _w + x) * 4;
          const dstIdx = (y * _w + x) * 4;
          // raw RGB, force alpha=255
          img.data[dstIdx] = pixels[srcIdx];
          img.data[dstIdx + 1] = pixels[srcIdx + 1];
          img.data[dstIdx + 2] = pixels[srcIdx + 2];
          img.data[dstIdx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  };
}

// ── screenshot ──

async function _screenshot(dee, opts) {
  const w = opts?.width || dee.renderer.domElement.width;
  const h = opts?.height || dee.renderer.domElement.height;
  const format = opts?.format || 'png';
  const quality = opts?.quality || 0.9;

  // render at requested resolution
  const origW = dee.renderer.domElement.width;
  const origH = dee.renderer.domElement.height;
  dee.renderer.setSize(w, h);
  dee.camera.aspect = w / h;
  dee.camera.updateProjectionMatrix();
  dee.renderer.render(dee.scene, dee.camera);

  const blob = await new Promise(resolve => {
    dee.renderer.domElement.toBlob(resolve, `image/${format}`, quality);
  });

  // restore
  dee.renderer.setSize(origW, origH);
  dee.camera.aspect = origW / origH;
  dee.camera.updateProjectionMatrix();
  dee.markDirty();

  return blob;
}

// ── layer stubs (implemented in layers.js) ──

function _addBlockModelLayer(dee, name, meshes, opts) { return addBlockModelLayer(dee, name, meshes, opts); }
function _addSectionLayer(dee, name, mesh, opts) { return addSectionLayer(dee, name, mesh, opts); }
function _addPointsLayer(dee, name, opts) { return addPointsLayer(dee, name, opts); }
function _addDrillholeLayer(dee, name, opts) { return addDrillholeLayer(dee, name, opts); }
function _addSurfaceLayer(dee, name, opts) { return addSurfaceLayer(dee, name, opts); }
function _addPolylinesLayer(dee, name, opts) { return addPolylinesLayer(dee, name, opts); }
function _addClipPlane(dee, opts) { return addClipPlane(dee, opts); }

// ── exports ──
export {
  create,
  colorMap, categoricalMap, colorBar,
  addBlockModelLayer, addSectionLayer, addPointsLayer,
  addDrillholeLayer, addSurfaceLayer, addPolylinesLayer, addClipPlane,
  desurvey, interpolatePath,
  createHUD,
};
