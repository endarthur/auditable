import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convert, length, mass, grade, density, area, volume, angle, magnetic,
         sieve, core, format } from '../ext/units/index.js';

const near = (a, b, tol = 1e-6) => assert.ok(
  Math.abs(a - b) < tol, `expected ${a} ≈ ${b} (tol ${tol})`
);

describe('convert', () => {
  it('length: cm → mm', () => near(convert(0.2, 'cm', 'mm'), 2.0));
  it('length: um → cm', () => near(convert(75, 'um', 'cm'), 0.0075));
  it('length: ft → m', () => near(convert(1, 'ft', 'm'), 0.3048));
  it('length: km → m', () => near(convert(1, 'km', 'm'), 1000));
  it('length: in → cm', () => near(convert(1, 'in', 'cm'), 2.54));

  it('mass: kg → g', () => near(convert(3.5, 'kg', 'g'), 3500));
  it('mass: t → kg', () => near(convert(1, 't', 'kg'), 1000));
  it('mass: ozt → g', () => near(convert(1, 'ozt', 'g'), 31.1035));
  it('mass: lb → kg', () => near(convert(1, 'lb', 'kg'), 0.453592));
  it('mass: st → t', () => near(convert(1, 'st', 't'), 0.907185));

  it('grade: g/t → ppm (identity)', () => near(convert(5.0, 'g/t', 'ppm'), 5.0));
  it('grade: oz/t → g/t', () => {
    // 1 oz/t = 31.1035 g / 907185 g as fraction
    // 1 g/t = 1e-6 as fraction
    // factor = (31.1035/907185) / 1e-6 = 34.2857
    near(convert(1, 'oz/t', 'g/t'), 31.1035 / 907185 * 1e6, 0.01);
  });
  it('grade: pct → fraction', () => near(convert(62.3, 'pct', 'fraction'), 0.623));
  it('grade: fraction → pct', () => near(convert(0.623, 'fraction', 'pct'), 62.3));
  it('grade: g/t → pct', () => near(convert(5.0, 'g/t', 'pct'), 0.0005));

  it('density: g/cm3 → kg/m3', () => near(convert(2.65, 'g/cm3', 'kg/m3'), 2650));
  it('density: t/m3 → g/cm3', () => near(convert(2.65, 't/m3', 'g/cm3'), 2.65));
  it('density: lb/ft3 → g/cm3', () => near(convert(1, 'lb/ft3', 'g/cm3'), 0.016018, 1e-4));

  it('area: ha → m2', () => near(convert(1, 'ha', 'm2'), 10000));
  it('area: km2 → m2', () => near(convert(1, 'km2', 'm2'), 1e6));

  it('volume: cm3 → m3', () => near(convert(1, 'cm3', 'm3'), 1e-6));
  it('volume: L → m3', () => near(convert(1, 'L', 'm3'), 1e-3));

  it('angle: deg → rad', () => near(convert(45, 'deg', 'rad'), Math.PI / 4));
  it('angle: grad → rad', () => near(convert(100, 'grad', 'rad'), Math.PI / 2));
  it('angle: 360 deg → 2π rad', () => near(convert(360, 'deg', 'rad'), 2 * Math.PI));

  it('magnetic: nT → T', () => near(convert(50000, 'nT', 'T'), 5e-5));
  it('magnetic: Oe → T', () => near(convert(1, 'Oe', 'T'), 1e-4));

  it('throws on incompatible dimensions', () => {
    assert.throws(() => convert(1, 'cm', 'g'), /incompatible dimensions: length → mass/);
  });

  it('throws on unknown unit', () => {
    assert.throws(() => convert(1, 'furlongs', 'cm'), /unknown unit: furlongs/);
  });

  it('typed array conversion', () => {
    const arr = new Float64Array([0.1, 0.2, 0.5, 1.0]);
    const result = convert(arr, 'cm', 'mm');
    assert.ok(result instanceof Float64Array);
    assert.equal(result.length, 4);
    near(result[0], 1.0);
    near(result[1], 2.0);
    near(result[2], 5.0);
    near(result[3], 10.0);
    // original unchanged
    near(arr[0], 0.1);
  });

  it('inplace option', () => {
    const arr = new Float64Array([0.1, 0.2]);
    const result = convert(arr, 'cm', 'mm', { inplace: true });
    assert.equal(result, arr);  // same reference
    near(arr[0], 1.0);
    near(arr[1], 2.0);
  });

  it('plain array duck-typing', () => {
    const arr = [1, 2, 3];
    const result = convert(arr, 'm', 'km');
    near(result[0], 0.001);
    near(result[1], 0.002);
    near(result[2], 0.003);
  });

  it('natra ndarray duck-typing via .data', () => {
    const fakeNd = { data: new Float64Array([100, 200]), length: 2, shape: [2] };
    const result = convert(fakeNd, 'cm', 'm');
    // returns new typed array (not ndarray wrapper)
    assert.ok(result instanceof Float64Array);
    near(result[0], 1.0);
    near(result[1], 2.0);
  });

  it('natra ndarray inplace via .data', () => {
    const buf = new Float64Array([100, 200]);
    const fakeNd = { data: buf, length: 2, shape: [2] };
    const result = convert(fakeNd, 'cm', 'm', { inplace: true });
    assert.equal(result, fakeNd);  // same ndarray reference
    near(buf[0], 1.0);
    near(buf[1], 2.0);
  });
});

