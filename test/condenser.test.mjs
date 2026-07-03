// @gcu/condenser — the pure core (no GL): LAS provider, frame-local quantization,
// the shuffle invariant, record-index integrity, camera math. Validated against
// synthetic LAS buffers built by test/las-make.mjs (no real data, no writer shipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLasHeader, openLas, documentFrame, createChunkBuilder, buildChunk, chunkLocalPosition, mulberry32, shuffledIndices, createOrbitCamera, transformPoint, mortonKey, mortonKeys, radixSortIndices, frustumPlanes, aabbInFrustum } from '../ext/condenser/src/main.js';
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

test('morton: bit interleave + key ordering', () => {
  assert.equal(mortonKey(1, 0, 0), 1);
  assert.equal(mortonKey(0, 1, 0), 2);
  assert.equal(mortonKey(0, 0, 1), 4);
  assert.equal(mortonKey(3, 0, 0), 0b1001);                // x bits at positions 0,3
  assert.equal(mortonKey(1023, 1023, 1023), (1 << 30) - 1); // all 30 bits
  // nearby lattice points get nearby keys more often than far ones (sanity, not proof)
  const kA = mortonKey(100, 100, 100), kB = mortonKey(101, 100, 100), kC = mortonKey(900, 900, 900);
  assert.ok(Math.abs(kA - kB) < Math.abs(kA - kC));
});

test('morton: radix sort orders keys ascending (stable, complete)', () => {
  const n = 5000, rnd = mulberry32(11);
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) keys[i] = (rnd() * (1 << 30)) | 0;
  const order = radixSortIndices(keys, n);
  const seen = new Uint8Array(n);
  for (let k = 1; k < n; k++) assert.ok(keys[order[k - 1]] <= keys[order[k]], 'ascending');
  for (let k = 0; k < n; k++) seen[order[k]] = 1;
  assert.ok(seen.every((v) => v === 1), 'a complete permutation');
});

test('chunks: Morton batching yields far tighter bboxes than arrival order', () => {
  // 64k points over a 1000×1000×50 region in RANDOM arrival order (worst case for
  // sequential chunking). Compare Σ bbox volume: morton must crush sequential.
  const n = 1 << 16, rnd = mulberry32(5);
  const mkRaw = () => {
    const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
    for (let i = 0; i < n; i++) { x[i] = rnd() * 1000; y[i] = rnd() * 1000; z[i] = rnd() * 50; }
    return { count: n, x, y, z, intensity: new Uint16Array(n), classification: new Uint8Array(n), rgb: null, recStart: 0 };
  };
  const frame = { origin: [0, 0, 0] };
  const vol = (c) => { const b = c.bboxLocal; return (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]); };
  const run = (morton) => {
    const out = [];
    const cb = createChunkBuilder({ frame, chunkSize: 4096, morton, seed: 1, onChunk: (c) => out.push(c) });
    cb.push(mkRaw()); cb.flush();
    return out;
  };
  const seq = run(false), mor = run(true);
  assert.equal(seq.reduce((s, c) => s + c.count, 0), n);
  assert.equal(mor.reduce((s, c) => s + c.count, 0), n);
  const volSeq = seq.reduce((s, c) => s + vol(c), 0), volMor = mor.reduce((s, c) => s + vol(c), 0);
  // ~2.5× tighter on a FLAT region (z is 20× thinner but gets equal Morton bits, so
  // slices span full z quickly — the realistic aerial-scan shape). Assert ≥2×; the
  // x/y separation is what buys frustum culling either way.
  assert.ok(volMor < volSeq * 0.5, `morton Σvol ${volMor.toExponential(2)} ≪ sequential ${volSeq.toExponential(2)}`);
  // record indices still form the full set across chunks
  const seen = new Uint8Array(n);
  for (const c of mor) for (let k = 0; k < c.count; k++) seen[c.recIdx[k]] = 1;
  assert.ok(seen.every((v) => v === 1), 'no element lost or duplicated by the sort');
});

