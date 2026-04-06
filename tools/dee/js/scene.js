// dee tool — 3D scene lifecycle

async function loadThreeJS() {
  const THREE = await import('https://esm.sh/three@0.170.0');
  const { OrbitControls } = await import('https://esm.sh/three@0.170.0/examples/jsm/controls/OrbitControls.js');
  globalThis.THREE = THREE;
  globalThis.OrbitControls = OrbitControls;
  return THREE;
}

function initScene() {
  const container = $('#d3-viewport');
  D3.container = container;
  D3.scene = create(container, { THREE: globalThis.THREE, origin: [0, 0, 0] });
  // expose grid functions for raycaster
  window._gcu_grid = { locate: _grid.locate, ijk: _grid.ijk };
  D3.scene.raycast.enablePicking({ grid: window._gcu_grid });
}

function loadBlockModel(gridDef, compactVar, columnName) {
  // remove existing block layer
  if (D3.blockLayer) { D3.scene.removeLayer('blocks'); D3.blockLayer = null; }

  D3.gridDef = gridDef;
  D3.activeColumn = columnName;

  // update scene origin to grid center
  const bb = _grid.boundingBox(gridDef);
  D3.scene.origin[0] = (bb.min[0] + bb.max[0]) / 2;
  D3.scene.origin[1] = (bb.min[1] + bb.max[1]) / 2;
  D3.scene.origin[2] = (bb.min[2] + bb.max[2]) / 2;

  // mesh
  const t0 = performance.now();
  const hint = Math.max(16, Math.min(64, Math.ceil(Math.max(gridDef.count[0], gridDef.count[1], gridDef.count[2]) / 4)));
  D3.prepared = _voxmesh.prepare(gridDef, compactVar, { count: D3.binCount, hint });
  D3.breaks = D3.prepared.breaks;
  D3.perf.meshTime = performance.now() - t0;

  // count triangles
  let tris = 0;
  for (const [_, m] of D3.prepared.meshes) tris += m.indices.length / 3;
  D3.perf.triangles = tris;
  D3.perf.blocks = compactVar.indices.length;

  // color map
  const cmap = colorMap({ breaks: D3.prepared.breaks, palette: D3.palette });
  D3.blockLayer = D3.scene.addBlockModel('blocks', D3.prepared.meshes, {
    colorMap: cmap, gridDef, compactVar,
  });

  // bounding box + fit
  D3.scene.hud.boundingBox(_grid.boundingBox(gridDef));
  D3.scene.controls.fitAll();

  updatePerf();
  updateStatus();
}

function loadDrillholes(holes) {
  if (D3.holeLayer) { D3.scene.removeLayer('holes'); D3.holeLayer = null; }
  D3.drillholes = holes;
  if (!holes.length || !D3.scene) return;

  const cmap = D3.prepared ? colorMap({ breaks: D3.prepared.breaks, palette: D3.palette }) : null;
  D3.holeLayer = D3.scene.addDrillholes('holes', { holes, colorMap: cmap, radius: Math.min(D3.gridDef.size[0], D3.gridDef.size[1]) * 0.15 });
  D3.scene.markDirty();
}

function updateCutoff(value) {
  if (!D3.prepared || !D3.gridDef) return;
  D3.cutoff = value;

  const cv = D3.columns[D3.activeColumn];
  if (!cv) return;

  let compactVar;
  if (value === null) {
    compactVar = cv;
  } else {
    const aboveMask = _grid.maskAboveValue(cv.values, value);
    const aboveLocal = _grid.maskToIndices(aboveMask);
    compactVar = {
      values: _grid.take(cv.values, aboveLocal),
      indices: _grid.take(cv.indices, aboveLocal),
    };
  }

  const t0 = performance.now();
  const hint = Math.max(16, Math.min(64, Math.ceil(Math.max(D3.gridDef.count[0], D3.gridDef.count[1], D3.gridDef.count[2]) / 4)));
  // use same breaks as the full model so colors stay consistent
  const prepared = _voxmesh.prepare(D3.gridDef, compactVar, { breaks: D3.breaks, hint });
  D3.perf.meshTime = performance.now() - t0;

  let tris = 0;
  for (const [_, m] of prepared.meshes) tris += m.indices.length / 3;
  D3.perf.triangles = tris;
  D3.perf.blocks = compactVar.indices.length;

  D3.blockLayer.replaceAll(prepared.meshes);
  D3.scene.markDirty();
  updatePerf();
  updateStatus();
}

function updatePalette(name) {
  D3.palette = name;
  // rebuild with new palette
  if (D3.gridDef && D3.columns[D3.activeColumn]) {
    loadBlockModel(D3.gridDef, D3.columns[D3.activeColumn], D3.activeColumn);
  }
}

function switchColumn(name) {
  if (!D3.columns[name]) return;
  D3.cutoff = null;
  loadBlockModel(D3.gridDef, D3.columns[name], name);
}

function teardownScene() {
  if (D3.scene) { D3.scene.dispose(); D3.scene = null; }
  D3.blockLayer = null;
  D3.holeLayer = null;
  D3.prepared = null;
  D3.sectionMode = false;
  D3.sectionClip = null;
  D3.sectionLayer = null;
}

function toggleWireframe() {
  if (!D3.scene) return;
  D3.scene.scene.traverse(obj => {
    if (obj.isMesh && obj.material && !obj._isHighlight) {
      obj.material.wireframe = !obj.material.wireframe;
    }
  });
  D3.scene.markDirty();
}

