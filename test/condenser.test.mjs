// @gcu/condenser — the pure core (no GL): LAS provider, frame-local quantization,
// the shuffle invariant, record-index integrity, camera math. Validated against
// synthetic LAS buffers built by test/las-make.mjs (no real data, no writer shipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLasHeader, openLas, documentFrame, createChunkBuilder, buildChunk, chunkLocalPosition, mulberry32, shuffledIndices, createOrbitCamera, transformPoint } from '../ext/condenser/src/main.js';
import { makeLas, makeTerrainPoints } from './las-make.mjs';

const PTS = [
  { x: 610000.25, y: 7760000.5, z: 901.125, intensity: 1200, classification: 2, r: 30000, g: 20000, b: 10000 },
  { x: 610010.75, y: 7760020.25, z: 899.5, intensity: 340, classification: 5, r: 200, g: 100, b: 50 },
  { x: 610005.5, y: 7760010, z: 900, intensity: 65535, classification: 6, r: 65535, g: 0, b: 65535 },
];

test('las: header parse (1.2 + 1.4, formats, count, scale/offset, bbox)', async () => {
  const h12 = parseLasHeader(new Uint8Array(makeLas(PTS, { format: 2 })));
  assert.equal(h12.version, '1.2');
  assert.equal(h12.format, 2);
  assert.equal(h12.count, 3);
  assert.ok(h12.hasRgb);
  assert.deepEqual(h12.scale, [0.001, 0.001, 0.001]);
  assert.ok(Math.abs(h12.bbox.min[0] - 610000.25) < 1e-9 && Math.abs(h12.bbox.max[2] - 901.125) < 1e-9);
  const h14 = parseLasHeader(new Uint8Array(makeLas(PTS, { format: 6, version: [1, 4] })));
  assert.equal(h14.version, '1.4');
  assert.equal(h14.count, 3);          // from the u64 field (legacy is 0)
  assert.ok(!h14.hasRgb);
});

test('las: streamChunks round-trips positions/attrs through scale/offset', async () => {
  for (const format of [0, 1, 2, 3, 6, 7, 8]) {
    const blob = new Blob([makeLas(PTS, { format, offset: [610000, 7760000, 900] })]);
    const { header, streamChunks } = await openLas(blob);
    assert.equal(header.format, format);
    const rows = [];
    for await (const c of streamChunks()) for (let i = 0; i < c.count; i++) {
      rows.push({ x: c.x[i], y: c.y[i], z: c.z[i], intensity: c.intensity[i], classification: c.classification[i], rgb: c.rgb ? [c.rgb[i * 3], c.rgb[i * 3 + 1], c.rgb[i * 3 + 2]] : null, rec: c.recStart + i });
    }
    assert.equal(rows.length, 3, `format ${format}`);
    rows.forEach((r, i) => {
      assert.ok(Math.abs(r.x - PTS[i].x) < 0.0011 && Math.abs(r.z - PTS[i].z) < 0.0011, `format ${format} pos[${i}]`);
      assert.equal(r.intensity, PTS[i].intensity);
      assert.equal(r.classification, PTS[i].classification);
      assert.equal(r.rec, i);
      if (r.rgb) assert.deepEqual(r.rgb, [PTS[i].r >> 8, PTS[i].g >> 8, PTS[i].b >> 8], `format ${format} rgb (16-bit → >>8)`);
    });
  }
});

test('las: rejects non-LAS and LAZ', async () => {
  assert.throws(() => parseLasHeader(new Uint8Array(256)), /LASF/);
  const laz = new Uint8Array(makeLas(PTS, { format: 1 }));
  laz[104] |= 0x80;                                        // compression bit
  assert.throws(() => parseLasHeader(laz), /LAZ/);
});

test('las: partial records across stream boundaries survive (small chunks)', async () => {
  const pts = makeTerrainPoints(5000);
  const buf = makeLas(pts, { format: 0, offset: [610000, 7760000, 900] });
  // a Blob built from many small slices → the reader sees ragged chunk boundaries
  const u8 = new Uint8Array(buf), parts = [];
  for (let o = 0; o < u8.length; o += 777) parts.push(u8.slice(o, Math.min(o + 777, u8.length)));
  const { header, streamChunks } = await openLas(new Blob(parts));
  let n = 0, sumZ = 0;
  for await (const c of streamChunks({ chunkPoints: 512 })) { n += c.count; for (let i = 0; i < c.count; i++) sumZ += c.z[i]; }
  assert.equal(n, header.count);
  const expectZ = pts.reduce((s, p) => s + Math.round((p.z - 900) / 0.001) * 0.001 + 900, 0);
  assert.ok(Math.abs(sumZ - expectZ) < 1e-6 * n, 'all coordinates decoded');
});

