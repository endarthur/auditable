// @gcu/condenser/core — the render engine alone: chunk builders + GL pipelines
// + camera + EDL + Morton. Zero I/O, zero providers; @gcu/frame is the one
// inlined leaf (every chunk is frame-relative). The full package (main.js)
// re-exports this same surface plus io/ + grid/.
export { mulberry32, shuffledIndices, shuffleInPlace, documentFrame, buildChunk, chunkLocalPosition, createChunkBuilder } from './core/chunks.js';
export { part1by2, mortonKey, mortonKeys, radixSortIndices } from './core/morton.js';
export { makeBlockGrid, buildBlockChunk, blockLocalCenter, createBlockChunkBuilder } from './core/blocks.js';
export { buildStickChunk, stickLocalCenter, createStickChunkBuilder } from './core/sticks.js';
export { buildMeshChunk, buildHeightfieldMesh } from './core/mesh-geom.js';
export { buildSoupChunk, soupLocalCentroid, createSoupChunkBuilder, soupFromMesh } from './core/soup-geom.js';
export { createSticksPipeline } from './core/gl-sticks.js';
export { createMeshPipeline } from './core/gl-mesh.js';
export { createSoupPipeline } from './core/gl-soup.js';
export { categoryPalettePixels, createBlocksPipeline } from './core/gl-blocks.js';
export { createPickPipeline, layerOfId, faceOfId, isMiss, NO_FACE, FACE_CUT, FACE_NORMALS, FACE_NAMES } from './core/gl-pick.js';
export { mat4Perspective, mat4Ortho, mat4LookAt, mat4Multiply, transformPoint, frustumPlanes, aabbInFrustum, createOrbitCamera, attachOrbitInput } from './core/camera.js';
export { makeProgram, rampPixels, palettePixels, uploadChunk, createRenderer } from './core/gl.js';
export { createEdl } from './core/edl.js';
