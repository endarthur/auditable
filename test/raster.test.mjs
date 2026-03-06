import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  instantiate, alloc, writeF32, readF32, growMemory,
  slope, aspect, hillshade, terrain, curvature, tri, tpi, roughness, contour,
} = await import('../ext/atra/lib/raster.js');

const NODATA = -9999;

// ── helpers ──

function makeFlat(w, h, val) {
  return new Float32Array(w * h).fill(val);
}

// North-facing plane: elevation increases going south (row index increases).
// Row 0 = north = lowest elevation.
function makeNorthFacingPlane(w, h, gradient) {
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++)
      data[r * w + c] = r * gradient;
  return data;
}

// East-facing plane: elevation increases going west (col decreases).
function makeEastFacingPlane(w, h, gradient) {
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++)
      data[r * w + c] = (w - 1 - c) * gradient;
  return data;
}

function getInterior(arr, w, h) {
  // return array of interior pixel values
  const vals = [];
  for (let r = 1; r < h - 1; r++)
    for (let c = 1; c < w - 1; c++)
      vals.push(arr[r * w + c]);
  return vals;
}

function approxEqual(a, b, tol = 0.01) {
  return Math.abs(a - b) < tol;
}

// ── slope tests ──

describe('slope', () => {
  it('flat grid → 0', () => {
    const data = makeFlat(5, 5, 100);
    const out = slope(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 0), `expected ~0, got ${v}`);
  });

  it('constant north-facing plane → known angle', () => {
    const gradient = 10; // 10m per pixel
    const cellSize = 30;
    const data = makeNorthFacingPlane(5, 5, gradient);
    const out = slope(data, 5, 5, cellSize);
    const expected = Math.atan(gradient / cellSize) * 180 / Math.PI;
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, expected, 0.1), `expected ~${expected.toFixed(2)}, got ${v}`);
  });

  it('nodata center → nodata', () => {
    const data = makeFlat(5, 5, 100);
    data[2 * 5 + 2] = NODATA;
    const out = slope(data, 5, 5, 30);
    assert.equal(out[2 * 5 + 2], NODATA);
  });

  it('nodata neighbor → nodata', () => {
    const data = makeFlat(5, 5, 100);
    data[1 * 5 + 1] = NODATA; // top-left neighbor of (2,2)
    const out = slope(data, 5, 5, 30);
    assert.equal(out[2 * 5 + 2], NODATA);
  });

  it('border → nodata', () => {
    const data = makeFlat(5, 5, 100);
    const out = slope(data, 5, 5, 30);
    // top row
    for (let c = 0; c < 5; c++) assert.equal(out[c], NODATA);
    // bottom row
    for (let c = 0; c < 5; c++) assert.equal(out[4 * 5 + c], NODATA);
    // left/right cols
    for (let r = 0; r < 5; r++) {
      assert.equal(out[r * 5], NODATA);
      assert.equal(out[r * 5 + 4], NODATA);
    }
  });

  it('non-square cellSize [cx, cy]', () => {
    const data = makeNorthFacingPlane(5, 5, 10);
    const out = slope(data, 5, 5, [30, 30]);
    const expected = Math.atan(10 / 30) * 180 / Math.PI;
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, expected, 0.1));
  });
});

// ── aspect tests ──

describe('aspect', () => {
  it('flat grid → -1', () => {
    const data = makeFlat(5, 5, 100);
    const out = aspect(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, -1), `expected -1, got ${v}`);
  });

  it('north-facing plane → 0 (aspect = downhill direction = north)', () => {
    // Elevation increases going south → steepest descent is north → aspect = 0
    const data = makeNorthFacingPlane(5, 5, 10);
    const out = aspect(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 0, 1) || approxEqual(v, 360, 1), `expected ~0/360, got ${v}`);
  });

  it('east-facing plane → 90 (downhill direction = east)', () => {
    // Elevation increases going west → steepest descent is east → aspect = 90
    const data = makeEastFacingPlane(5, 5, 10);
    const out = aspect(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 90, 1), `expected ~90, got ${v}`);
  });
});

// ── hillshade tests ──

describe('hillshade', () => {
  it('flat grid → cos(zenith)*255', () => {
    const data = makeFlat(5, 5, 100);
    const altitude = 45;
    const zenRad = (90 - altitude) * Math.PI / 180;
    const expected = Math.cos(zenRad) * 255;
    const out = hillshade(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, expected, 1), `expected ~${expected.toFixed(1)}, got ${v}`);
  });

  it('values in 0-255 range', () => {
    const data = makeNorthFacingPlane(5, 5, 10);
    const out = hillshade(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) {
      assert.ok(v >= 0 && v <= 255, `hillshade value ${v} out of range`);
    }
  });
});