function _getCurrentCompactVar() {
  const cv = D3.columns[D3.activeColumn];
  if (!cv) return null;
  if (D3.cutoff === null) return cv;
  const aboveMask = _grid.maskAboveValue(cv.values, D3.cutoff);
  const aboveLocal = _grid.maskToIndices(aboveMask);
  return {
    values: _grid.take(cv.values, aboveLocal),
    indices: _grid.take(cv.indices, aboveLocal),
  };
}

// ── section plane via click-drag ──

function enterSectionMode() {
  if (!D3.scene) return;
  D3.sectionMode = true;
  const vp = $('#d3-viewport');
  if (vp) vp.style.cursor = 'crosshair';
  // disable orbit controls during section draw
  if (D3.scene?.controls._controls) D3.scene.controls._controls.enabled = false;
  updateStatus();
  const msg = $('#d3-status-msg');
  if (msg) msg.textContent = 'click and drag to define section plane';
}

function exitSectionMode() {
  D3.sectionMode = false;
  const vp = $('#d3-viewport');
  if (vp) vp.style.cursor = '';
  if (D3.scene?.controls._controls) D3.scene.controls._controls.enabled = true;
  updateStatus();
}

function clearSection() {
  if (D3.sectionClip) { D3.sectionClip.remove(); D3.sectionClip = null; }
  if (D3.sectionLayer) { D3.scene.removeLayer('section'); D3.sectionLayer = null; }
  if (D3.scene) D3.scene._sectionPlane = null;
  D3.scene?.markDirty();
}

function initSectionDrag() {
  const canvas = $('#d3-viewport');
  if (!canvas) return;
  let startX = null, startY = null;
  let lineEl = null;

  canvas.addEventListener('mousedown', (e) => {
    if (!D3.sectionMode || e.button !== 0) return;
    startX = e.offsetX; startY = e.offsetY;
    // create drag line overlay
    lineEl = document.createElement('div');
    lineEl.className = 'd3-section-line';
    lineEl.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;`;
    canvas.appendChild(lineEl);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!D3.sectionMode || startX === null || !lineEl) return;
    // draw SVG line
    const w = canvas.clientWidth, h = canvas.clientHeight;
    lineEl.innerHTML = `<svg width="${w}" height="${h}" style="position:absolute;top:0;left:0">
      <line x1="${startX}" y1="${startY}" x2="${e.offsetX}" y2="${e.offsetY}" stroke="#c89b3c" stroke-width="2" stroke-dasharray="6,4"/>
    </svg>`;
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!D3.sectionMode || startX === null) return;
    const endX = e.offsetX, endY = e.offsetY;
    if (lineEl) { lineEl.remove(); lineEl = null; }

    // need minimum drag distance
    const dx = endX - startX, dy = endY - startY;
    if (dx * dx + dy * dy < 100) { startX = null; return; }

    // compute section plane from the two screen points + camera
    applySection(startX, startY, endX, endY);
    startX = null;
    exitSectionMode();
  });
}

function applySection(x1, y1, x2, y2) {
  if (!D3.scene || !D3.gridDef) return;
  const THREE = globalThis.THREE;
  const camera = D3.scene.camera;
  const vp = $('#d3-viewport');
  const w = vp.clientWidth, h = vp.clientHeight;

  // three points define the plane: camera + two unprojected screen points
  const a = new THREE.Vector3((x1 / w) * 2 - 1, -(y1 / h) * 2 + 1, 0.5).unproject(camera);
  const b = new THREE.Vector3((x2 / w) * 2 - 1, -(y2 / h) * 2 + 1, 0.5).unproject(camera);
  const c = camera.position;

  const ca = a.clone().sub(c);
  const cb = b.clone().sub(c);
  const normal = ca.clone().cross(cb).normalize();
  if (normal.lengthSq() < 0.001) return;

  // clear previous
  clearSection();

  // clip plane in world space
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, c);

  clearSection();
  D3.scene.clippingPlanes.push(plane);

  // section fill: use the same filtered data as the current view
  const cv = _getCurrentCompactVar();
  if (cv && D3.prepared) {
    const invScene = new THREE.Matrix4().copy(D3.scene.scene.matrixWorld).invert();
    const normMat = new THREE.Matrix3().getNormalMatrix(invScene);

    // transform midpoint of drag to geological coords
    const midWorld = a.clone().add(b).multiplyScalar(0.5);
    const midGeo = midWorld.clone().applyMatrix4(invScene);
    const normalGeo = normal.clone().applyMatrix3(normMat).normalize();

    const geoPoint = [midGeo.x + D3.scene.origin[0], midGeo.y + D3.scene.origin[1], midGeo.z + D3.scene.origin[2]];
    const geoNormal = [normalGeo.x, normalGeo.y, normalGeo.z];

    const binIds = _voxmesh.discretize(cv.values, D3.breaks);
    const sectionMesh = _voxmesh.meshSection(D3.gridDef, cv, binIds, { point: geoPoint, normal: geoNormal });
    if (sectionMesh.positions.length > 0) {
      const cmap = colorMap({ breaks: D3.breaks, palette: D3.palette });
      D3.sectionLayer = D3.scene.addSection('section', sectionMesh, { colorMap: cmap, pickable: false });

      // store plane on dee for ray-plane picking (no mesh needed)
      D3.scene._sectionPlane = plane;
    }
  }

  D3.scene.markDirty();

  D3.sectionClip = {
    plane,
    remove() {
      const idx = D3.scene.clippingPlanes.indexOf(plane);
      if (idx >= 0) D3.scene.clippingPlanes.splice(idx, 1);
      D3.scene.markDirty();
    },
    flip() { plane.negate(); D3.scene.markDirty(); },
  };
}

