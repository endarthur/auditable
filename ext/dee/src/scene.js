// @gcu/dee — scene setup, render loop, disposal

export function create(container, opts = {}) {
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

function _addBlockModelLayer() {}
function _addSectionLayer() {}
function _addPointsLayer() {}
function _addDrillholeLayer() {}
function _addSurfaceLayer() {}
function _addPolylinesLayer() {}
function _addClipPlane() {}
