// @gcu/dee — raycaster picking + selection highlights

export function createRaycaster(dee) {
  const THREE = dee.THREE;
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const container = dee.renderer.domElement;

  // highlight objects
  let _highlightMesh = null;
  let _highlightPoint = null;

  function _pick(x, y) {
    const rect = container.getBoundingClientRect();
    mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((y - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, dee.camera);

    // collect pickable objects
    const objects = [];
    dee.scene.traverse(obj => {
      if ((obj.isMesh || obj.isPoints) && obj.visible && !obj._isHighlight) {
        objects.push(obj);
      }
    });

    const hits = raycaster.intersectObjects(objects, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    // hit.point is in Three.js world space (scene rotation applied)
    // undo scene rotation to get geological coords, then add origin
    const invScene = new THREE.Matrix4().copy(dee.scene.matrixWorld).invert();
    const localPt = hit.point.clone().applyMatrix4(invScene);
    const worldPos = [
      localPt.x + dee.origin[0],
      localPt.y + dee.origin[1],
      localPt.z + dee.origin[2],
    ];

    // determine layer
    let layerName = null, layerType = null;
    for (const [name, layer] of dee._layers) {
      if (layer.group) {
        let found = false;
        layer.group.traverse(obj => { if (obj === hit.object) found = true; });
        if (found) { layerName = name; layerType = layer.type; break; }
      }
    }

    return {
      point: hit.point.clone(),         // Three.js world space
      scenePoint: localPt.clone(),      // scene-local space (for highlights)
      worldPosition: worldPos,          // geological coords [E, N, Z]
      faceIndex: hit.faceIndex,
      object: hit.object,
      layer: layerName,
      type: layerType,
      distance: hit.distance,
    };
  }

  // ── block model resolve: hit point → grid block index ──

  function resolveBlock(result, gridDef, compactVar) {
    if (!result || !gridDef) return null;
    const { locate } = _getGridFns();
    if (!locate) return null;

    // worldPosition is geological coords — offset slightly toward camera to land inside the block
    const gx = result.worldPosition[0];
    const gy = result.worldPosition[1];
    const gz = result.worldPosition[2];

    // camera position in geological coords
    const invScene = new THREE.Matrix4().copy(dee.scene.matrixWorld).invert();
    const camLocal = dee.camera.position.clone().applyMatrix4(invScene);
    const camGeo = [camLocal.x + dee.origin[0], camLocal.y + dee.origin[1], camLocal.z + dee.origin[2]];

    // step toward camera
    const dx = camGeo[0] - gx, dy = camGeo[1] - gy, dz = camGeo[2] - gz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const step = Math.min(gridDef.size[0], gridDef.size[1], gridDef.size[2]) * 0.3;
    const sx = dist > 0 ? gx - dx / dist * step : gx;
    const sy = dist > 0 ? gy - dy / dist * step : gy;
    const sz = dist > 0 ? gz - dz / dist * step : gz;

    const blockIdx = locate(gridDef, sx, sy, sz);
    if (blockIdx >= 0) {
      const info = { blockIndex: blockIdx };
      if (compactVar) {
        const ci = _bsearch(compactVar.indices, blockIdx);
        if (ci >= 0) info.value = compactVar.values[ci];
      }
      return info;
    }
    return null;
  }

  // ── drillhole resolve: hit face → interval ──

  function resolveDrillhole(result) {
    if (!result || !result.object?._holeData) return null;
    const hd = result.object._holeData;
    const trisPerInterval = hd.segments * 2;
    const intervalIdx = Math.floor(result.faceIndex / trisPerInterval);
    if (intervalIdx >= hd.intervals.length) return null;
    const iv = hd.intervals[intervalIdx];
    return {
      holeId: hd.id,
      intervalIndex: intervalIdx,
      from: iv.from,
      to: iv.to,
      value: iv.value,
      category: iv.category,
    };
  }

  function highlightDrillholeInterval(result, drillInfo) {
    clearHighlight();
    if (!result || !drillInfo || !result.object?._holeData) return;
    const hd = result.object._holeData;
    const trisPerInterval = hd.segments * 2;
    const ivIdx = drillInfo.intervalIndex;

    // extract the tube segment vertices for this interval from the geometry
    const posAttr = result.object.geometry.getAttribute('position');
    const vertsPerInterval = hd.segments * 2; // two rings
    const startVert = ivIdx * vertsPerInterval;

    // build a slightly larger wireframe tube around the interval
    const ringVerts = hd.segments;
    const scale = 1.4; // slightly larger than the tube

    // get center of each ring
    const positions = [];
    for (let ring = 0; ring < 2; ring++) {
      const ringStart = startVert + ring * ringVerts;
      // collect ring vertices
      const ringPts = [];
      for (let s = 0; s < ringVerts; s++) {
        const vi = ringStart + s;
        if (vi < posAttr.count) {
          ringPts.push(new THREE.Vector3(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi)));
        }
      }
      if (ringPts.length === 0) continue;

      // compute ring center
      const center = new THREE.Vector3();
      for (const p of ringPts) center.add(p);
      center.divideScalar(ringPts.length);

      // scale ring outward from center
      for (let s = 0; s < ringPts.length; s++) {
        const p = ringPts[s].clone().sub(center).multiplyScalar(scale).add(center);
        positions.push(p);
      }
    }

    if (positions.length < ringVerts * 2) return;

    // build line segments: two rings + connecting lines
    const linePositions = [];
    for (let ring = 0; ring < 2; ring++) {
      const off = ring * ringVerts;
      for (let s = 0; s < ringVerts; s++) {
        const a = positions[off + s], b = positions[off + (s + 1) % ringVerts];
        linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    // connecting lines between rings
    for (let s = 0; s < ringVerts; s += Math.max(1, Math.floor(ringVerts / 4))) {
      const a = positions[s], b = positions[ringVerts + s];
      linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffff00 });
    _highlightMesh = new THREE.LineSegments(geom, mat);
    _highlightMesh._isHighlight = true;
    _highlightMesh.renderOrder = 999;

    // the vertices are in the mesh's local space; apply the mesh's parent group transform
    const parent = result.object.parent;
    if (parent) {
      _highlightMesh.position.copy(parent.position);
    }

    dee.scene.add(_highlightMesh);
    dee.markDirty();
  }

  // binary search in sorted Int32Array
  function _bsearch(arr, target) {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] === target) return mid;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  let _gridFns = null;
  function _getGridFns() {
    if (_gridFns) return _gridFns;
    // try to get grid.locate from global scope
    if (typeof window !== 'undefined' && window._gcu_grid) {
      _gridFns = window._gcu_grid;
      return _gridFns;
    }
    return { locate: null, ijk: null };
  }

  // ── highlight helpers ──

  function highlightBlock(gridDef, blockIndex) {
    clearHighlight();
    const { ijk } = _getGridFns();
    if (!ijk) return;
    const [bi, bj, bk] = ijk(gridDef, blockIndex);
    const s = gridDef.size;

    const pad = 1.05;
    const boxGeom = new THREE.BoxGeometry(s[0] * pad, s[1] * pad, s[2] * pad);
    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    const mat = new THREE.LineBasicMaterial({ color: 0xffff00 });
    _highlightMesh = new THREE.LineSegments(edgesGeom, mat);
    boxGeom.dispose();
    _highlightMesh._isHighlight = true;
    _highlightMesh.renderOrder = 999;

    // position in scene-local space (geological minus origin)
    // scene rotation handles the rest
    const cx = gridDef.origin[0] + bi * s[0] - dee.origin[0];
    const cy = gridDef.origin[1] + bj * s[1] - dee.origin[1];
    const cz = gridDef.origin[2] + bk * s[2] - dee.origin[2];
    _highlightMesh.position.set(cx, cy, cz);

    dee.scene.add(_highlightMesh);
    dee.markDirty();
  }

  function highlightInterval(point, radius) {
    clearHighlight();
    radius = radius || 5;
    const geom = new THREE.RingGeometry(radius * 0.8, radius * 1.2, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00, side: 2, depthTest: false });
    _highlightMesh = new THREE.Mesh(geom, mat);
    _highlightMesh._isHighlight = true;
    // point is in scene-local space (from hit.point via scene inverse)
    // convert back to world space for the highlight (which is a child of scene)
    _highlightMesh.position.copy(point);
    _highlightMesh.lookAt(dee.camera.position);
    dee.scene.add(_highlightMesh);
    dee.markDirty();
  }

  function highlightPoint(point, radius) {
    clearHighlight();
    radius = radius || 3;
    const geom = new THREE.SphereGeometry(radius, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false, transparent: true, opacity: 0.6 });
    _highlightMesh = new THREE.Mesh(geom, mat);
    _highlightMesh._isHighlight = true;
    _highlightMesh.position.copy(point);
    dee.scene.add(_highlightMesh);
    dee.markDirty();
  }

  function clearHighlight() {
    if (_highlightMesh) {
      dee.scene.remove(_highlightMesh);
      _highlightMesh.geometry.dispose();
      _highlightMesh.material.dispose();
      _highlightMesh = null;
      dee.markDirty();
    }
  }

  // ── event wiring ──

  const _callbacks = { click: [], dblclick: [] };
  let _isDragging = false, _mouseDownPos = null;

  container.addEventListener('mousedown', (e) => {
    _mouseDownPos = { x: e.clientX, y: e.clientY };
    _isDragging = false;
  });

  container.addEventListener('mousemove', (e) => {
    if (_mouseDownPos) {
      const dx = e.clientX - _mouseDownPos.x, dy = e.clientY - _mouseDownPos.y;
      if (dx * dx + dy * dy > 9) _isDragging = true; // 3px threshold
    }
  });

  container.addEventListener('mouseup', (e) => {
    if (!_isDragging && _mouseDownPos) {
      const result = _pick(e.clientX, e.clientY);
      for (const fn of _callbacks.click) fn(result);
    }
    _mouseDownPos = null;
    _isDragging = false;
  });

  container.addEventListener('dblclick', (e) => {
    const result = _pick(e.clientX, e.clientY);
    for (const fn of _callbacks.dblclick) fn(result);
  });

  // ── high-level picking helper ──

  function enablePicking(opts = {}) {
    const gridDef = opts.gridDef;
    const compactVar = opts.compactVar;
    const gridFns = opts.grid; // { locate, ijk }
    const formatBlock = opts.formatBlock || _defaultFormatBlock;
    const formatDrillhole = opts.formatDrillhole || _defaultFormatDrillhole;
    const formatOther = opts.formatOther || ((result) => `${result.layer || 'unknown'} — ${result.type || 'object'}`);
    const event = opts.event || 'click';

    if (gridFns) window._gcu_grid = gridFns;

    // create label
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;bottom:8px;left:8px;font:12px monospace;color:#ccc;pointer-events:none;z-index:10;background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:2px;';
    container.appendChild(label);

    const handler = (result) => {
      if (!result) { clearHighlight(); label.textContent = ''; return; }

      if (result.type === 'blockmodel' && gridDef) {
        const info = resolveBlock(result, gridDef, compactVar);
        if (info) {
          highlightBlock(gridDef, info.blockIndex);
          label.textContent = formatBlock(info, gridDef, gridFns);
        }
      } else if (result.type === 'drillholes') {
        const dh = resolveDrillhole(result);
        if (dh) {
          highlightDrillholeInterval(result, dh);
          label.textContent = formatDrillhole(dh);
        }
      } else {
        highlightPoint(result.scenePoint, 3);
        label.textContent = formatOther(result);
      }

      if (opts.onPick) opts.onPick(result);
    };

    _callbacks[event].push(handler);
    return { label, dispose() { label.remove(); clearHighlight(); } };
  }

  function _defaultFormatBlock(info, gridDef, gridFns) {
    if (gridFns?.ijk) {
      const [i, j, k] = gridFns.ijk(gridDef, info.blockIndex);
      return `block [${i},${j},${k}] idx=${info.blockIndex}${info.value != null ? ` val=${info.value.toFixed(2)}` : ''}`;
    }
    return `block idx=${info.blockIndex}${info.value != null ? ` val=${info.value.toFixed(2)}` : ''}`;
  }

  function _defaultFormatDrillhole(dh) {
    return `${dh.holeId} [${dh.from}–${dh.to}m]${dh.value != null ? ` val=${dh.value.toFixed(2)}` : ''}`;
  }

  return {
    pick: _pick,
    resolveBlock,
    resolveDrillhole,
    highlightBlock,
    highlightDrillholeInterval,
    highlightInterval,
    highlightPoint,
    clearHighlight,
    enablePicking,
    on(event, fn) { if (_callbacks[event]) _callbacks[event].push(fn); },
    raycaster,
  };
}
