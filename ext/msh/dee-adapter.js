// @gcu/msh/dee-adapter — wire a readMSH result into a @gcu/dee scene
// with the rendering conventions a geological-mesh viewer needs:
//
//   • Vertices recentred in F64 before the f32 downcast, so f32 storage
//     holds local-scale values (cm precision at scene extents) instead
//     of UTM-scale values (~0.5m precision at 5M-northing). Same
//     mechanic as the LFM adapter — see lfm/dee-adapter.js for the full
//     rationale.
//   • Single-mesh-per-file: unlike LFM (which contains many meshes
//     with stored colours / volumes / attributes and produces a sorted
//     layer set), an MSH file gives us one mesh and no metadata. The
//     caller supplies colour and ordering — typically by loading
//     several .msh domains (HG / LG / waste / overburden) and passing
//     different { color, renderOrder, polygonOffset } per call.
//   • Optional luminance floor on the supplied colour so a black-coded
//     mesh stays visible against a dark background. Defaults match
//     the LFM adapter's behaviour.
//
// Optional import — the msh package main is just msh.js (parser +
// writer). This file is the glue for consumers that also use @gcu/dee.
//
// SPDX-License-Identifier: BSD-3-Clause

import { floorRenderColor } from '../dee/src/color.js';

/**
 * Compute the axis-aligned bbox centroid of an MSH result's vertices.
 * Use the return as `dee.create({ origin: ... })` before adding the
 * MSH layer — keeps absolute-UTM joins (drillholes, block models,
 * sibling .msh / .lfm meshes) aligned with the recentred surface.
 *
 * For workflows loading multiple MSH files, compute the centroid over
 * the UNION of their bboxes once (manually or via {@link mshUnionCentroid})
 * and pass that single origin to every adapter call.
 *
 * @param {import('./msh.js').MSHResult} mshResult
 * @returns {[number, number, number]}
 */
export function mshCentroid(mshResult) {
  const v = mshResult.vertices;
  if (!v || v.length === 0) return [0, 0, 0];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/**
 * Compute the union-bbox centroid across multiple MSH results. For
 * scenes loading several .msh domains (e.g. HG + LG + waste), pass the
 * full array here, use the return as the scene origin, then call
 * `addMSHtoDee` for each result with the same scene.
 *
 * @param {import('./msh.js').MSHResult[]} mshResults
 * @returns {[number, number, number]}
 */
export function mshUnionCentroid(mshResults) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const r of mshResults) {
    const v = r.vertices;
    if (!v || v.length === 0) continue;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/**
 * Add an MSH result as a single dee surface layer.
 *
 * Expected setup: `dee.create({ origin: mshCentroid(mshResult) })` (or
 * the union centroid across all .msh files in the scene). The adapter
 * pre-subtracts dee.origin from each vertex in F64 so f32 precision
 * survives — passes `localCoords: true` to addSurface so its group
 * transform doesn't re-apply the offset.
 *
 * Returns the dee layer handle, with a `_meta` field carrying the
 * file's array map and binary signature for round-trip workflows.
 *
 * Pass-through options forwarded to `dee.addSurface`: opacity,
 * doubleSided, wireframe, pickable, clippingPlanes. Anything else in
 * `opts.surface` is also forwarded (advanced override).
 *
 * @param {object} dee - a @gcu/dee instance
 * @param {import('./msh.js').MSHResult} mshResult
 * @param {object} [opts]
 * @param {string} [opts.name='msh']             Layer name.
 * @param {number|{r:number,g:number,b:number}} [opts.color=0x808080]
 *      Render colour. Number 0xRRGGBB or {r,g,b} (0-255).
 * @param {number} [opts.opacity=1]
 * @param {boolean} [opts.doubleSided=true]
 * @param {boolean} [opts.wireframe=false]
 * @param {boolean} [opts.pickable=true]
 * @param {number} [opts.renderOrder=0]          Three.js render order
 *      (more-negative draws first). For multi-MSH scenes, sort larger
 *      volumes to more-negative values so they draw behind nested
 *      ones for correct alpha compositing.
 * @param {number} [opts.polygonOffset=0]        Per-mesh rank for
 *      z-fighting at shared contacts (smaller wins).
 * @param {object} [opts.surface]                Extra addSurface opts
 *      to forward.
 * @param {object} [opts.luminance]              { threshold, substitute }
 *      for the floorRenderColor pass; pass `{threshold: 0}` to disable.
 * @returns {object} dee layer handle
 */
export function addMSHtoDee(dee, mshResult, opts = {}) {
  const vertices = mshResult.vertices;
  const triangles = mshResult.triangles;
  if (!vertices || !triangles) {
    throw new Error('addMSHtoDee: result has no vertices/triangles — needs a Double-3 + Integer-3 array pair');
  }

  const [ox, oy, oz] = dee.origin || [0, 0, 0];

  // Recentre vertices in F64 before passing to addSurface — the f32
  // downcast inside addSurface then operates on small magnitudes.
  const recentred = new Float64Array(vertices.length);
  for (let k = 0; k < vertices.length; k += 3) {
    recentred[k]     = vertices[k]     - ox;
    recentred[k + 1] = vertices[k + 1] - oy;
    recentred[k + 2] = vertices[k + 2] - oz;
  }

  // Normalise the colour input and floor low-luminance values.
  const rawColor = opts.color ?? 0x808080;
  const floored = floorRenderColor(rawColor, opts.luminance);
  const colorInt = typeof floored === 'number'
    ? floored
    : Array.isArray(floored)
      ? ((floored[0] & 0xff) << 16) | ((floored[1] & 0xff) << 8) | (floored[2] & 0xff)
      : ((floored.r & 0xff) << 16) | ((floored.g & 0xff) << 8) | (floored.b & 0xff);

  const layer = dee.addSurface(opts.name ?? 'msh', {
    positions: recentred,
    indices: triangles,
    color: colorInt,
    opacity: opts.opacity ?? 1,
    doubleSided: opts.doubleSided !== false,
    wireframe: !!opts.wireframe,
    pickable: opts.pickable !== false,
    renderOrder: opts.renderOrder ?? 0,
    polygonOffset: opts.polygonOffset ?? 0,
    localCoords: true, // we already recentred
    ...(opts.surface || {}),
  });

  // Preserve provenance so round-trip writers / UI panels can reach
  // the file's full array set + the opaque binary signature.
  layer._meta = {
    arrays: mshResult.arrays,
    binarySignature: mshResult.binarySignature,
    version: mshResult.version,
    vCount: vertices.length / 3 | 0,
    tCount: triangles.length / 3 | 0,
  };
  return layer;
}