test('frustum: culling accepts the fitted box, rejects boxes outside', () => {
  const cam = createOrbitCamera();
  cam.setAspect(1.5);
  const bbox = Float64Array.of(0, 0, 0, 100, 100, 20);
  cam.fit(bbox);
  const planes = frustumPlanes(cam.state.viewProj);
  assert.ok(aabbInFrustum(planes, bbox), 'the fitted box is visible');
  assert.ok(aabbInFrustum(planes, Float64Array.of(40, 40, 5, 60, 60, 10)), 'an interior box is visible');
  // a box far off to the side / far behind the camera is culled
  assert.ok(!aabbInFrustum(planes, Float64Array.of(100000, 100000, 0, 100010, 100010, 5)), 'far-off box culled');
  const eye = cam.state.eye, t = cam.state.target;
  const behind = [eye[0] + (eye[0] - t[0]) * 10, eye[1] + (eye[1] - t[1]) * 10, eye[2] + (eye[2] - t[2]) * 10];
  assert.ok(!aabbInFrustum(planes, Float64Array.of(behind[0], behind[1], behind[2], behind[0] + 1, behind[1] + 1, behind[2] + 1)), 'behind-camera box culled');
});

// ── M3: block models ──
import { inferAxis, makeBlockGrid, buildBlockChunk, blockLocalCenter, createBlockChunkBuilder, sniffDelimited, mapColumns, openBlockModel } from '../ext/condenser/src/main.js';

test('blocks: inferAxis — regular lattice in, origin/pitch/count out; junk rejected', () => {
  const a = inferAxis([612000, 612010, 612020, 612050]);   // gaps are fine (sparse model)
  assert.deepEqual([a.origin, a.pitch, a.count], [612000, 10, 6]);
  assert.equal(inferAxis([1, 2, 3.4142]), null);           // off-lattice → not regular
  assert.deepEqual(inferAxis([5]), { origin: 5, pitch: 0, count: 1 });
});

test('blocks: sniff + column mapping (XC/YC/ZC conventions)', () => {
  const s = sniffDelimited('XC,YC,ZC,FE,SIO2,LITO\n1,2,3,55.1,4.2,BIF\n4,5,6,60,3,CANGA\n');
  assert.equal(s.delim, ',');
  assert.deepEqual(s.header, ['XC', 'YC', 'ZC', 'FE', 'SIO2', 'LITO']);
  const m = mapColumns(s.header);
  assert.deepEqual([m.x, m.y, m.z, m.chan], [0, 1, 2, 3]); // FE = first grade candidate
  const ws = sniffDelimited('612000 7765000 400 55.1\n612010 7765000 400 60\n');
  assert.equal(ws.delim, 'ws');
  assert.equal(ws.header, null);                           // headerless
});

test('blocks: provider round-trip — grid inferred, categories coded, IJK exact', async () => {
  // a 6×4×3 grid, 10×10×5 blocks, shuffled row order (worst case for inference)
  const rows = [];
  let rec = 0;
  for (let k = 0; k < 3; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) {
    rows.push({ line: `${612000 + i * 10},${7765000 + j * 10},${400 + k * 5},${(50 + i + j + k).toFixed(1)},${k === 2 ? 'CANGA' : 'BIF'}`, i, j, k, rec: rec++ });
  }
  // shuffle deterministically
  const rnd = mulberry32(3);
  for (let i = rows.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = rows[i]; rows[i] = rows[j]; rows[j] = t; }
  const csv = 'XC,YC,ZC,FE,LITO\n' + rows.map((r) => r.line).join('\n') + '\n';
  const { header, streamChunks } = await openBlockModel(new Blob([csv]));
  assert.equal(header.count, 72);
  assert.ok(header.grid, 'regular grid inferred from shuffled rows');
  assert.deepEqual([header.grid.x.pitch, header.grid.y.pitch, header.grid.z.pitch], [10, 10, 5]);
  assert.deepEqual([header.grid.x.count, header.grid.y.count, header.grid.z.count], [6, 4, 3]);
  assert.deepEqual(header.categories, ['BIF', 'CANGA']);
  // build chunks and verify IJK-exact centers against the source rows
  const frame = documentFrame(header);
  const grid = makeBlockGrid([header.grid.x, header.grid.y, header.grid.z], frame);
  const chunks = [];
  const cb = createBlockChunkBuilder({ frame, grid, chunkSize: 32, seed: 1, onChunk: (c) => chunks.push(c) });
  for await (const rc of streamChunks({ chunkPoints: 16 })) cb.push(rc);
  const doc = cb.flush();
  assert.equal(doc.count, 72);
  const byRec = new Map();                                 // provider record order == shuffled row order
  rows.forEach((r, idx) => byRec.set(idx, r));
  let checked = 0;
  for (const c of chunks) {
    assert.equal(c.kind, 'blocks');
    for (let k = 0; k < c.count; k++) {
      const src = byRec.get(c.recIdx[k]);
      const ctr = blockLocalCenter(c, k);
      const world = [ctr[0] + frame.origin[0], ctr[1] + frame.origin[1], ctr[2] + frame.origin[2]];
      assert.equal(world[0], 612000 + src.i * 10, 'x EXACT');   // IJK-exact: strict equality, no epsilon
      assert.equal(world[1], 7765000 + src.j * 10, 'y EXACT');
      assert.equal(world[2], 400 + src.k * 5, 'z EXACT');
      checked++;
    }
  }
  assert.equal(checked, 72);
  assert.ok(doc.chanRange[0] >= 50 && doc.chanRange[1] <= 61, `chan range ${doc.chanRange}`);
});