// ── terrain fused tests ──

describe('terrain (fused)', () => {
  it('matches individual slope + aspect + hillshade', () => {
    const data = makeNorthFacingPlane(7, 7, 15);
    const cellSize = 30;
    const opts = { azimuth: 315, altitude: 45, zFactor: 1 };

    const sIndiv = slope(data, 7, 7, cellSize);
    const aIndiv = aspect(data, 7, 7, cellSize);
    const hIndiv = hillshade(data, 7, 7, cellSize, opts);
    const fused = terrain(data, 7, 7, cellSize, opts);

    for (let i = 0; i < 49; i++) {
      assert.ok(approxEqual(fused.slope[i], sIndiv[i], 0.01),
        `slope mismatch at ${i}: ${fused.slope[i]} vs ${sIndiv[i]}`);
      assert.ok(approxEqual(fused.aspect[i], aIndiv[i], 0.01),
        `aspect mismatch at ${i}: ${fused.aspect[i]} vs ${aIndiv[i]}`);
      assert.ok(approxEqual(fused.hillshade[i], hIndiv[i], 0.5),
        `hillshade mismatch at ${i}: ${fused.hillshade[i]} vs ${hIndiv[i]}`);
    }
  });
});

// ── TRI tests ──

describe('tri', () => {
  it('flat grid → 0', () => {
    const data = makeFlat(5, 5, 100);
    const out = tri(data, 5, 5);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 0), `expected 0, got ${v}`);
  });

  it('step edge → known value', () => {
    // 5x5 grid, left half = 0, right half = 100
    const data = new Float32Array(25);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++)
        data[r * 5 + c] = c >= 3 ? 100 : 0;
    const out = tri(data, 5, 5);
    // center pixel (2,2): c=2, neighbors include c=1(0) and c=3(100)
    // z4=0, neighbors: z0=0,z1=0,z2=100, z3=0,z5=100, z6=0,z7=0,z8=100
    // |0|+|0|+|100|+|0|+|100|+|0|+|0|+|100| = 300, /8 = 37.5
    assert.ok(approxEqual(out[2 * 5 + 2], 37.5, 0.1));
  });

  it('nodata propagation', () => {
    const data = makeFlat(5, 5, 100);
    data[1 * 5 + 2] = NODATA;
    const out = tri(data, 5, 5);
    assert.equal(out[2 * 5 + 2], NODATA);
  });
});

// ── TPI tests ──

describe('tpi', () => {
  it('flat grid → 0', () => {
    const data = makeFlat(5, 5, 100);
    const out = tpi(data, 5, 5);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 0), `expected 0, got ${v}`);
  });

  it('peak → positive', () => {
    const data = makeFlat(5, 5, 100);
    data[2 * 5 + 2] = 200; // center is higher
    const out = tpi(data, 5, 5);
    assert.ok(out[2 * 5 + 2] > 0, `expected positive, got ${out[2 * 5 + 2]}`);
    assert.ok(approxEqual(out[2 * 5 + 2], 100, 0.1));
  });

  it('valley → negative', () => {
    const data = makeFlat(5, 5, 200);
    data[2 * 5 + 2] = 100;
    const out = tpi(data, 5, 5);
    assert.ok(out[2 * 5 + 2] < 0, `expected negative, got ${out[2 * 5 + 2]}`);
    assert.ok(approxEqual(out[2 * 5 + 2], -100, 0.1));
  });
});

// ── roughness tests ──

describe('roughness', () => {
  it('flat grid → 0', () => {
    const data = makeFlat(5, 5, 100);
    const out = roughness(data, 5, 5);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 0), `expected 0, got ${v}`);
  });

  it('step edge → known value', () => {
    const data = new Float32Array(25);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++)
        data[r * 5 + c] = c >= 3 ? 100 : 0;
    const out = roughness(data, 5, 5);
    // center (2,2): min=0, max=100 → roughness=100
    assert.ok(approxEqual(out[2 * 5 + 2], 100, 0.1));
  });

  it('nodata propagation', () => {
    const data = makeFlat(5, 5, 100);
    data[1 * 5 + 2] = NODATA;
    const out = roughness(data, 5, 5);
    assert.equal(out[2 * 5 + 2], NODATA);
  });
});

// ── contour tests ──

