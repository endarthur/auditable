import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');

const modules = [
  'color.js',
  'layers.js',
  'hud.js',
  'raycast.js',
  'scene.js',
];

let output = '// @gcu/dee — built from src/\n';

for (const mod of modules) {
  let src = readFileSync(join(srcDir, mod), 'utf8');
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+\*/gm, '// export *');
  src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
  output += `\n// ── ${mod} ──\n\n${src.trim()}\n`;
}

// wire layer functions into create() — replace stubs
output = output.replace(
  'function _addBlockModelLayer() {}',
  'function _addBlockModelLayer(dee, name, meshes, opts) { return addBlockModelLayer(dee, name, meshes, opts); }'
);
output = output.replace(
  'function _addSectionLayer() {}',
  'function _addSectionLayer(dee, name, mesh, opts) { return addSectionLayer(dee, name, mesh, opts); }'
);
output = output.replace(
  'function _addPointsLayer() {}',
  'function _addPointsLayer(dee, name, opts) { return addPointsLayer(dee, name, opts); }'
);
output = output.replace(
  'function _addDrillholeLayer() {}',
  'function _addDrillholeLayer(dee, name, opts) { return addDrillholeLayer(dee, name, opts); }'
);
output = output.replace(
  'function _addSurfaceLayer() {}',
  'function _addSurfaceLayer(dee, name, opts) { return addSurfaceLayer(dee, name, opts); }'
);
output = output.replace(
  'function _addPolylinesLayer() {}',
  'function _addPolylinesLayer(dee, name, opts) { return addPolylinesLayer(dee, name, opts); }'
);
output = output.replace(
  'function _addClipPlane() {}',
  'function _addClipPlane(dee, opts) { return addClipPlane(dee, opts); }'
);

// HUD and raycaster wired in scene.js create() via typeof checks

output += `
// ── exports ──
export {
  create,
  colorMap, categoricalMap, colorBar, floorRenderColor,
  addBlockModelLayer, addSectionLayer, addPointsLayer,
  addDrillholeLayer, addSurfaceLayer, addPolylinesLayer, addClipPlane,
  desurvey, interpolatePath,
  createHUD, createRaycaster,
};
`;

writeFileSync(join(__dirname, 'index.js'), output);
console.log(`Built ext/dee/index.js (${(output.length / 1024).toFixed(1)} KB)`);
