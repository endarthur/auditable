import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');

const modules = [
  'geometry.js',
  'selection.js',
  'compact.js',
  'operations.js',
  'spatial.js',
];

let output = '// @gcu/grid — built from src/\n';

for (const mod of modules) {
  let src = readFileSync(join(srcDir, mod), 'utf8');
  // strip import/export statements
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+\*/gm, '// export *');
  src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
  output += `\n// ── ${mod} ──\n\n${src.trim()}\n`;
}

// add export block
output += `
// ── exports ──
export {
  // geometry
  ijk, flatIndex, isValid, ijkBatch, flatIndexBatch,
  centroid, corners, centroids, centroidsSubset,
  locate, locateBatch,
  nBlocks, blockVolume, boundingBox, isCompatible, subgrid,
  _rotMatrix, _applyRot, _invertRot,
  // selection
  maskToIndices, indicesToMask,
  union, intersection, difference, invert, maskCount, equal,
  scatter, gather, take, reindex,
  maskAbove, maskBelow, maskBetween, maskFromClassification,
  maskWhere, maskAboveValue, maskBelowValue, maskEqualTo, maskInRange, maskNotNaN,
  // compact
  align, reduce, dilute, sum, mean, min, max, countPresent,
  unionIndices, intersectionIndices, differenceIndices, restrict,
  dominantDomain, domainFromCategorical,
  // operations
  map, mapMasked, combine, stats, histogram, weightedStats, gradeTonnage, swathPlot,
  // spatial
  column, sliceI, sliceJ, sliceK, slicePlane,
  shellGrid, erodeGrid, dilateGrid,
  nearestPopulated, nearestPopulatedBatch,
  upscale, downscale, regrid,
};
`;

writeFileSync(join(__dirname, 'index.js'), output);
console.log(`Built ext/grid/index.js (${(output.length / 1024).toFixed(1)} KB)`);