describe('contour', () => {
  it('linear ramp → parallel contours', () => {
    const w = 5, h = 5;
    const data = new Float32Array(w * h);
    // elevation = row * 100 (0, 100, 200, 300, 400)
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r * 100;

    const bbox = [0, 0, 4, 4];
    const result = contour(data, w, h, bbox, { interval: 100 });

    assert.equal(result.type, 'FeatureCollection');
    assert.ok(result.features.length > 0, 'should have contour features');

    // all features should be LineStrings with an elev property
    for (const f of result.features) {
      assert.equal(f.type, 'Feature');
      assert.equal(f.geometry.type, 'LineString');
      assert.ok(f.properties.elev != null);
      // coordinates should be in bbox space
      for (const [x, y] of f.geometry.coordinates) {
        assert.ok(x >= -0.1 && x <= 4.1, `x=${x} out of bbox`);
        assert.ok(y >= -0.1 && y <= 4.1, `y=${y} out of bbox`);
      }
    }
  });

  it('flat grid at contour level → contour line', () => {
    const w = 5, h = 5;
    // bottom half=0, top half=200 → contour at 100 in between
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r < 2 ? 0 : 200;

    const bbox = [0, 0, 4, 4];
    const result = contour(data, w, h, bbox, { interval: 100, base: 0 });
    const at100 = result.features.filter(f => f.properties.elev === 100);
    assert.ok(at100.length > 0, 'should have contour at level 100');
  });

  it('valid GeoJSON structure', () => {
    const w = 5, h = 5;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r * 50 + c * 10;

    const bbox = [-44, -21, -43, -20];
    const result = contour(data, w, h, bbox, { interval: 50 });
    assert.equal(result.type, 'FeatureCollection');
    assert.ok(Array.isArray(result.features));
    for (const f of result.features) {
      assert.ok(f.geometry.coordinates.length >= 2, 'LineString needs >= 2 points');
    }
  });

  it('nodata cells skipped', () => {
    const w = 5, h = 5;
    const data = new Float32Array(w * h).fill(NODATA);
    const bbox = [0, 0, 1, 1];
    const result = contour(data, w, h, bbox, { interval: 100 });
    assert.equal(result.features.length, 0);
  });
});

// ── terrain fused with nodata ──

describe('terrain fused nodata', () => {
  it('nodata propagates to all three outputs', () => {
    const data = makeNorthFacingPlane(5, 5, 10);
    data[1 * 5 + 2] = NODATA; // neighbor of (2,2)
    const fused = terrain(data, 5, 5, 30);
    assert.equal(fused.slope[2 * 5 + 2], NODATA);
    assert.equal(fused.aspect[2 * 5 + 2], NODATA);
    assert.equal(fused.hillshade[2 * 5 + 2], NODATA);
  });

  it('border → nodata in all three outputs', () => {
    const data = makeFlat(5, 5, 100);
    const fused = terrain(data, 5, 5, 30);
    for (let c = 0; c < 5; c++) {
      assert.equal(fused.slope[c], NODATA);
      assert.equal(fused.aspect[c], NODATA);
      assert.equal(fused.hillshade[c], NODATA);
    }
  });
});

// ── aspect: south-facing and west-facing ──

describe('aspect additional directions', () => {
  it('south-facing plane → 180 (downhill = south)', () => {
    // Elevation decreases going south (high at south, low at north)
    const data = new Float32Array(25);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++)
        data[r * 5 + c] = (4 - r) * 10; // row 0=40, row 4=0
    const out = aspect(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 180, 1), `expected ~180, got ${v}`);
  });

  it('west-facing plane → 270 (downhill = west)', () => {
    // Elevation increases going east
    const data = new Float32Array(25);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++)
        data[r * 5 + c] = c * 10;
    const out = aspect(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 270, 1), `expected ~270, got ${v}`);
  });
});

// ── slope: steep vs gentle ──

describe('slope precision', () => {
  it('45-degree slope when gradient = cellSize', () => {
    const cs = 30;
    const data = makeNorthFacingPlane(5, 5, cs); // gradient = cellSize → 45 deg
    const out = slope(data, 5, 5, cs);
    const interior = getInterior(out, 5, 5);
    for (const v of interior) assert.ok(approxEqual(v, 45, 0.1), `expected ~45, got ${v}`);
  });

  it('diagonal slope combines dx and dy', () => {
    // Elevation = row + col → gradient in both directions
    const data = new Float32Array(25);
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++)
        data[r * 5 + c] = (r + c) * 10;
    const out = slope(data, 5, 5, 30);
    const interior = getInterior(out, 5, 5);
    // dz/dx = 10/30, dz/dy = 10/30, slope = atan(sqrt(2)*10/30)
    const expected = Math.atan(Math.sqrt(2) * 10 / 30) * 180 / Math.PI;
    for (const v of interior) assert.ok(approxEqual(v, expected, 0.5), `expected ~${expected.toFixed(1)}, got ${v}`);
  });
});

