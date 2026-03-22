// Tyler / ASTM mesh ↔ µm lookup table

const TABLE = [
  { mesh: 635, aperture_um: 20 },
  { mesh: 500, aperture_um: 25 },
  { mesh: 450, aperture_um: 32 },
  { mesh: 400, aperture_um: 38 },
  { mesh: 325, aperture_um: 45 },
  { mesh: 270, aperture_um: 53 },
  { mesh: 230, aperture_um: 63 },
  { mesh: 200, aperture_um: 75 },
  { mesh: 170, aperture_um: 90 },
  { mesh: 150, aperture_um: 106 },
  { mesh: 120, aperture_um: 125 },
  { mesh: 100, aperture_um: 150 },
  { mesh: 80,  aperture_um: 180 },
  { mesh: 70,  aperture_um: 212 },
  { mesh: 60,  aperture_um: 250 },
  { mesh: 50,  aperture_um: 300 },
  { mesh: 45,  aperture_um: 355 },
  { mesh: 40,  aperture_um: 425 },
  { mesh: 35,  aperture_um: 500 },
  { mesh: 30,  aperture_um: 600 },
  { mesh: 25,  aperture_um: 710 },
  { mesh: 20,  aperture_um: 850 },
  { mesh: 18,  aperture_um: 1000 },
  { mesh: 16,  aperture_um: 1180 },
  { mesh: 14,  aperture_um: 1400 },
  { mesh: 12,  aperture_um: 1700 },
  { mesh: 10,  aperture_um: 2000 },
  { mesh: 8,   aperture_um: 2360 },
  { mesh: 7,   aperture_um: 2800 },
  { mesh: 6,   aperture_um: 3350 },
  { mesh: 5,   aperture_um: 4000 },
  { mesh: 4,   aperture_um: 4750 },
];

// index by mesh number for O(1) lookup
const BY_MESH = {};
for (const row of TABLE) BY_MESH[row.mesh] = row.aperture_um;

const sieve = {
  toMicrons(mesh) {
    const um = BY_MESH[mesh];
    if (um === undefined) throw new Error(`unknown mesh: ${mesh}`);
    return um;
  },

  toMesh(um) {
    // exact match first
    for (const row of TABLE) {
      if (row.aperture_um === um) return row.mesh;
    }
    // nearest
    let best = TABLE[0], bestDist = Math.abs(TABLE[0].aperture_um - um);
    for (let i = 1; i < TABLE.length; i++) {
      const d = Math.abs(TABLE[i].aperture_um - um);
      if (d < bestDist) { best = TABLE[i]; bestDist = d; }
    }
    return { nearest: best.mesh, exact: false, aperture_um: best.aperture_um };
  },

  toCm(mesh) {
    return sieve.toMicrons(mesh) / 10000;
  },

  table() {
    return TABLE.map(r => ({ ...r }));
  },
};

export { sieve };