test('blocks: irregular coordinates → header.grid is null (points fallback signal)', async () => {
  const csv = 'XC,YC,ZC,FE\n0,0,0,1\n10,0,0,2\n15.5,0,0,3\n25.5,10,5,4\n';
  const { header } = await openBlockModel(new Blob([csv]));
  assert.equal(header.grid, null);
  assert.equal(header.count, 4);
});

// ── M3.5: the .dm provider (grid from the DD, no discovery sweep) ──
import { openDmModel, fetchDmRecord } from '../ext/condenser/src/main.js';
import { makeDM } from './dm-make.mjs';

test('dm provider: grid from DD constants, IJK exact, raw record numbers, categories', async () => {
  // a 6×4×3 block model .dm: definition fields as constants, XC/YC/ZC centroids
  const fields = [
    { name: 'IJK', type: 'N' }, { name: 'XC', type: 'N' }, { name: 'YC', type: 'N' }, { name: 'ZC', type: 'N' },
    { name: 'XINC', type: 'N', constant: 10 }, { name: 'YINC', type: 'N', constant: 10 }, { name: 'ZINC', type: 'N', constant: 5 },
    { name: 'XMORIG', type: 'N', constant: 612000 }, { name: 'YMORIG', type: 'N', constant: 7765000 }, { name: 'ZMORIG', type: 'N', constant: 400 },
    { name: 'NX', type: 'N', constant: 6 }, { name: 'NY', type: 'N', constant: 4 }, { name: 'NZ', type: 'N', constant: 3 },
    { name: 'FE', type: 'N' }, { name: 'LITO', type: 'A', width: 8 },
  ];
  const rows = [], truth = [];
  let rec = 0;
  for (let k = 0; k < 3; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) {
    const r = { IJK: rec, XC: 612000 + i * 10 + 5, YC: 7765000 + j * 10 + 5, ZC: 400 + k * 5 + 2.5, FE: 50 + i + j + k, LITO: k === 2 ? 'CANGA' : 'BIF' };
    rows.push(r); truth.push({ ...r, i, j, k }); rec++;
  }
  rows.splice(30, 0, { IJK: 999, XC: null, YC: null, ZC: null, FE: 0, LITO: 'BAD' });   // a broken row mid-file
  const blob = new Blob([makeDM(fields, rows, { precision: 'ep' })]);
  const { header, streamChunks } = await openDmModel(blob);
  assert.equal(header.count, 73);
  assert.deepEqual([header.grid.x.origin, header.grid.x.pitch, header.grid.x.count], [612005, 10, 6]);
  assert.deepEqual([header.grid.z.origin, header.grid.z.pitch, header.grid.z.count], [402.5, 5, 3]);
  assert.ok(header.numericColumns.some((c) => c.name === 'FE'));
  assert.ok(!header.numericColumns.some((c) => c.name === 'XINC'), 'definition fields are not channels');
  // stream → builder → strict IJK exactness, RAW record numbers preserved past the bad row
  const frame = documentFrame(header);
  const grid = makeBlockGrid([header.grid.x, header.grid.y, header.grid.z], frame);
  const chunks = [];
  const cb = createBlockChunkBuilder({ frame, grid, chunkSize: 32, seed: 1, onChunk: (c) => chunks.push(c) });
  for await (const rc of streamChunks({ chunkPoints: 16 })) cb.push(rc);
  const doc = cb.flush();
  assert.equal(doc.count, 72, 'the broken row was skipped');
  let checked = 0;
  const rowAt = (raw) => rows[raw];                        // RAW record number == position in the file
  for (const c of chunks) for (let k = 0; k < c.count; k++) {
    const src = rowAt(c.recIdx[k]);
    assert.ok(src && src.XC != null, `recIdx ${c.recIdx[k]} maps to a valid source row`);
    const ctr = blockLocalCenter(c, k);
    assert.equal(ctr[0] + frame.origin[0], src.XC, 'x EXACT');
    assert.equal(ctr[2] + frame.origin[2], src.ZC, 'z EXACT');
    checked++;
  }
  assert.equal(checked, 72);
  assert.ok(c0recPast30(chunks), 'record numbers past the bad row are shifted by one (raw numbering)');
  assert.deepEqual([...header.categories].sort(), ['BIF', 'CANGA'], 'category dictionary built during the sweep');
  // O(1) record fetch by raw number
  const vals = await fetchDmRecord(blob, header.dm, 31);   // first row AFTER the bad one
  assert.equal(vals[header.columns.indexOf('XC')], rows[31].XC);
  assert.equal(vals[header.columns.indexOf('LITO')], rows[31].LITO);
});
function c0recPast30(chunks) {
  for (const c of chunks) for (let k = 0; k < c.count; k++) if (c.recIdx[k] === 30) return false;   // 30 is the bad row
  return true;
}

