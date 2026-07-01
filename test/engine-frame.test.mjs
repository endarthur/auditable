// Frame-awareness for the point-in-solid engines (peel + winding). A frame rebases
// world → a small-magnitude local origin at full f64 BEFORE the f32/GPU downcast, so
// meshes sited at projected magnitudes (UTM northing ~7.7e6) evaluate correctly instead
// of collapsing against the float32 wall. These run on node's main-thread CPU path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peel } from '../ext/peel/src/main.js';
import { Winding } from '../ext/winding/src/main.js';
import { makeFrame, toLocalCoords } from '../ext/frame/src/frame.js';

const O = [600000, 7700000, 400];                 // QF-flavoured UTM origin (E, N, RL)
const FRAME = makeFrame({ origin: O, crs: 'EPSG:31983', units: 'm' });

// Axis-aligned box as flat verts (typed per caller) + a shared triangle list.
function boxVerts(x0, y0, z0, x1, y1, z1, Arr = Float64Array) {
  return new Arr([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
}
const BOX_TRIS = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);

// mode:'flag' is supported by both engines; flags are a clean integer equality.
const CASES = [
  { name: 'peel', Engine: Peel, opts: { mode: 'flag', axis: 'z', surfaceType: 'closed', maxPeels: 16 } },
  { name: 'winding', Engine: Winding, opts: { mode: 'flag', threshold: 0.5 } },
];

async function flags(Engine, verts, bm, opts, frame) {
  const e = await Engine.create();                // main-thread CPU (no worker/GPU in node)
  e.setMesh(verts, BOX_TRIS, frame ? { frame } : {});
  const r = await e.evaluate(bm, frame ? { ...opts, frame } : opts);
  return r.flags;
}

// The whole reason a frame is needed: at a UTM northing the f32 ULP is ~0.5 m, so a
// bare Float32Array throws away sub-metre detail — a large fraction of a small block.
// Rebasing to the local frame first shrinks that error by ~7 orders of magnitude.
test('frame: rebasing collapses the f32 representation error at UTM magnitudes', () => {
  const y = 7700000.3;                             // a sub-metre northing detail
  const worldErr = Math.abs(Float32Array.from([y])[0] - y);
  assert.ok(worldErr > 0.15, `world f32 error only ${worldErr} m`);   // ~0.2 m lost outright at 7.7e6
  const local = toLocalCoords(new Float64Array([O[0], y, O[2]]), FRAME)[1];  // 0.3
  const localErr = Math.abs(Float32Array.from([local])[0] - local);
  assert.ok(localErr < 1e-4, `local f32 error ${localErr} m`);        // negligible once small
});

for (const { name, Engine, opts } of CASES) {
  test(`${name}: a framed UTM-sited box == the origin reference (bit-identical flags)`, async () => {
    const bmRef = { origin: [-1.75, -1.75, -1.75], size: [0.5, 0.5, 0.5], count: [8, 8, 8] };
    // Reference: box near origin, small coords, no frame (today's path).
    const ref = await flags(Engine, boxVerts(-1, -1, -1, 1, 1, 1, Float32Array), bmRef, opts, null);
    // Same geometry translated to UTM, f64 world verts + a frame at O.
    const utmVerts = boxVerts(O[0] - 1, O[1] - 1, O[2] - 1, O[0] + 1, O[1] + 1, O[2] + 1, Float64Array);
    const bmUtm = { origin: [O[0] - 1.75, O[1] - 1.75, O[2] - 1.75], size: [0.5, 0.5, 0.5], count: [8, 8, 8] };
    const utm = await flags(Engine, utmVerts, bmUtm, opts, FRAME);
    assert.equal(utm.length, ref.length);
    let diff = 0;
    for (let i = 0; i < ref.length; i++) if (utm[i] !== ref[i]) diff++;
    assert.equal(diff, 0, `${diff} of ${ref.length} blocks differ between framed-UTM and reference`);
    assert.ok(ref.some((f) => f === 1), 'sanity: some interior blocks are flagged');
  });

  test(`${name}: guard — evaluate on a framed mesh without a frame throws`, async () => {
    const e = await Engine.create();
    e.setMesh(boxVerts(O[0] - 1, O[1] - 1, O[2] - 1, O[0] + 1, O[1] + 1, O[2] + 1), BOX_TRIS, { frame: FRAME });
    await assert.rejects(() => e.evaluate({ origin: O, size: [1, 1, 1], count: [2, 2, 2] }, opts), /frame/);
  });

  test(`${name}: guard — a mismatched frame throws (rebases, never reprojects)`, async () => {
    const e = await Engine.create();
    e.setMesh(boxVerts(O[0] - 1, O[1] - 1, O[2] - 1, O[0] + 1, O[1] + 1, O[2] + 1), BOX_TRIS, { frame: FRAME });
    const other = makeFrame({ origin: [0, 0, 0] });
    await assert.rejects(() => e.evaluate({ origin: O, size: [1, 1, 1], count: [2, 2, 2] }, { ...opts, frame: other }), /reprojects|frame/);
  });

  test(`${name}: evaluateMultiple over two framed surfaces shares the frame`, async () => {
    const e = await Engine.create();
    e.setMesh(boxVerts(O[0] - 1, O[1] - 1, O[2] - 1, O[0] + 1, O[1] + 1, O[2] + 1), BOX_TRIS, { name: 'a', frame: FRAME });
    e.setMesh(boxVerts(O[0], O[1], O[2], O[0] + 2, O[1] + 2, O[2] + 2), BOX_TRIS, { name: 'b', frame: FRAME });
    const bm = { origin: [O[0] - 1, O[1] - 1, O[2] - 1], size: [0.5, 0.5, 0.5], count: [8, 8, 8] };
    const res = await e.evaluateMultiple(bm, { surfaces: ['a', 'b'], ...opts, frame: FRAME });
    assert.ok(res.a.flags && res.b.flags, 'both surfaces evaluated');
    assert.ok(res.a.flags.some((f) => f === 1) && res.b.flags.some((f) => f === 1));
  });
}
