# @gcu/dee

3D scene layer for mining and geostatistics visualization. Uses Three.js internally with geological Z-up convention.

## Status

Working: scene setup, coordinate recentering, camera controls (orbit/pan/zoom, plan/section presets), block model rendering (via @gcu/voxmesh), drillhole rendering (minimum curvature desurvey), point clouds, surfaces, polylines, color maps (continuous/categorical), colorbar, clipping planes, HUD (bounding box, north arrow, scale bar), on-demand rendering, screenshot.

## Picking — current state

**Use Three.js Raycaster for picking.** The GPU pick buffer approach (custom ShaderMaterial writing per-face IDs to an offscreen render target) was attempted extensively but has unresolved issues with Three.js r170's attribute binding/caching when swapping between normal materials and custom ShaderMaterials within the same frame. Symptoms: random per-frame face dropout in the pick buffer, inconsistent attribute binding for custom `aPickColor` vec4 attribute.

The existing GPU pick infrastructure (`pick.allocateIds`, `pick.registerLayer`, `pick.on('hover')`, per-layer resolve functions) is wired up but produces unreliable results. The code is preserved for future investigation.

**Raycaster approach:** Three.js's built-in `Raycaster` works with any material type, uses the CPU-side geometry, and is proven reliable. For block models with greedy-merged shells (~10-30K triangles), raycasting is fast enough for hover/click at 60fps. For million-triangle surfaces, spatial indexing (BVH) may be needed — Three.js has `computeBoundsTree()` via the three-mesh-bvh extension.

### What to investigate later (GPU picking)

1. **premultipliedAlpha** — the WebGL canvas defaults to `premultipliedAlpha: true`. Fragments with alpha=0 (which all pick IDs below 16M produce) become invisible on the canvas. The render target stores raw values, but `debugCanvas` visualization was affected. Creating the renderer with `premultipliedAlpha: false` or always outputting alpha=1.0 in the pick shader fixes visualization but doesn't fix the face dropout.

2. **ShaderMaterial attribute binding** — Three.js caches VAOs per (geometry, program) pair. Swapping between MeshPhongMaterial and a custom ShaderMaterial on the same geometry within the same frame may cause stale VAO state. The `aPickColor` attribute appears to not bind reliably for all meshes.

3. **Possible fix directions:**
   - Use `RawShaderMaterial` with explicit GLSL 300 es and verify attribute binding
   - Use a separate Three.js `Scene` for the pick pass (avoid material swapping entirely)
   - Use `WebGLRenderer.renderBufferDirect()` for fine-grained control
   - Investigate Three.js source for VAO cache invalidation on material change

## Architecture

```
ext/dee/
  src/
    scene.js   — scene setup, render loop, controls, pick system
    layers.js  — block model, drillholes, points, surfaces, polylines, clipping
    color.js   — color maps, palettes, colorbar
    hud.js     — north arrow, scale bar, coordinate readout, axes, bounding box
    main.js    — exports
  build.js     — concatenates src/ into index.js
  index.js     — BUILD OUTPUT
```

## Dependencies

- Three.js (loaded at runtime via esm.sh or bundled)
- @gcu/voxmesh (block model mesh data)
- @gcu/grid (grid definitions, bounding box)
