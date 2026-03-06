import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEM, haversine } from '../ext/spinifex/src/dem.js';
import { tileKey, tileUrl, tilesForBbox } from '../ext/spinifex/src/srtm.js';
import { terrainColor } from '../ext/spinifex/src/render.js';
import { detectColumn, LON_PATTERNS, LAT_PATTERNS } from '../ext/spinifex/src/loaders.js';

// ── DEM constructor ──

describe('DEM constructor', () => {
  it('computes min/max excluding nodata', () => {
    const data = new Float32Array([100, 200, -9999, 150]);
    const dem = new DEM(data, 2, 2, [0, 0, 1, 1]);
    assert.strictEqual(dem.min, 100);
    assert.strictEqual(dem.max, 200);
  });

  it('handles all-nodata', () => {
    const data = new Float32Array([-9999, -9999, -9999, -9999]);
    const dem = new DEM(data, 2, 2, [0, 0, 1, 1]);
    assert.strictEqual(dem.min, 0);
    assert.strictEqual(dem.max, 0);
  });

  it('handles single valid value', () => {
    const data = new Float32Array([-9999, 42, -9999, -9999]);
    const dem = new DEM(data, 2, 2, [0, 0, 1, 1]);
    assert.strictEqual(dem.min, 42);
    assert.strictEqual(dem.max, 42);
  });
});

// ── DEM.sample ──

describe('DEM.sample', () => {
  // 3x3 grid over [0,0]–[1,1]:
  //   row 0 (north): 900  800  700
  //   row 1 (mid):   600  500  400
  //   row 2 (south): 300  200  100
  const data = new Float32Array([
    900, 800, 700,
    600, 500, 400,
    300, 200, 100
  ]);
  const dem = new DEM(data, 3, 3, [0, 0, 1, 1]);

  it('returns exact value at grid corners', () => {
    // NW corner: lat=1 (north), lon=0 (west) → row 0, col 0
    assert.strictEqual(dem.sample(1, 0), 900);
    // SE corner: lat=0 (south), lon=1 (east) → row 2, col 2
    assert.strictEqual(dem.sample(0, 1), 100);
    // NE corner
    assert.strictEqual(dem.sample(1, 1), 700);
    // SW corner
    assert.strictEqual(dem.sample(0, 0), 300);
  });

  it('interpolates at grid center', () => {
    // Center: lat=0.5, lon=0.5 → should be 500 (center pixel)
    assert.strictEqual(dem.sample(0.5, 0.5), 500);
  });

  it('bilinear interpolation between pixels', () => {
    // lat=0.75, lon=0 → between row 0 (900) and row 1 (600), col 0
    // py = (1-0.75)/(1-0) * 2 = 0.5, so between rows 0 and 1
    const v = dem.sample(0.75, 0);
    assert.ok(Math.abs(v - 750) < 0.01, `expected ~750, got ${v}`);
  });

  it('returns null for out-of-bounds', () => {
    assert.strictEqual(dem.sample(2, 0.5), null);    // north of bbox
    assert.strictEqual(dem.sample(-1, 0.5), null);   // south of bbox
    assert.strictEqual(dem.sample(0.5, -1), null);    // west of bbox
    assert.strictEqual(dem.sample(0.5, 2), null);     // east of bbox
  });

  it('falls back to nearest neighbor with nodata', () => {
    const d = new Float32Array([100, -9999, 300, 400]);
    const nodem = new DEM(d, 2, 2, [0, 0, 1, 1]);
    // Sampling near NE corner involves nodata pixel
    const v = nodem.sample(0.75, 0.75);
    // Should fall back to nearest valid neighbor, not return null
    assert.ok(v !== null, 'should not return null when valid neighbors exist');
  });

  it('returns null when all neighbors are nodata', () => {
    const d = new Float32Array([-9999, -9999, -9999, -9999]);
    const nodem = new DEM(d, 2, 2, [0, 0, 1, 1]);
    assert.strictEqual(nodem.sample(0.5, 0.5), null);
  });
});

// ── DEM.profile ──

