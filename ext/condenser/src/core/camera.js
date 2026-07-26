// @gcu/condenser — minimal mat4 math + an orbit camera. Raw WebGL2 needs ~four
// matrix ops, not a scene graph (dee's camera is Three-coupled — micro-spec §5
// says borrow the *math*, and the math is textbook, so it lives here).
// Column-major Float32Array(16), GL convention. All coordinates FRAME-LOCAL —
// the document frame keeps magnitudes small enough for f32 uniforms.

export function mat4Perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function mat4Ortho(halfH, aspect, near, far) {
  const halfW = halfH * aspect, m = new Float32Array(16);
  m[0] = 1 / halfW; m[5] = 1 / halfH;
  m[10] = -2 / (far - near); m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

export function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[4] = xy; m[8] = xz; m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[1] = yx; m[5] = yy; m[9] = yz; m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[2] = zx; m[6] = zy; m[10] = zz; m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function mat4Multiply(a, b) {                       // a·b (both column-major)
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return m;
}

// General 4×4 inverse (cofactor expansion, column-major). Used to unproject
// (pixel, depth) → world in the deferred re-shade resolve; the viewProj is
// always invertible for a real camera. Returns null on a singular matrix.
export function mat4Inverse(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) return null;
  const d = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= d;
  return inv;
}

// Frustum planes from a viewProj matrix (Gribb–Hartmann, column-major): six
// [a,b,c,d] rows — a point is inside when a·x+b·y+c·z+d ≥ 0 for all six.
export function frustumPlanes(m) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  return [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), add(r3, r2), sub(r3, r2)];
}

// Conservative AABB-vs-frustum: positive-vertex test — the box is out only when
// its most-positive corner for some plane is still behind that plane.
export function aabbInFrustum(planes, b) {                 // b = [minX,minY,minZ,maxX,maxY,maxZ]
  for (const [a, bb, c, d] of planes) {
    const px = a > 0 ? b[3] : b[0], py = bb > 0 ? b[4] : b[1], pz = c > 0 ? b[5] : b[2];
    if (a * px + bb * py + c * pz + d < 0) return false;
  }
  return true;
}

export function transformPoint(m, p) {                     // m · [p,1] → perspective divide
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/**
 * Orbit camera: target + spherical (radius, theta around Z, phi from the XY
 * plane). Z-up (geology convention). Produces eye/view/proj; near/far adapt to
 * the orbit radius each update (dee's depth-precision trick).
 */
export function createOrbitCamera({ fovY = 45 * Math.PI / 180 } = {}) {
  const c = {
    target: [0, 0, 0], radius: 100, theta: Math.PI / 4, phi: Math.PI / 5, fovY,
    aspect: 1, near: 0.1, far: 1e6,
    ortho: false, halfH: 0,                                // ortho: half-height = radius·tan(fovY/2) — toggling keeps apparent size at the target
    zExag: 1,                                              // vertical exaggeration: a GLOBAL scene z-scale folded into viewProj (all layers stay registered; queries stay in real coords — see update())
    eye: [0, 0, 0], view: null, proj: null, viewProj: null,
  };
  const EPS = 0.01;
  function update() {
    c.phi = Math.max(-Math.PI / 2 + EPS, Math.min(Math.PI / 2 - EPS, c.phi));
    c.radius = Math.max(0.05, c.radius);
    const cp = Math.cos(c.phi);
    c.eye = [
      c.target[0] + c.radius * cp * Math.cos(c.theta),
      c.target[1] + c.radius * cp * Math.sin(c.theta),
      c.target[2] + c.radius * Math.sin(c.phi),
    ];
    // near at radius/4000: on a km-scale fitted model the old /1000 put the
    // clip plane METRES in front of the camera — visible slicing when panning
    // close past geometry. /4000 keeps depth precision under a block size at
    // the far end of a 24-bit buffer (error ~ z²/(near·2²⁴): ~3 m at z=10 km
    // with near 2.5 m) while clipping 4× closer.
    c.near = Math.max(c.radius / 4000, 0.01);
    c.far = c.radius * 100;
    c.view = mat4LookAt(c.eye, c.target, [0, 0, 1]);
    c.halfH = c.radius * Math.tan(c.fovY / 2);
    c.proj = c.ortho ? mat4Ortho(c.halfH, c.aspect, c.near, c.far) : mat4Perspective(c.fovY, c.aspect, c.near, c.far);
    c.viewProj = mat4Multiply(c.proj, c.view);
    // Vertical exaggeration: fold a world-space z-scale into viewProj, pivoted at
    // the target's z (so the look-at point stays fixed). viewProj·M means every
    // vertex is z-scaled AT DRAW ONLY — shaders still test real z for section
    // culling (before viewProj), pick is the ID-buffer (real recIdx), measure
    // reads source records, and unproject uses inverse(viewProj) which yields real
    // coords. One matrix, all layers registered, every query honest.
    if (c.zExag && c.zExag !== 1) {
      const S = c.zExag, tz = c.target[2];                 // z' = tz + (z-tz)·S  ⇒  column-major z-scale about tz
      c.viewProj = mat4Multiply(c.viewProj, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, S, 0, 0, 0, tz * (1 - S), 1]);
    }
    return c;
  }
  return {
    get state() { return c; },
    update,
    setAspect(a) { c.aspect = a || 1; return update(); },
    orbit(dTheta, dPhi) { c.theta += dTheta; c.phi += dPhi; return update(); },
    dolly(f) { c.radius *= f; return update(); },
    pan(dxPx, dyPx, viewportH) {                           // screen px → world at target depth
      const s = 2 * c.radius * Math.tan(c.fovY / 2) / (viewportH || 1);
      const ct = Math.cos(c.theta), st = Math.sin(c.theta), sp = Math.sin(c.phi), cp = Math.cos(c.phi);
      // camera right = (-st, ct, 0); camera up ≈ (-ct·sp, -st·sp, cp)
      c.target[0] += (-st) * (-dxPx * s) + (-ct * sp) * (dyPx * s);
      c.target[1] += (ct) * (-dxPx * s) + (-st * sp) * (dyPx * s);
      // vertical exaggeration stretches displayed z by zExag, so a real-z move
      // shows amplified — divide the up-vector's z contribution by zExag so the
      // grabbed point tracks the cursor 1:1 (M⁻¹ of the up-move; x/y are unscaled).
      // In plan view cp=0 → no change, as it should be.
      c.target[2] += cp * (dyPx * s) / (c.zExag || 1);
      return update();
    },
    setOrtho(on) { c.ortho = !!on; return update(); },
    fit(bbox) {                                            // frame a local-space bbox
      c.target = [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, (bbox[2] + bbox[5]) / 2];
      const dx = bbox[3] - bbox[0], dy = bbox[4] - bbox[1], dz = bbox[5] - bbox[2];
      const d = Math.hypot(dx, dy, dz) || 1;
      c.radius = (d / 2) / Math.tan(c.fovY / 2) * 1.2;
      return update();
    },
  };
}