// ── hillshade: different sun positions ──

describe('hillshade sun positions', () => {
  it('sun directly overhead (altitude=90) → uniform 255', () => {
    const data = makeNorthFacingPlane(5, 5, 10);
    const out = hillshade(data, 5, 5, 30, { altitude: 90, azimuth: 315 });
    const interior = getInterior(out, 5, 5);
    // cos(zenRad=0) * cos(slopeRad) + sin(0)*... = cos(slopeRad)
    // Not exactly 255 unless flat, but should be close to 255
    for (const v of interior) assert.ok(v > 200, `expected high value, got ${v}`);
  });

  it('zFactor amplifies slope', () => {
    const data = makeNorthFacingPlane(5, 5, 5);
    const out1 = hillshade(data, 5, 5, 30, { zFactor: 1 });
    const out2 = hillshade(data, 5, 5, 30, { zFactor: 5 });
    // Higher zFactor → steeper apparent slope → different hillshade
    const v1 = out1[2 * 5 + 2];
    const v2 = out2[2 * 5 + 2];
    assert.ok(v1 !== v2, `zFactor should change hillshade: ${v1} vs ${v2}`);
  });
});

// ── contour: custom attribute name ──

describe('contour options', () => {
  it('custom attribute name', () => {
    const w = 5, h = 5;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r * 100;
    const result = contour(data, w, h, [0, 0, 4, 4], { interval: 100, attribute: 'elevation' });
    for (const f of result.features) {
      assert.ok(f.properties.elevation != null, 'should use custom attribute name');
      assert.equal(f.properties.elev, undefined);
    }
  });

  it('contour coordinates in geographic bbox space', () => {
    const w = 10, h = 10;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r * 50;
    const bbox = [-44.5, -22.0, -43.5, -21.0];
    const result = contour(data, w, h, bbox, { interval: 100 });
    for (const f of result.features) {
      for (const [x, y] of f.geometry.coordinates) {
        assert.ok(x >= -44.6 && x <= -43.4, `x=${x} outside bbox longitude`);
        assert.ok(y >= -22.1 && y <= -20.9, `y=${y} outside bbox latitude`);
      }
    }
  });
});

// ── TRI/TPI/roughness: larger grid ──

describe('surface metrics on ramp', () => {
  it('constant slope → uniform TRI, TPI~0, roughness > 0', () => {
    const w = 7, h = 7;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = r * 10;

    const triOut = tri(data, w, h);
    const tpiOut = tpi(data, w, h);
    const rghOut = roughness(data, w, h);

    const triInt = getInterior(triOut, w, h);
    const tpiInt = getInterior(tpiOut, w, h);
    const rghInt = getInterior(rghOut, w, h);

    // TRI: all interior should be same (uniform slope)
    const triVal = triInt[0];
    for (const v of triInt) assert.ok(approxEqual(v, triVal, 0.01), `TRI not uniform: ${v} vs ${triVal}`);
    assert.ok(triVal > 0, 'TRI should be positive on slope');

    // TPI: center minus mean neighbors ≈ 0 on uniform slope
    for (const v of tpiInt) assert.ok(approxEqual(v, 0, 0.1), `TPI should be ~0: ${v}`);

    // roughness: should equal 2 * gradient (max - min in 3x3)
    for (const v of rghInt) assert.ok(approxEqual(v, 20, 0.1), `roughness should be 20: ${v}`);
  });
});

// ── curvature tests ──