test('dm provider: rejects a non-model .dm with direction', async () => {
  const blob = new Blob([makeDM([{ name: 'BHID', type: 'A', width: 8 }, { name: 'FROM', type: 'N' }, { name: 'TO', type: 'N' }],
    [{ BHID: 'DDH1', FROM: 0, TO: 1 }], { precision: 'ep' })]);
  await assert.rejects(() => openDmModel(blob), /XC|centroid/);
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

// ── PLY provider ──
import { parsePlyHeader, openPly } from '../ext/condenser/src/main.js';

function makePlyData(n, seed = 7) {
  const rnd = mulberry32(seed);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const inten = new Float32Array(n), rgb = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    x[i] = 500000 + rnd() * 400; y[i] = 8200000 + rnd() * 300; z[i] = 900 + rnd() * 80;
    inten[i] = rnd() * 100;
    rgb[3 * i] = (rnd() * 256) | 0; rgb[3 * i + 1] = (rnd() * 256) | 0; rgb[3 * i + 2] = (rnd() * 256) | 0;
  }
  return { x, y, z, inten, rgb };
}
function makePlyBinary(d) {
  const n = d.x.length;
  const head = `ply\nformat binary_little_endian 1.0\ncomment condenser test\nelement vertex ${n}\nproperty double x\nproperty double y\nproperty double z\nproperty float intensity\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const hb = new TextEncoder().encode(head);
  const stride = 8 * 3 + 4 + 3;
  const body = new Uint8Array(n * stride);
  const dv = new DataView(body.buffer);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    dv.setFloat64(o, d.x[i], true); dv.setFloat64(o + 8, d.y[i], true); dv.setFloat64(o + 16, d.z[i], true);
    dv.setFloat32(o + 24, d.inten[i], true);
    body[o + 28] = d.rgb[3 * i]; body[o + 29] = d.rgb[3 * i + 1]; body[o + 30] = d.rgb[3 * i + 2];
  }
  return new Blob([hb, body]);
}
function makePlyAscii(d) {
  const n = d.x.length;
  let s = `ply\nformat ascii 1.0\nelement vertex ${n}\nproperty double x\nproperty double y\nproperty double z\nproperty float intensity\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n`;
  for (let i = 0; i < n; i++) s += `${d.x[i]} ${d.y[i]} ${d.z[i]} ${d.inten[i]} ${d.rgb[3 * i]} ${d.rgb[3 * i + 1]} ${d.rgb[3 * i + 2]}\n`;
  s += '3 0 1 2\n';                                       // a face line after the vertices — must be ignored
  return new Blob([s]);
}

test('ply: header parse — format, count, props, stride, honest rejections', () => {
  const h = parsePlyHeader('ply\nformat binary_little_endian 1.0\nelement vertex 42\nproperty float x\nproperty float y\nproperty float z\nend_header\nBINARY');
  assert.equal(h.format, 'binary_le');
  assert.equal(h.count, 42);
  assert.equal(h.stride, 12);
  assert.equal(h.props[2].offset, 8);
  assert.equal(parsePlyHeader('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n'), null); // no end_header yet
  assert.throws(() => parsePlyHeader('ply\nformat binary_big_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n'), /unsupported format/);
  assert.throws(() => parsePlyHeader('ply\nformat ascii 1.0\nelement face 1\nproperty list uchar int v\nend_header\n'), /vertex must be the first/);
});

test('ply: binary provider — bbox from discovery, chunks + rgb + intensity round-trip, O(1) fetch', async () => {
  const d = makePlyData(3000);
  const { header, streamChunks, fetchRecord } = await openPly(makePlyBinary(d));
  assert.equal(header.count, 3000);
  assert.equal(header.hasRgb, true);
  assert.ok(Math.abs(header.bbox.min[0] - Math.min(...d.x)) < 1e-9);
  assert.ok(Math.abs(header.bbox.max[2] - Math.max(...d.z)) < 1e-9);
  let seen = 0, iLo = Infinity, iHi = -Infinity;
  for await (const c of streamChunks({ chunkPoints: 700 })) {   // ragged boundary on purpose
    for (let i = 0; i < c.count; i++) {
      const rec = c.recStart + i;
      assert.ok(Math.abs(c.x[i] - d.x[rec]) < 1e-9);
      assert.ok(Math.abs(c.z[i] - d.z[rec]) < 1e-9);
      assert.equal(c.rgb[3 * i], d.rgb[3 * rec]);
      if (c.intensity[i] < iLo) iLo = c.intensity[i];
      if (c.intensity[i] > iHi) iHi = c.intensity[i];
    }
    seen += c.count;
  }
  assert.equal(seen, 3000);
  assert.ok(iLo === 0 && iHi > 60000, `intensity normalized to u16 range (got ${iLo}..${iHi})`);
  const rec = await fetchRecord(1234);
  assert.ok(Math.abs(rec[0] - d.x[1234]) < 1e-9 && Math.abs(rec[3] - d.inten[1234]) < 1e-5);
  assert.equal(rec[4], d.rgb[3 * 1234]);
  assert.equal(await fetchRecord(3000), null);
});

test('ply: ascii provider matches binary — same positions, face lines ignored', async () => {
  const d = makePlyData(500, 11);
  const a = await openPly(makePlyAscii(d));
  assert.equal(a.header.count, 500);
  let seen = 0;
  for await (const c of a.streamChunks({ chunkPoints: 128 })) {
    for (let i = 0; i < c.count; i++) {
      const rec = c.recStart + i;
      assert.ok(Math.abs(c.x[i] - d.x[rec]) < 1e-6);
      assert.equal(c.rgb[3 * i + 2], d.rgb[3 * rec + 2]);
    }
    seen += c.count;
  }
  assert.equal(seen, 500);
  const rec = await a.fetchRecord(250);
  assert.ok(Math.abs(rec[1] - d.y[250]) < 1e-6);
});

// ── sparse line-offset index (fetchDelimitedRecord) ──
import { fetchDelimitedRecord } from '../ext/condenser/src/main.js';

test('blockmodel: sparse index — anchors sized right, indexed fetch == full parse (CRLF, comments, broken rows, multi-byte)', async () => {
  // a deliberately nasty file: CRLF endings, comment + blank lines sprinkled in,
  // rows with junk coords (skipped — record numbers count ACCEPTED rows only),
  // and multi-byte category values (byte offset ≠ char offset)
  const rows = [];
  let txt = 'XC,YC,ZC,FE,LITO\r\n';
  let n = 0;
  for (let i = 0; i < 5000; i++) {
    if (i % 97 === 0) { txt += '# a comment line\r\n'; }
    if (i % 131 === 0) { txt += '\r\n'; }
    if (i % 53 === 7) { txt += `bad,${i},row,x,JUNK\r\n`; continue; }   // non-finite coords → skipped
    const x = 612000 + (i % 40) * 10, y = 8_200_000 + Math.floor(i / 40) * 10, z = 900 + (i % 5) * 5;
    const lito = i % 3 === 0 ? 'HEMATITA-AÇAÍ' : 'CANGA-ÀTÉ';
    const fe = (30 + (i % 40) * 0.83).toFixed(2);
    txt += `${x},${y},${z},${fe},${lito}\r\n`;
    rows.push([String(x), String(y), String(z), fe, lito]);
    n++;
  }
  const { header } = await openBlockModel(new Blob([txt]), { indexEvery: 64 });
  assert.equal(header.count, n);
  assert.ok(header.index && header.index.k === 64);
  assert.equal(header.index.offsets.length, Math.ceil(n / 64));

  // fetch parity at awkward spots: first, last, either side of anchors, mid-run
  for (const rec of [0, 1, 63, 64, 65, 1000, 2500, n - 2, n - 1]) {
    const f = await fetchDelimitedRecord(new Blob([txt]), header, rec);
    assert.ok(f, `record ${rec} found`);
    assert.deepEqual(f.slice(0, 5), rows[rec], `record ${rec} matches the full parse`);
  }
  assert.equal(await fetchDelimitedRecord(new Blob([txt]), header, n), null);
  assert.equal(await fetchDelimitedRecord(new Blob([txt]), header, -1), null);
});

test('blockmodel: sparse index — headerless whitespace dump (generated names path)', async () => {
  let txt = '';
  const rows = [];
  for (let i = 0; i < 300; i++) {
    txt += `${500000 + i * 2}.50 ${8200000 + i}.25 ${900 + (i % 9)}.00 ${(i * 0.7).toFixed(3)}\n`;
    rows.push(i);
  }
  const { header } = await openBlockModel(new Blob([txt]), { indexEvery: 32 });
  assert.equal(header.count, 300);
  assert.equal(header.hasHeaderRow, false);
  const f = await fetchDelimitedRecord(new Blob([txt]), header, 200);
  assert.equal(f[0], `${500000 + 200 * 2}.50`);
  assert.equal(f[3], (200 * 0.7).toFixed(3));
});

// ── drillhole provider ──
import { classifyDrillholeHeader, sniffDrillholeFiles, openDrillholes } from '../ext/condenser/src/main.js';

test('drillholes: header classification (collar / survey / intervals)', () => {
  assert.equal(classifyDrillholeHeader(['BHID', 'X', 'Y', 'Z', 'EOH']).role, 'collar');
  assert.equal(classifyDrillholeHeader(['HOLEID', 'AT', 'AZIMUTH', 'DIP']).role, 'survey');
  assert.equal(classifyDrillholeHeader(['DHID', 'FROM', 'TO', 'FE', 'LITO']).role, 'intervals');
  assert.equal(classifyDrillholeHeader(['XC', 'YC', 'ZC', 'FE']), null);          // no BHID → not drillholes
  const s = classifyDrillholeHeader(['bhid', 'depth', 'brg', 'incl']);
  assert.equal(s.role, 'survey');                                                  // alias names
});

test('drillholes: desurveyed midpoints — analytic positions, identity through the sort, report', async () => {
  const collar = new Blob(['BHID,X,Y,Z,EOH\nV1,1000,2000,500,100\nI1,1200,2000,500,100\nNS,1400,2000,500,50\n']);
  const survey = new Blob(['BHID,AT,AZ,DIP\nV1,0,0,90\nI1,0,90,45\n']);            // NS: no survey → straight down
  // interval rows DELIBERATELY out of hole/depth order — the identity must survive
  const intervals = new Blob([
    'BHID,FROM,TO,FE,LITO\n' +
    'I1,20,30,55.5,HEMATITE\n' +      // row 0
    'V1,10,12,42.0,ITABIRITE\n' +     // row 1
    'GHOST,0,2,9.9,WASTE\n' +         // row 2: orphan (no collar)
    'V1,0,2,30.1,CANGA\n' +           // row 3 (shallower than row 1 — sorts first)
    'NS,4,6,12.3,WASTE\n',            // row 4: the no-survey hole
  ]);
  const { header, streamChunks, fetchRecord } = await openDrillholes({ collar, survey, intervals });
  assert.equal(header.kind, 'drillholes');
  assert.equal(header.count, 5);                          // ORIGINAL interval rows (incl. the orphan)
  assert.equal(header.placed, 4);                         // orphan excluded from placement
  assert.equal(header.holes, 3);
  assert.deepEqual(header.categories, ['CANGA', 'HEMATITE', 'ITABIRITE', 'WASTE']);
  assert.ok(header.report.checks.some((c) => c.id === 'orphan-sample' && c.bhids.includes('GHOST')));
  assert.ok(header.report.checks.some((c) => c.id === 'collar-no-survey' && c.bhids.includes('NS')));

  const placed = new Map();                               // recIdx → [x,y,z,chan]
  for await (const rc of streamChunks({ chunkPoints: 3 })) {
    for (let i = 0; i < rc.count; i++) placed.set(rc.recIdx[i], [rc.x[i], rc.y[i], rc.z[i], rc.chan[i]]);
  }
  assert.equal(placed.size, 4);
  assert.ok(!placed.has(2));                              // the orphan never renders
  // V1 vertical: mid 11 → (1000, 2000, 489); mid 1 → z 499
  const v1a = placed.get(1), v1b = placed.get(3);
  assert.ok(Math.abs(v1a[0] - 1000) < 1e-9 && Math.abs(v1a[2] - 489) < 1e-9);
  assert.ok(Math.abs(v1b[2] - 499) < 1e-9);
  assert.ok(Math.abs(v1a[3] - 42.0) < 1e-9 && Math.abs(v1b[3] - 30.1) < 1e-9);     // chan follows the SOURCE row
  // I1 az 90 dip 45: mid 25 → collar + 25·(√2/2, 0, -√2/2)
  const i1 = placed.get(0), c = Math.SQRT1_2 * 25;
  assert.ok(Math.abs(i1[0] - (1200 + c)) < 1e-9 && Math.abs(i1[1] - 2000) < 1e-9 && Math.abs(i1[2] - (500 - c)) < 1e-9);
  // NS straight-down fallback: mid 5 → z 495 under the collar
  const ns = placed.get(4);
  assert.ok(Math.abs(ns[0] - 1400) < 1e-9 && Math.abs(ns[2] - 495) < 1e-9);

  // the pick join: fetchRecord returns the ORIGINAL row
  assert.deepEqual(fetchRecord(0).slice(0, 5), ['I1', '20', '30', '55.5', 'HEMATITE']);
  assert.equal(fetchRecord(5), null);
});

test('drillholes: method + dip convention options thread through', async () => {
  const collar = new Blob(['BHID,X,Y,Z\nA,0,0,0\n']);
  const surveyNeg = new Blob(['BHID,AT,AZ,DIP\nA,0,0,-90\n']);                     // neg-down file
  const intervals = new Blob(['BHID,FROM,TO,AU\nA,8,12,1.5\n']);
  const { header, streamChunks } = await openDrillholes(
    { collar, survey: surveyNeg, intervals },
    { method: 'tangential', dipConvention: 'auto' },
  );
  assert.equal(header.dipConvention, 'neg-down');                                  // detected
  assert.equal(header.method, 'tangential');
  for await (const rc of streamChunks()) assert.ok(Math.abs(rc.z[0] - (-10)) < 1e-9);   // still goes DOWN
});

test('drillholes: sniffDrillholeFiles recognizes a trio in any order', async () => {
  const mk = (t, name) => { const f = new Blob([t]); f.name = name; return f; };
  const trio = await sniffDrillholeFiles([
    mk('BHID,FROM,TO,FE\nA,0,2,50\n', 'assay.csv'),
    mk('BHID,X,Y,Z\nA,0,0,0\n', 'collars.csv'),
    mk('BHID,AT,AZ,DIP\nA,0,0,90\n', 'survey.csv'),
  ]);
  assert.ok(trio && trio.collar.name === 'collars.csv' && trio.survey.name === 'survey.csv' && trio.intervals.name === 'assay.csv');
  const notTrio = await sniffDrillholeFiles([mk('XC,YC,ZC,FE\n1,2,3,4\n', 'model.csv')]);
  assert.equal(notTrio, null);
});