describe('DEM.profile', () => {
  const data = new Float32Array([
    100, 100, 100,
    100, 100, 100,
    100, 100, 100
  ]);
  const dem = new DEM(data, 3, 3, [0, 0, 1, 1]);

  it('returns arrays of correct length', () => {
    const p = dem.profile(0, 0, 1, 1, { samples: 10 });
    assert.strictEqual(p.dist.length, 10);
    assert.strictEqual(p.elev.length, 10);
    assert.strictEqual(p.lat.length, 10);
    assert.strictEqual(p.lon.length, 10);
  });

  it('starts at distance 0', () => {
    const p = dem.profile(0, 0, 1, 1, { samples: 5 });
    assert.strictEqual(p.dist[0], 0);
  });

  it('distance is monotonically increasing', () => {
    const p = dem.profile(0, 0, 1, 1, { samples: 20 });
    for (let i = 1; i < p.dist.length; i++) {
      assert.ok(p.dist[i] > p.dist[i - 1], `dist[${i}] should be > dist[${i - 1}]`);
    }
  });

  it('flat DEM produces constant elevation', () => {
    const p = dem.profile(0, 0, 1, 1, { samples: 10 });
    for (let i = 0; i < p.elev.length; i++) {
      assert.strictEqual(p.elev[i], 100);
    }
  });

  it('total distance is approximately correct (Haversine)', () => {
    // 1 degree diagonal at the equator ≈ 157 km
    const p = dem.profile(0, 0, 1, 1, { samples: 100 });
    const totalDist = p.dist[p.dist.length - 1];
    assert.ok(totalDist > 150000 && totalDist < 160000,
      `expected ~157km, got ${(totalDist / 1000).toFixed(1)}km`);
  });

  it('defaults to 500 samples', () => {
    const p = dem.profile(0, 0, 1, 1);
    assert.strictEqual(p.dist.length, 500);
  });
});

// ── tileKey ──

describe('tileKey', () => {
  it('northern hemisphere, eastern longitude', () => {
    assert.strictEqual(tileKey(20, 44), 'N20E044');
  });

  it('southern hemisphere, western longitude', () => {
    assert.strictEqual(tileKey(-21, -44), 'S21W044');
  });

  it('zero latitude and longitude', () => {
    assert.strictEqual(tileKey(0, 0), 'N00E000');
  });

  it('pads latitude to 2 digits', () => {
    assert.strictEqual(tileKey(5, 10), 'N05E010');
  });

  it('pads longitude to 3 digits', () => {
    assert.strictEqual(tileKey(45, 8), 'N45E008');
  });

  it('handles negative zero edge case', () => {
    // -0 >= 0 is true in JS, so -0 latitude → 'N'
    assert.strictEqual(tileKey(-0, -0), 'N00E000');
  });

  it('large coordinates', () => {
    assert.strictEqual(tileKey(89, 179), 'N89E179');
    assert.strictEqual(tileKey(-89, -179), 'S89W179');
  });
});

// ── tileUrl ──

describe('tileUrl', () => {
  it('constructs correct AWS S3 URL', () => {
    const url = tileUrl(-21, -44);
    assert.strictEqual(url,
      'https://s3.amazonaws.com/elevation-tiles-prod/skadi/S21/S21W044.hgt.gz');
  });

  it('folder matches latitude hemisphere and value', () => {
    const url = tileUrl(20, 44);
    assert.ok(url.includes('/N20/N20E044.hgt.gz'));
  });
});

// ── tilesForBbox ──

describe('tilesForBbox', () => {
  it('single tile for 1-degree bbox', () => {
    const tiles = tilesForBbox([-44, -21, -43, -20]);
    assert.strictEqual(tiles.length, 1);
    assert.deepStrictEqual(tiles[0], { lat: -21, lon: -44 });
  });

  it('four tiles for 2x2 degree bbox', () => {
    const tiles = tilesForBbox([10, 20, 12, 22]);
    assert.strictEqual(tiles.length, 4);
  });

  it('correct tile coordinates for multi-tile bbox', () => {
    const tiles = tilesForBbox([10, 20, 12, 22]);
    const keys = tiles.map(t => `${t.lat},${t.lon}`).sort();
    assert.deepStrictEqual(keys, ['20,10', '20,11', '21,10', '21,11']);
  });

  it('handles fractional bbox (rounds outward)', () => {
    const tiles = tilesForBbox([10.5, 20.5, 11.5, 21.5]);
    assert.strictEqual(tiles.length, 4);
  });

  it('bbox exactly on integer boundaries', () => {
    const tiles = tilesForBbox([0, 0, 1, 1]);
    assert.strictEqual(tiles.length, 1);
    assert.deepStrictEqual(tiles[0], { lat: 0, lon: 0 });
  });

  it('empty bbox returns no tiles', () => {
    // south == north, west == east
    const tiles = tilesForBbox([10, 20, 10, 20]);
    assert.strictEqual(tiles.length, 0);
  });

  it('crossing equator and prime meridian', () => {
    const tiles = tilesForBbox([-1, -1, 1, 1]);
    assert.strictEqual(tiles.length, 4);
    const lats = tiles.map(t => t.lat).sort((a, b) => a - b);
    const lons = tiles.map(t => t.lon).sort((a, b) => a - b);
    assert.deepStrictEqual([...new Set(lats)], [-1, 0]);
    assert.deepStrictEqual([...new Set(lons)], [-1, 0]);
  });
});