// Wire standard mouse/touch input onto an orbit camera. Returns a detach fn.
// left-drag orbit · right-drag / shift-drag pan · wheel dolly.
export function attachOrbitInput(canvas, cam, { onChange } = {}) {
  // pointers tracked by id: one = orbit (or pan with right-button/shift),
  // two = the touch grammar — pinch dollies, the centroid pans, twist orbits
  // theta. touch-action:none or the browser eats the gestures first.
  canvas.style.touchAction = 'none';
  const pts = new Map();
  let mode = null, lx = 0, ly = 0;
  let pinch = null;                                        // { span, cx, cy, angle }
  const pinchState = () => {
    const [a, b] = [...pts.values()];
    return {
      span: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };
  const down = (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (pts.size === 2) { pinch = pinchState(); mode = 'pinch'; return; }
    if (pts.size > 2) return;                              // third finger: ignore
    mode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    lx = e.clientX; ly = e.clientY;
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pts.size >= 2) {
      const now = pinchState();
      cam.dolly(pinch.span / now.span > 0 ? pinch.span / now.span : 1);
      cam.pan(now.cx - pinch.cx, now.cy - pinch.cy, canvas.clientHeight);
      let dA = now.angle - pinch.angle;
      if (dA > Math.PI) dA -= 2 * Math.PI;
      if (dA < -Math.PI) dA += 2 * Math.PI;
      if (!cam.state.orbitLock) cam.orbit(-dA, 0);         // twist: grab-the-world (locked views don't twist)
      pinch = now;
      if (onChange) onChange();
      return;
    }
    if (!mode || mode === 'pinch') return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    // orbitLock (state flag): 2D/section-locked views — drags PAN instead of
    // orbiting, so a locked plan/section can't be knocked off-plane by a drag
    if (mode === 'orbit') { if (cam.state.orbitLock) cam.pan(dx, dy, canvas.clientHeight); else cam.orbit(-dx * 0.006, dy * 0.006); }
    else cam.pan(dx, dy, canvas.clientHeight);
    if (onChange) onChange();
  };
  const up = (e) => {
    pts.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    if (pts.size >= 2) { pinch = pinchState(); return; }   // still pinching with others
    if (pts.size === 1) {                                  // pinch → single: re-anchor, no jump
      const rest = [...pts.values()][0];
      mode = 'orbit'; lx = rest.x; ly = rest.y; pinch = null;
      return;
    }
    mode = null; pinch = null;
  };
  const wheel = (e) => { e.preventDefault(); cam.dolly(Math.pow(1.0015, e.deltaY)); if (onChange) onChange(); };
  const ctx = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', ctx);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', ctx);
  };
}
