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
  const prepared = _voxmesh.prepare(D3.gridDef, compactVar, { count: D3.binCount, hint });
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
}
