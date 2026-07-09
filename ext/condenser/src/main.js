// @gcu/condenser — streaming no-preprocess renderer for massive spatial elements.
// The engine under micro (the scope over lamina's slide). Curated public surface.
export { LasFormatError, parseLasHeader, decodeLasRecords, openLas } from './las.js';
export { mulberry32, shuffledIndices, shuffleInPlace, documentFrame, buildChunk, chunkLocalPosition, createChunkBuilder } from './chunks.js';
export { part1by2, mortonKey, mortonKeys, radixSortIndices } from './morton.js';
export { inferAxis, makeBlockGrid, buildBlockChunk, blockLocalCenter, createBlockChunkBuilder } from './blocks.js';
export { floatGcd, axisMap, gridsCompatible, makeResampler, makeBoxAggregator, commonLattice } from './grid-join.js';
export { sniffDelimited, mapColumns, openBlockModel, lineFields, fetchDelimitedRecord } from './blockmodel.js';
export { classifyDrillholeHeader, sniffDrillholeFiles, readDelimited, openDrillholes, openDrillholeTraces } from './drillholes.js';
export { buildStickChunk, stickLocalCenter, createStickChunkBuilder } from './sticks.js';
export { createSticksPipeline } from './gl-sticks.js';
export { openMsh, openObj, openPlyMesh, buildMeshChunk } from './mesh.js';
export { createMeshPipeline } from './gl-mesh.js';
export { buildSoupChunk, soupLocalCentroid, createSoupChunkBuilder, soupFromMesh, openPlySoup } from './soup.js';
export { createSoupPipeline } from './gl-soup.js';
export { categoryPalettePixels, createBlocksPipeline } from './gl-blocks.js';
export { createPickPipeline } from './gl-pick.js';
export { openDmModel, fetchDmRecord, peekDmColumns, dmWireframeRole, openDmWireframe } from './dm-provider.js';
export { parsePlyHeader, openPly } from './ply.js';
export { mat4Perspective, mat4Ortho, mat4LookAt, mat4Multiply, transformPoint, frustumPlanes, aabbInFrustum, createOrbitCamera, attachOrbitInput } from './camera.js';
export { makeProgram, rampPixels, palettePixels, uploadChunk, createRenderer } from './gl.js';
export { createEdl } from './edl.js';
export { writeMSH } from '../../msh/msh.js';   // mesh export (micro): the ARANZ writer rides the already-inlined @gcu/msh