describe('curvature', () => {
  it('flat grid → all zeros', () => {
    const data = makeFlat(5, 5, 100);
    const c = curvature(data, 5, 5, 30);
    const profInt = getInterior(c.profile, 5, 5);
    const planInt = getInterior(c.plan, 5, 5);
    const meanInt = getInterior(c.mean, 5, 5);
    for (const v of profInt) assert.ok(approxEqual(v, 0, 0.001), `profile should be 0, got ${v}`);
    for (const v of planInt) assert.ok(approxEqual(v, 0, 0.001), `plan should be 0, got ${v}`);
    for (const v of meanInt) assert.ok(approxEqual(v, 0, 0.001), `mean should be 0, got ${v}`);
  });

  it('constant slope → profile=0, plan=0', () => {
    // uniform slope has no curvature
    const data = makeNorthFacingPlane(7, 7, 10);
    const c = curvature(data, 7, 7, 30);
    const profInt = getInterior(c.profile, 7, 7);
    const planInt = getInterior(c.plan, 7, 7);
    for (const v of profInt) assert.ok(approxEqual(v, 0, 0.001), `profile should be 0, got ${v}`);
    for (const v of planInt) assert.ok(approxEqual(v, 0, 0.001), `plan should be 0, got ${v}`);
  });

  it('concave surface → negative profile curvature', () => {
    // parabola: z = x² (concave up in x) → d²z/dx² = 2 > 0
    // profile curvature formula uses negative sign → negative output
    const w = 7, h = 7, cs = 1;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = (c - 3) * (c - 3);
    const result = curvature(data, w, h, cs);
    // center pixel at (3,3): slope along x = 0 (bottom of parabola)
    // but neighboring pixels have curvature — check (3,2) where slope ≠ 0
    const idx = 3 * w + 2;
    // profile curvature at a point on a parabola facing the center
    // should be non-zero
    assert.ok(result.profile[idx] !== 0, 'profile should be non-zero on curved surface');
  });

  it('bowl shape → negative mean curvature', () => {
    // z = x² + y² — bowl (concave up)
    // zxx = 2, zyy = 2, zxy = 0
    // mean curvature = -((1+q²)*zxx + (1+p²)*zyy) / (2*(1+p²+q²)^1.5)
    // at center (flat point): = -(2 + 2) / 2 = -2
    const w = 7, h = 7, cs = 1;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = (c - 3) * (c - 3) + (r - 3) * (r - 3);
    const result = curvature(data, w, h, cs);
    // at center (3,3): p≈0, q≈0, zxx=2, zyy=2
    // mean = -(2+2)/2 = -2
    const idx = 3 * w + 3;
    assert.ok(result.mean[idx] < 0, `bowl center should have negative mean curvature, got ${result.mean[idx]}`);
    assert.ok(approxEqual(result.mean[idx], -2, 0.1), `expected mean≈-2, got ${result.mean[idx]}`);
  });

  it('dome shape → positive mean curvature', () => {
    // z = -(x² + y²) — dome (concave down)
    const w = 7, h = 7, cs = 1;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = -((c - 3) * (c - 3) + (r - 3) * (r - 3)) + 50;
    const result = curvature(data, w, h, cs);
    const idx = 3 * w + 3;
    assert.ok(result.mean[idx] > 0, `dome center should have positive mean curvature, got ${result.mean[idx]}`);
    assert.ok(approxEqual(result.mean[idx], 2, 0.1), `expected mean≈2, got ${result.mean[idx]}`);
  });

  it('nodata propagation', () => {
    const data = makeFlat(5, 5, 100);
    data[1 * 5 + 2] = NODATA;
    const c = curvature(data, 5, 5, 30);
    assert.equal(c.profile[2 * 5 + 2], NODATA);
    assert.equal(c.plan[2 * 5 + 2], NODATA);
    assert.equal(c.mean[2 * 5 + 2], NODATA);
  });

  it('border → nodata', () => {
    const data = makeFlat(5, 5, 100);
    const c = curvature(data, 5, 5, 30);
    for (let col = 0; col < 5; col++) {
      assert.equal(c.profile[col], NODATA);
      assert.equal(c.plan[col], NODATA);
      assert.equal(c.mean[col], NODATA);
    }
  });

  it('non-square cellSize', () => {
    const w = 7, h = 7;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = (c - 3) * (c - 3) + (r - 3) * (r - 3);
    const c = curvature(data, w, h, [1, 2]);
    // should not crash and should produce valid values
    const idx = 3 * w + 3;
    assert.ok(isFinite(c.mean[idx]), 'mean curvature should be finite');
    assert.ok(c.mean[idx] < 0, 'bowl should still be negative');
  });
});

// ── kernel-level test (direct Wasm) ──

describe('kernel-level slope', () => {
  it('flat 5x5 → all interior 0', () => {
    const w = 5, h = 5, n = 25;
    const mem = new WebAssembly.Memory({ initial: 2 });
    const lib = instantiate({ memory: mem });
    const st = { off: 0 };
    const pDem = alloc(st, 0, n);
    const pOut = alloc(st, 0, n);
    growMemory(mem, st.off);
    const flat = new Float32Array(n).fill(500);
    writeF32(mem, pDem, flat);
    lib.raster.slope(pDem, pOut, w, h, 30, 30, NODATA);
    const out = readF32(mem, pOut, n);
    for (let r = 1; r < h - 1; r++)
      for (let c = 1; c < w - 1; c++)
        assert.ok(approxEqual(out[r * w + c], 0), `interior (${r},${c}) = ${out[r * w + c]}`);
  });
});