test('chunks: frame-local quantization round-trips within half a step', async () => {
  const pts = makeTerrainPoints(2000);
  const blob = new Blob([makeLas(pts, { format: 0, offset: [610000, 7760000, 900] })]);
  const { header, streamChunks } = await openLas(blob);
  const frame = documentFrame(header, { crs: 'EPSG:31983' });
  assert.ok(Math.abs(frame.origin[0] - 610000) < 500, 'origin near the data');
  const chunks = [];
  const cb = createChunkBuilder({ frame, chunkSize: 512, onChunk: (c) => chunks.push(c) });
  const world = [];                                        // world truth by record index
  for await (const rc of streamChunks({ chunkPoints: 300 })) {
    for (let i = 0; i < rc.count; i++) world[rc.recStart + i] = [rc.x[i], rc.y[i], rc.z[i]];
    cb.push(rc);
  }
  const doc = cb.flush();
  assert.equal(doc.count, 2000);
  assert.equal(chunks.length, Math.ceil(2000 / 512));
  let maxErr = 0;
  for (const c of chunks) {
    const step = Math.max((c.bboxLocal[3] - c.bboxLocal[0]) / 65535, (c.bboxLocal[4] - c.bboxLocal[1]) / 65535, (c.bboxLocal[5] - c.bboxLocal[2]) / 65535);
    for (let k = 0; k < c.count; k++) {
      const local = chunkLocalPosition(c, k);
      const w = world[c.recIdx[k]];                        // record index joins back to the source row
      for (let a = 0; a < 3; a++) maxErr = Math.max(maxErr, Math.abs(local[a] + frame.origin[a] - w[a]));
    }
    assert.ok(step < 0.01, `quantization step ${step} m stays sub-cm at patch scale`);
  }
  assert.ok(maxErr < 0.01, `max reconstruction error ${maxErr} m`);
});

test('chunks: the shuffle invariant — a prefix is a uniform spatial subsample', () => {
  // 10k points on a line x=0..9999; after shuffle, the first 10% must cover the
  // whole extent roughly uniformly (each decile gets ~100 of the 1000).
  const n = 10000;
  const cols = {
    x: Float64Array.from({ length: n }, (_, i) => i),
    y: new Float64Array(n), z: new Float64Array(n),
    intensity: new Uint16Array(n), classification: new Uint8Array(n), rgb: null,
    recIdx: Uint32Array.from({ length: n }, (_, i) => i),
  };
  const frame = { origin: [0, 0, 0] };
  const chunk = buildChunk(cols, frame, mulberry32(7));
  const prefix = 1000, counts = new Array(10).fill(0);
  for (let k = 0; k < prefix; k++) counts[Math.min(9, Math.floor(chunkLocalPosition(chunk, k)[0] / 1000))]++;
  for (const c of counts) assert.ok(c > 55 && c < 165, `decile count ${c} ≈ 100 (uniform prefix)`);
  // and the permutation is a bijection: record indices are exactly 0..n-1
  const seen = new Uint8Array(n);
  for (let k = 0; k < n; k++) seen[chunk.recIdx[k]] = 1;
  assert.ok(seen.every((v) => v === 1), 'record indices form a complete permutation');
});

test('shuffledIndices: deterministic for a seed, permutation always', () => {
  const a = shuffledIndices(100, mulberry32(3)), b = shuffledIndices(100, mulberry32(3));
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...shuffledIndices(100, mulberry32(4))]);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 100 }, (_, i) => i));
});

test('camera: fit + project — bbox corners land inside clip space, center at origin ray', () => {
  const cam = createOrbitCamera();
  cam.setAspect(16 / 9);
  const bbox = Float64Array.of(-100, -50, 0, 300, 250, 60);
  cam.fit(bbox);
  const c = cam.state;
  const center = transformPoint(c.viewProj, [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, (bbox[2] + bbox[5]) / 2]);
  assert.ok(Math.abs(center[0]) < 1e-3 && Math.abs(center[1]) < 1e-3, 'target projects to screen center');
  for (const px of [bbox[0], bbox[3]]) for (const py of [bbox[1], bbox[4]]) for (const pz of [bbox[2], bbox[5]]) {
    const p = transformPoint(c.viewProj, [px, py, pz]);
    assert.ok(Math.abs(p[0]) <= 1.05 && Math.abs(p[1]) <= 1.05 && p[2] >= -1 && p[2] <= 1, `corner ${[px, py, pz]} in frustum → ${p}`);
  }
  // orbit + dolly keep the target centered
  cam.orbit(0.7, -0.2); cam.dolly(1.5);
  const c2 = cam.state;
  const center2 = transformPoint(c2.viewProj, [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, (bbox[2] + bbox[5]) / 2]);
  assert.ok(Math.abs(center2[0]) < 1e-3 && Math.abs(center2[1]) < 1e-3);
});
