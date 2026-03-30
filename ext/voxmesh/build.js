import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');

const modules = [
  'bin.js',
  'chunk.js',
  'bucket.js',
  'mesh.js',
  'convenience.js',
];

let output = '// @gcu/voxmesh — built from src/\n';

for (const mod of modules) {
  let src = readFileSync(join(srcDir, mod), 'utf8');
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+\*/gm, '// export *');
  src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
  output += `\n// ── ${mod} ──\n\n${src.trim()}\n`;
}

output += `
// ── exports ──
export {
  // binning
  binBreaks, binQuantiles, discretize,
  // chunking
  chunk, chunkId, chunkRange,
  // bucketing
  bucket, addGhosts,
  // meshing
  meshChunk, meshAll, meshSection,
  // convenience
  prepare, diffBins, rebin,
};
`;

writeFileSync(join(__dirname, 'index.js'), output);
console.log(`Built ext/voxmesh/index.js (${(output.length / 1024).toFixed(1)} KB)`);