describe('sieve', () => {
  it('toMicrons for standard meshes', () => {
    assert.equal(sieve.toMicrons(200), 75);
    assert.equal(sieve.toMicrons(100), 150);
    assert.equal(sieve.toMicrons(150), 106);
    assert.equal(sieve.toMicrons(60), 250);
    assert.equal(sieve.toMicrons(35), 500);
    assert.equal(sieve.toMicrons(10), 2000);
  });

  it('throws on unknown mesh', () => {
    assert.throws(() => sieve.toMicrons(999), /unknown mesh: 999/);
  });

  it('toMesh exact lookup', () => {
    assert.equal(sieve.toMesh(75), 200);
    assert.equal(sieve.toMesh(150), 100);
    assert.equal(sieve.toMesh(500), 35);
  });

  it('toMesh nearest lookup', () => {
    const r = sieve.toMesh(80);
    assert.equal(r.nearest, 200);
    assert.equal(r.exact, false);
    assert.equal(r.aperture_um, 75);
  });

  it('toCm convenience', () => {
    near(sieve.toCm(200), 0.0075);
    near(sieve.toCm(100), 0.015);
  });

  it('table returns all entries', () => {
    const t = sieve.table();
    assert.ok(t.length > 20);
    // verify it's a copy
    t[0].mesh = 9999;
    assert.notEqual(sieve.toMicrons(t.length > 0 ? sieve.table()[0].mesh : 400), 9999);
  });
});

describe('core', () => {
  it('diameter for NQ', () => {
    const d = core.diameter('NQ');
    assert.equal(d.mm, 47.6);
    near(d.cm, 4.76);
  });

  it('diameter for HQ', () => {
    const d = core.diameter('HQ');
    assert.equal(d.mm, 63.5);
    near(d.cm, 6.35);
  });

  it('diameter for PQ', () => {
    const d = core.diameter('PQ');
    assert.equal(d.mm, 85.0);
    near(d.cm, 8.5);
  });

  it('holeDiameter', () => {
    const d = core.holeDiameter('NQ');
    assert.equal(d.mm, 75.7);
    near(d.cm, 7.57);
  });

  it('halfCoreDiameter', () => {
    const d = core.halfCoreDiameter('NQ');
    near(d.mm, 23.8, 0.1);
    near(d.cm, 2.38, 0.01);
  });

  it('unitVolume whole', () => {
    const v = core.unitVolume('NQ');
    // π/4 × 4.76² × 100 ≈ 1780.4
    near(v.cm3_per_m, 1780.4, 1);
  });

  it('unitVolume half', () => {
    const v = core.unitVolume('NQ', { split: 'half' });
    near(v.cm3_per_m, 890.2, 1);
  });

  it('unitVolume quarter', () => {
    const v = core.unitVolume('HQ', { split: 'quarter' });
    // π/4 × 6.35² × 100 / 4 ≈ 791.7
    near(v.cm3_per_m, 791.7, 1);
  });

  it('sampleMass calculation', () => {
    const s = core.sampleMass({ code: 'NQ', length_m: 1, density_gcm3: 3.5, split: 'half' });
    // 890.2 × 1 × 3.5 ≈ 3116
    near(s.mass_g, 3116, 10);
    near(s.mass_kg, 3.1, 0.2);
    near(s.volume_cm3, 890.2, 1);
  });

  it('table returns all entries', () => {
    const t = core.table();
    assert.equal(t.length, 9);
    assert.equal(t[0].code, 'AQ');
    // verify it's a copy
    t[0].code = 'ZZ';
    assert.equal(core.table()[0].code, 'AQ');
  });

  it('throws on unknown code', () => {
    assert.throws(() => core.diameter('ZZ'), /unknown core code: ZZ/);
  });
});

describe('format', () => {
  it('basic formatting with decimals', () => {
    assert.equal(format(5.234, 'g/t', { decimals: 1 }), '5.2 g/t');
  });

  it('pct renders as %', () => {
    assert.equal(format(62.3, 'pct', { decimals: 1 }), '62.3%');
  });

  it('auto-scale: 0.0075 cm → 75 µm', () => {
    const r = format(0.0075, 'cm', { auto: true, decimals: 0 });
    assert.equal(r, '75 µm');
  });

  it('auto-scale: 2650 kg/m3 → g/cm³', () => {
    const r = format(2650, 'kg/m3', { auto: true, decimals: 2 });
    assert.equal(r, '2.65 g/cm³');
  });

  it('unicode superscripts: m2 → m²', () => {
    assert.equal(format(100, 'm2', { decimals: 0 }), '100 m²');
  });

  it('unicode superscripts: cm3 → cm³', () => {
    assert.equal(format(500, 'cm3', { decimals: 0 }), '500 cm³');
  });

  it('unicode: g/cm3 → g/cm³', () => {
    assert.equal(format(2.65, 'g/cm3', { decimals: 2 }), '2.65 g/cm³');
  });

  it('unicode: um → µm', () => {
    assert.equal(format(75, 'um', { decimals: 0 }), '75 µm');
  });
});

describe('aliases', () => {
  it('length.cmToMm', () => near(length.cmToMm(0.2), 2.0));
  it('length.umToCm', () => near(length.umToCm(75), 0.0075));
  it('mass.kgToG', () => near(mass.kgToG(3.5), 3500));
  it('grade.oztToGt', () => near(grade.oztToGt(1), 31.1035 / 907185 * 1e6, 0.01));
  it('grade.gtToPct', () => near(grade.gtToPct(5.0), 0.0005));
  it('grade.pctToFraction', () => near(grade.pctToFraction(62.3), 0.623));
  it('density.kgm3ToGcm3', () => near(density.kgm3ToGcm3(2650), 2.65));
  it('angle.degToRad', () => near(angle.degToRad(45), Math.PI / 4));
  it('magnetic.nTToT', () => near(magnetic.nTToT(50000), 5e-5));
});
