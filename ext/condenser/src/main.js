// @gcu/condenser — streaming no-preprocess renderer for massive spatial elements.
// The engine under micro (the scope over lamina's slide). Curated public surface.
//
// Three layers (see core.js for the engine-only entry):
//   core/ — chunk builders + GL pipelines + camera + EDL + Morton. Zero I/O.
//   io/   — file providers (LAS, PLY, delimited/dm block models, drillholes, meshes).
//   grid/ — lattice inference + the join/resample/reconcile engine.
export { LasFormatError, parseLasHeader, decodeLasRecords, openLas } from './io/las.js';
export { mulberry32, shuffledIndices, shuffleInPlace, documentFrame, buildChunk, chunkLocalPosition, createChunkBuilder } from './core/chunks.js';
export { part1by2, mortonKey, mortonKeys, radixSortIndices } from './core/morton.js';
export { makeBlockGrid, buildBlockChunk, blockLocalCenter, createBlockChunkBuilder } from './core/blocks.js';
export { inferAxis } from './grid/infer.js';
export { floatGcd, axisMap, gridsCompatible, makeResampler, makeBoxAggregator, commonLattice } from './grid/grid-join.js';
export { sniffDelimited, mapColumns, openBlockModel, openTable, lineFields, fetchDelimitedRecord } from './io/blockmodel.js';
export { classifyDrillholeHeader, sniffDrillholeFiles, readDelimited, openDrillholes, openDrillholeTraces } from './io/drillholes.js';
export { buildStickChunk, stickLocalCenter, createStickChunkBuilder } from './core/sticks.js';
export { createSticksPipeline } from './core/gl-sticks.js';
export { openMsh, openObj, openPlyMesh } from './io/mesh-io.js';
export { buildMeshChunk, buildHeightfieldMesh } from './core/mesh-geom.js';
export { createMeshPipeline } from './core/gl-mesh.js';
export { buildSoupChunk, soupLocalCentroid, createSoupChunkBuilder, soupFromMesh } from './core/soup-geom.js';
export { openPlySoup } from './io/soup-io.js';
export { createSoupPipeline } from './core/gl-soup.js';
export { categoryPalettePixels, createBlocksPipeline } from './core/gl-blocks.js';
export { createPickPipeline, layerOfId, faceOfId, isMiss, NO_FACE, FACE_CUT, FACE_NORMALS, FACE_NAMES } from './core/gl-pick.js';
export { openDmModel, fetchDmRecord, peekDmColumns, dmWireframeRole, openDmWireframe } from './io/dm-provider.js';
export { parsePlyHeader, openPly } from './io/ply.js';
export { mat4Perspective, mat4Ortho, mat4LookAt, mat4Multiply, transformPoint, frustumPlanes, aabbInFrustum, createOrbitCamera, attachOrbitInput } from './core/camera.js';
export { makeProgram, rampPixels, palettePixels, uploadChunk, createRenderer } from './core/gl.js';
export { createEdl } from './core/edl.js';
export { writeMSH } from '../../msh/msh.js';   // mesh export (micro): the ARANZ writer rides the already-inlined @gcu/msh
