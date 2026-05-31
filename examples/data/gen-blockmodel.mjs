// Generate a small synthetic block model CSV for trying the Data Workbench.
// Deterministic (seeded). A 20×20×8 regular grid with a radial Au orebody, a
// Cu halo, correlated density, lithology, block dimensions, and a few -9999
// sentinels. Run: node examples/data/gen-blockmodel.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NX = 20, NY = 20, NZ = 8;
const OX = 620000, OY = 7780000, OZ = 400;   // a SIRGAS-ish UTM origin
const DX = 10, DY = 10, DZ = 5;

// mulberry32 — tiny seeded PRNG (deterministic output)
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260531);
const randn = () => { const u = 1 - rng(), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const cx = NX * 0.45, cy = NY * 0.55, cz = NZ * 0.4;   // orebody centre (block units)
const rows = [['X', 'Y', 'Z', 'dx', 'dy', 'dz', 'Au_gpt', 'Cu_pct', 'density', 'LITO'].join(',')];

for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const x = OX + (i + 0.5) * DX, y = OY + (j + 0.5) * DY, z = OZ + (k + 0.5) * DZ;
  const d2 = ((i - cx) / 6) ** 2 + ((j - cy) / 6) ** 2 + ((k - cz) / 3) ** 2;
  const shell = Math.exp(-d2);                                  // 1 at centre → 0 outside
  let au = (0.04 + 5.5 * shell) * Math.exp(randn() * 0.45);     // lognormal grade
  let cu = (0.02 + 1.2 * Math.exp(-d2 * 1.6)) * Math.exp(randn() * 0.5);
  const density = 2.55 + 0.45 * shell + randn() * 0.05;         // ore is denser
  const lito = au > 1.0 ? 'BIF' : (k < 2 ? 'OXIDE' : (rng() < 0.5 ? 'SHALE' : 'WASTE'));
  au = Math.max(0, au); cu = Math.max(0, cu);
  // ~1.5% missing assays (sentinel) — exercise NULL handling
  const auCell = rng() < 0.015 ? '-9999' : au.toFixed(3);
  rows.push([x, y, z, DX, DY, DZ, auCell, cu.toFixed(3), density.toFixed(3), lito].join(','));
}

const out = path.join(here, 'blockmodel-sample.csv');
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`wrote ${rows.length - 1} blocks → ${path.relative(path.join(here, '../..'), out)}`);
