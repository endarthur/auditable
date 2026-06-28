// moncad viewport — the camera / transform. Pure: no DOM, no WebGL.
//
// Maps the working (LOCAL) frame to screen pixels and back, and owns pan/zoom. The
// renderer feeds `uniforms()` to the GPU (pan/zoom is just a uniform update — no
// redraw); the overlay and input loop use toScreen/toWorld directly. Frame-aware by
// staying in LOCAL coordinates (small magnitudes); world (UTM) is reconstructed via
// @gcu/frame only at the readout edge, never here — that's the whole precision point.
//
// Screen space is device pixels, origin top-left, y down. Local world is y-up (CAD).

export class Viewport {
  constructor({ width = 800, height = 600, center = [0, 0], scale = 1, dpr = 1 } = {}) {
    this.width = width;          // device px
    this.height = height;        // device px
    this.center = [center[0], center[1]];   // local-world point at screen centre
    this.scale = scale;          // device px per local unit
    this.dpr = dpr;
  }

  resize(width, height, dpr = this.dpr) { this.width = width; this.height = height; this.dpr = dpr; return this; }

  // local-world → screen (device px, y-down)
  toScreen(p) {
    return [this.width * 0.5 + (p[0] - this.center[0]) * this.scale,
      this.height * 0.5 - (p[1] - this.center[1]) * this.scale];
  }

  // screen (device px) → local-world
  toWorld(s) {
    return [this.center[0] + (s[0] - this.width * 0.5) / this.scale,
      this.center[1] - (s[1] - this.height * 0.5) / this.scale];
  }

  // pan by a screen-pixel delta (a drag): move the centre opposite the drag
  panBy(dxPx, dyPx) {
    this.center[0] -= dxPx / this.scale;
    this.center[1] += dyPx / this.scale;     // screen y-down → world y-up
    return this;
  }

  // zoom by `factor`, keeping the local-world point under `screenPt` pinned (zoom to cursor)
  zoomAt(screenPt, factor) {
    const before = this.toWorld(screenPt);
    this.scale *= factor;
    const after = this.toWorld(screenPt);
    this.center[0] += before[0] - after[0];
    this.center[1] += before[1] - after[1];
    return this;
  }

  // fit a local-world bounds { min:[x,y], max:[x,y] } into the viewport with a margin
  fit(bounds, margin = 0.08) {
    const w = Math.max(bounds.max[0] - bounds.min[0], 1e-9);
    const h = Math.max(bounds.max[1] - bounds.min[1], 1e-9);
    this.scale = Math.min(this.width * (1 - 2 * margin) / w, this.height * (1 - 2 * margin) / h);
    this.center = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
    return this;
  }

  // the uniforms the WebGL2 renderer needs (the entire pan/zoom state in three values)
  uniforms() { return { center: this.center, scale: this.scale, res: [this.width, this.height] }; }
}