// ── terrainColor ──

describe('terrainColor', () => {
  it('returns forest green at t=0', () => {
    assert.deepStrictEqual(terrainColor(0), [34, 139, 34]);
  });

  it('returns white at t=1', () => {
    assert.deepStrictEqual(terrainColor(1), [255, 255, 255]);
  });

  it('clamps below 0', () => {
    assert.deepStrictEqual(terrainColor(-0.5), [34, 139, 34]);
  });

  it('clamps above 1', () => {
    assert.deepStrictEqual(terrainColor(1.5), [255, 255, 255]);
  });

  it('returns RGB array of 3 integers at mid-range', () => {
    const c = terrainColor(0.5);
    assert.strictEqual(c.length, 3);
    for (const v of c) {
      assert.strictEqual(v, Math.round(v));
      assert.ok(v >= 0 && v <= 255);
    }
  });

  it('interpolates between stops', () => {
    // t=0.5 is a stop: brown [185, 152, 100]
    assert.deepStrictEqual(terrainColor(0.5), [185, 152, 100]);
  });

  it('values between stops are between neighbors', () => {
    // t=0.075 is between stop 0 (green) and stop 1
    const c = terrainColor(0.075);
    assert.ok(c[0] >= 34 && c[0] <= 85);   // R between stop 0 and 1
    assert.ok(c[1] >= 139 && c[1] <= 153);  // G between stop 0 and 1
    assert.ok(c[2] >= 34 && c[2] <= 68);    // B between stop 0 and 1
  });
});

// ── detectColumn ──

describe('detectColumn', () => {
  it('detects "lon" header', () => {
    assert.strictEqual(detectColumn(['id', 'lon', 'lat'], LON_PATTERNS), 'lon');
  });

  it('detects "longitude" header', () => {
    assert.strictEqual(detectColumn(['longitude', 'latitude'], LON_PATTERNS), 'longitude');
  });

  it('detects "Lat" case-insensitive', () => {
    assert.strictEqual(detectColumn(['Lon', 'Lat', 'value'], LAT_PATTERNS), 'Lat');
  });

  it('detects "EASTING" case-insensitive', () => {
    assert.strictEqual(detectColumn(['EASTING', 'NORTHING'], LON_PATTERNS), 'EASTING');
  });

  it('detects "x" as lon', () => {
    assert.strictEqual(detectColumn(['x', 'y', 'z'], LON_PATTERNS), 'x');
  });

  it('detects "y" as lat', () => {
    assert.strictEqual(detectColumn(['x', 'y', 'z'], LAT_PATTERNS), 'y');
  });

  it('detects "coordx" and "coordy"', () => {
    assert.strictEqual(detectColumn(['coordx', 'coordy'], LON_PATTERNS), 'coordx');
    assert.strictEqual(detectColumn(['coordx', 'coordy'], LAT_PATTERNS), 'coordy');
  });

  it('returns null when no match', () => {
    assert.strictEqual(detectColumn(['id', 'name', 'value'], LON_PATTERNS), null);
  });

  it('returns first match', () => {
    assert.strictEqual(detectColumn(['lon', 'longitude', 'x'], LON_PATTERNS), 'lon');
  });

  it('handles whitespace in headers', () => {
    assert.strictEqual(detectColumn([' lon ', 'lat'], LON_PATTERNS), ' lon ');
  });
});

// ── haversine ──

describe('haversine', () => {
  it('returns 0 for same point', () => {
    assert.strictEqual(haversine(0, 0, 0, 0), 0);
  });

  it('1 degree latitude at equator ≈ 111 km', () => {
    const d = haversine(0, 0, 1, 0);
    assert.ok(d > 110000 && d < 112000, `expected ~111km, got ${(d / 1000).toFixed(1)}km`);
  });

  it('1 degree longitude at equator ≈ 111 km', () => {
    const d = haversine(0, 0, 0, 1);
    assert.ok(d > 110000 && d < 112000, `expected ~111km, got ${(d / 1000).toFixed(1)}km`);
  });

  it('1 degree longitude at 60° latitude ≈ 55.5 km', () => {
    const d = haversine(60, 0, 60, 1);
    assert.ok(d > 54000 && d < 57000, `expected ~55.5km, got ${(d / 1000).toFixed(1)}km`);
  });

  it('antipodal points ≈ 20015 km', () => {
    const d = haversine(0, 0, 0, 180);
    assert.ok(d > 20000000 && d < 20100000, `expected ~20015km, got ${(d / 1000).toFixed(1)}km`);
  });

  it('is symmetric', () => {
    const d1 = haversine(10, 20, 30, 40);
    const d2 = haversine(30, 40, 10, 20);
    assert.ok(Math.abs(d1 - d2) < 0.001);
  });
});
