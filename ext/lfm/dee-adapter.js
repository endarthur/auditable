// @gcu/lfm/dee-adapter — wire a readLFM result into a @gcu/dee scene
// with the conventions a geological-mesh viewer needs:
//
//   • Vertices recentred in F64 before the f32 downcast, so f32 storage
//     holds local-scale values (cm precision at scene extents) instead
//     of UTM-scale values (~0.5m precision at 5M-northing).
//   • renderOrder = -volume so largest containing meshes draw first
//     (Three.js sorts transparent renderables ascending; negative
//     volume → most negative → drawn first → behind smaller nested
//     volumes for correct alpha compositing).
//   • polygonOffset rank by ascending volume so the smallest (cutting)
//     mesh wins at shared contact surfaces — matches Leapfrog's
//     "cutting unit owns the contact" convention.
//   • Render colour floored at Rec.601 luminance 40 so black-coded
//     classes ("Embasamento" etc.) are visible against a dark
//     background. The file's stored RGB is preserved on the layer's
//     _meta so swatches / round-trip exports can still see it.
//
// Optional import — the lfm package main is just lfm.js (parser +
// writer). This file is the glue for consumers that also use @gcu/dee.
//
// SPDX-License-Identifier: BSD-3-Clause

import { floorRenderColor } from '../dee/src/color.js';

/**
 * Compute the axis-aligned bbox centroid across every vertex in every
 * mesh of an LFM result. Use the return as `dee.create({ origin: ... })`
 * before adding LFM layers — keeps absolute-UTM joins (drillholes,
 * block models) aligned with the recentred LFM surfaces.
 *
 * @param {import('./lfm.js').LFMResult} lfmResult
 * @returns {[number, number, number]}
 */
export function lfmCentroid(lfmResult) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of lfmResult.meshes) {
    const v = m.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0]; // empty input
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/**
 * Add every mesh in an LFM result as a dee surface layer with the
 * ordering / polygon-offset / render-colour conventions described above.
 *
 * Expected setup: `dee.create({ origin: lfmCentroid(lfmResult) })`. The
 * adapter pre-subtracts dee.origin from each vertex in F64 so f32
 * precision survives — passes `localCoords: true` to addSurface so its
 * group transform doesn't re-apply the offset.
 *
 * Returns the array of layer handles in source order (matching
 * lfmResult.meshes). Each layer carries a `_meta` field with the file's
 * stored colour, the meshAttribute name→value map, and the parsed
 * volume in m³.
 *
 * Pass-through options forwarded to `dee.addSurface`: opacity,
 * doubleSided, wireframe, pickable, clippingPlanes. Anything else in
 * `opts.surface` is also forwarded (advanced override).
 *
 * @param {object} dee - a @gcu/dee instance
 * @param {import('./lfm.js').LFMResult} lfmResult
 * @param {object} [opts]
 * @param {number} [opts.opacity=1]
 * @param {boolean} [opts.doubleSided=true]
 * @param {boolean} [opts.wireframe=false]
 * @param {boolean} [opts.pickable=true]
 * @param {object} [opts.surface] - additional addSurface opts to forward
 * @param {object} [opts.luminance] - { threshold, substitute } for the
 *                 floorRenderColor pass
 * @returns {object[]} layer handles
 */
export function addLFMtoDee(dee, lfmResult, opts = {}) {
  const meshes = lfmResult.meshes;
  if (!meshes || !meshes.length) return [];

  const [ox, oy, oz] = dee.origin || [0, 0, 0];

  // Volume attribute is stored as a string; coerce. Missing → 0, which
  // sorts to "smallest rank" (drawn last by ascending renderOrder, wins
  // at contacts). Reasonable default for unranked meshes.
  const volumes = meshes.map(m => {
    const v = parseFloat(m.attributes?.Volume);
    return Number.isFinite(v) ? v : 0;
  });

  // Sort by volume ascending → rank by sort position. Smallest volume
  // = rank 0 = polygonOffsetUnits 0 → cutting unit wins at contacts.
  const sortedIdx = meshes.map((_, i) => i).sort((a, b) => volumes[a] - volumes[b]);
  const ranks = new Array(meshes.length);
  for (let r = 0; r < sortedIdx.length; r++) ranks[sortedIdx[r]] = r;

  const layers = [];
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];

    // Recentre vertices in F64 before passing to addSurface — the f32
    // downcast inside addSurface then operates on small magnitudes.
    const recentred = new Float64Array(m.vertices.length);
    for (let k = 0; k < m.vertices.length; k += 3) {
      recentred[k]     = m.vertices[k]     - ox;
      recentred[k + 1] = m.vertices[k + 1] - oy;
      recentred[k + 2] = m.vertices[k + 2] - oz;
    }

    const floored = floorRenderColor(m.colour, opts.luminance);
    const colorInt = ((floored.r & 0xff) << 16) | ((floored.g & 0xff) << 8) | (floored.b & 0xff);

    const layer = dee.addSurface(m.name, {
      positions: recentred,
      indices: m.triangles,
      color: colorInt,
      opacity: opts.opacity ?? 1,
      doubleSided: opts.doubleSided !== false,
      wireframe: !!opts.wireframe,
      pickable: opts.pickable !== false,
      // Largest volume → most negative renderOrder → drawn first.
      // Three.js sorts ascending within transparency groups, so
      // negative-volume entries draw behind 0-renderOrder content.
      renderOrder: -volumes[i],
      // Smaller rank wins at contact surfaces (smaller polygonOffset
      // = closer to camera in depth-buffer terms).
      polygonOffset: ranks[i],
      localCoords: true, // we already recentred
      ...(opts.surface || {}),
    });

    // Preserve provenance for UI panels / round-trip exports — the
    // file's stored colour is what should round-trip, not the render
    // colour (which is just the display floor).
    layer._meta = {
      storedColour: m.colour,
      attributes: m.attributes,
      volume: volumes[i],
      vCount: m.vCount,
      tCount: m.tCount,
    };
    layers.push(layer);
  }

  return layers;
}
