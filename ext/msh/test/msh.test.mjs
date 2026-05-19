// @gcu/msh tests — round-trip, validation, error shapes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readMSH, writeMSH, MSHError } from '../msh.js';
import { mshCentroid, mshUnionCentroid, addMSHtoDee } from '../dee-adapter.js';

// Build a minimal valid .msh by hand. Used by every unit test that
// doesn't need real-world data.
function makeMinimalMsh({
  vertices = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),  // 3 verts
  triangles = new Int32Array([0, 1, 2]),                       // 1 tri
  extraSignature = null,
} = {}) {
  const vCount = vertices.length / 3;
  const tCount = triangles.length / 3;
  const headerText =
    '%ARANZ-1.0\n\n' +
    '[index]\n' +
    `Location Double 3 ${vCount};\n` +
    `Tri Integer 3 ${tCount};\n\n` +
    '[binary]';
  const headerBytes = new TextEncoder().encode(headerText);
  const sig = extraSignature || new Uint8Array([
    0xFF, 0x0F, 0xF0, 0x00, 0x1B, 0xDE, 0x83, 0x42,
    0xCA, 0xC0, 0xF3, 0x3F,
  ]);
  const vertBytes = new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const triBytes = new Uint8Array(triangles.buffer, triangles.byteOffset, triangles.byteLength);
  const total = headerBytes.length + sig.length + vertBytes.length + triBytes.length;
  const buf = new Uint8Array(total);
  let o = 0;
  buf.set(headerBytes, o); o += headerBytes.length;
  buf.set(sig, o);         o += sig.length;
  buf.set(vertBytes, o);   o += vertBytes.length;
  buf.set(triBytes, o);
  return buf;
}

describe('readMSH — minimal valid file', () => {
  it('decodes magic version and array declarations', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    assert.equal(r.version, '1.0');
    assert.equal(r.arrays.size, 2);
    assert.ok(r.arrays.has('Location'));
    assert.ok(r.arrays.has('Tri'));
  });

  it('preserves declaration order in the Map', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    assert.deepEqual([...r.arrays.keys()], ['Location', 'Tri']);
  });

  it('decodes vertex data as Float64Array', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    const loc = r.arrays.get('Location');
    assert.equal(loc.type, 'Double');
    assert.equal(loc.components, 3);
    assert.equal(loc.count, 3);
    assert.ok(loc.data instanceof Float64Array);
    assert.equal(loc.data.length, 9);
    assert.deepEqual([...loc.data], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('decodes triangle data as Int32Array', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    const tri = r.arrays.get('Tri');
    assert.equal(tri.type, 'Integer');
    assert.ok(tri.data instanceof Int32Array);
    assert.deepEqual([...tri.data], [0, 1, 2]);
  });

  it('exposes vertices / triangles as convenience accessors', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    assert.ok(r.vertices instanceof Float64Array);
    assert.ok(r.triangles instanceof Int32Array);
    assert.equal(r.vertices, r.arrays.get('Location').data);
    assert.equal(r.triangles, r.arrays.get('Tri').data);
  });

  it('captures the 12-byte signature', async () => {
    const buf = makeMinimalMsh();
    const r = await readMSH(buf);
    assert.equal(r.binarySignature.length, 12);
    assert.deepEqual([...r.binarySignature], [
      0xFF, 0x0F, 0xF0, 0x00, 0x1B, 0xDE, 0x83, 0x42,
      0xCA, 0xC0, 0xF3, 0x3F,
    ]);
  });

  it('preserves a non-default signature on round-trip', async () => {
    const custom = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const buf = makeMinimalMsh({ extraSignature: custom });
    const r = await readMSH(buf);
    assert.deepEqual([...r.binarySignature], [...custom]);
  });
});

describe('readMSH — error cases', () => {
  it('throws on missing magic', async () => {
    const buf = new TextEncoder().encode('not an msh file');
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('throws on missing [binary] section', async () => {
    const buf = new TextEncoder().encode('%ARANZ-1.0\n\n[index]\nFoo Double 1 1;\n');
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('throws on empty [index]', async () => {
    const buf = new TextEncoder().encode('%ARANZ-1.0\n\n[index]\n\n[binary]            ');
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('throws on unsupported type', async () => {
    const buf = new TextEncoder().encode(
      '%ARANZ-1.0\n\n[index]\nFoo Quaternion 4 1;\n\n[binary]' +
      // 12 sig + some payload
      '\x00'.repeat(12 + 16)
    );
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('throws on declared/actual byte mismatch', async () => {
    // Claim 100 vertices but provide 3.
    const headerText =
      '%ARANZ-1.0\n\n[index]\nLocation Double 3 100;\nTri Integer 3 1;\n\n[binary]';
    const headerBytes = new TextEncoder().encode(headerText);
    const tail = new Uint8Array(12 + 9 * 8 + 3 * 4);  // sig + 3 verts + 1 tri
    const buf = new Uint8Array(headerBytes.length + tail.length);
    buf.set(headerBytes, 0);
    buf.set(tail, headerBytes.length);
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('throws on out-of-range triangle index', async () => {
    const buf = makeMinimalMsh({
      vertices: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),  // 3 verts
      triangles: new Int32Array([0, 1, 99]),                     // 99 is OOR
    });
    await assert.rejects(() => readMSH(buf), MSHError);
  });

  it('validateIndices=false skips the OOR check', async () => {
    const buf = makeMinimalMsh({
      vertices: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      triangles: new Int32Array([0, 1, 99]),
    });
    const r = await readMSH(buf, { validateIndices: false });
    assert.equal(r.triangles[2], 99);
  });
});

describe('writeMSH — round-trip', () => {
  it('byte-identical round-trip of a hand-built file', async () => {
    const original = makeMinimalMsh();
    const decoded = await readMSH(original);
    const re = await writeMSH(decoded);
    assert.equal(re.length, original.length, 'byte length matches');
    for (let i = 0; i < original.length; i++) {
      assert.equal(re[i], original[i], `byte ${i} matches`);
    }
  });

  it('accepts plain object for arrays', async () => {
    const buf = await writeMSH({
      version: '1.0',
      arrays: {
        Location: {
          type: 'Double', components: 3, count: 2,
          data: new Float64Array([0, 0, 0, 1, 1, 1]),
        },
        Tri: {
          type: 'Integer', components: 3, count: 0,
          data: new Int32Array([]),
        },
      },
    });
    const r = await readMSH(buf);
    assert.equal(r.vertices.length, 6);
    assert.equal(r.triangles.length, 0);
  });

  it('throws when array data length disagrees with declaration', async () => {
    await assert.rejects(() => writeMSH({
      arrays: { Bad: { type: 'Double', components: 3, count: 10, data: new Float64Array([0, 0, 0]) } },
    }), MSHError);
  });

  it('throws on bad signature length', async () => {
    await assert.rejects(() => writeMSH({
      arrays: {
        L: { type: 'Double', components: 1, count: 1, data: new Float64Array([1]) },
      },
      binarySignature: new Uint8Array([1, 2, 3]),  // too short
    }), MSHError);
  });

  it('throws on empty arrays input', async () => {
    await assert.rejects(() => writeMSH({ arrays: {} }), MSHError);
  });
});

describe('readMSH — real-world files', () => {
  // Use the user's actual MacPass files if present. We treat them as
  // optional — CI without them just skips.
  const fixtures = [
    { name: 'MacPassHG', path: 'C:/Users/endar/Downloads/MacPassHG.msh', verts: 16615, tris: 33222 },
    { name: 'MacPassLG', path: 'C:/Users/endar/Downloads/MacPassLG.msh', verts: 80616, tris: 161228 },
  ];

  for (const fx of fixtures) {
    it(`${fx.name} decodes with expected counts`, async (t) => {
      let buf;
      try { buf = await fs.readFile(fx.path); }
      catch { t.skip(`${fx.name} fixture not available`); return; }
      const r = await readMSH(buf);
      assert.equal(r.version, '1.0');
      assert.equal(r.vertices.length / 3, fx.verts);
      assert.equal(r.triangles.length / 3, fx.tris);
      // Triangle indices are all in range (validateIndices is on by default).
      // First vertex coordinates make geographic sense for MacPass (UTM-ish).
      assert.ok(r.vertices[0] > 100000 && r.vertices[0] < 1000000,
        `expected UTM-shape easting, got ${r.vertices[0]}`);
    });

    it(`${fx.name} round-trips byte-identically`, async (t) => {
      let original;
      try { original = await fs.readFile(fx.path); }
      catch { t.skip(`${fx.name} fixture not available`); return; }
      const decoded = await readMSH(original);
      const re = await writeMSH(decoded);
      assert.equal(re.length, original.length, 'byte length matches');
      // Spot-check the magic header and the signature.
      const headerEnd = original.indexOf(']', original.indexOf('[binary]')) + 1;
      for (let i = 0; i < headerEnd + 12; i++) {
        if (re[i] !== original[i]) {
          assert.fail(`header/signature byte ${i} mismatch: got ${re[i]}, expected ${original[i]}`);
        }
      }
      // Spot-check 100 random bytes from the binary payload.
      const len = original.length;
      let mismatches = 0;
      for (let i = 0; i < 100; i++) {
        const pos = Math.floor(Math.random() * len);
        if (re[pos] !== original[pos]) mismatches++;
      }
      assert.equal(mismatches, 0, '100 random bytes match');
      // And the very last byte.
      assert.equal(re[len - 1], original[len - 1], 'last byte matches');
    });
  }
});

// ── dee-adapter pure helpers (no Three.js required) ──

describe('dee-adapter — mshCentroid', () => {
  it('returns midpoint of axis-aligned bbox', async () => {
    const r = await readMSH(makeMinimalMsh({
      vertices: new Float64Array([0, 0, 0,   10, 20, 30,   -2, -4, -6]),
      triangles: new Int32Array([0, 1, 2]),
    }));
    const [cx, cy, cz] = mshCentroid(r);
    // min (-2,-4,-6) max (10,20,30) → mid (4,8,12).
    assert.equal(cx, 4);
    assert.equal(cy, 8);
    assert.equal(cz, 12);
  });

  it('returns [0,0,0] for an empty result', () => {
    assert.deepEqual(mshCentroid({ vertices: new Float64Array() }), [0, 0, 0]);
    assert.deepEqual(mshCentroid({}), [0, 0, 0]);
  });
});

describe('dee-adapter — mshUnionCentroid', () => {
  it('spans the union bbox across multiple results', async () => {
    const a = await readMSH(makeMinimalMsh({
      vertices: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      triangles: new Int32Array([0, 1, 2]),
    }));
    const b = await readMSH(makeMinimalMsh({
      vertices: new Float64Array([10, 10, 10, 20, 20, 20, 30, 30, 30]),
      triangles: new Int32Array([0, 1, 2]),
    }));
    // union min (0,0,0) max (30,30,30) → mid (15,15,15).
    assert.deepEqual(mshUnionCentroid([a, b]), [15, 15, 15]);
  });

  it('skips empty inputs', async () => {
    assert.deepEqual(mshUnionCentroid([]), [0, 0, 0]);
    assert.deepEqual(mshUnionCentroid([{ vertices: new Float64Array() }]), [0, 0, 0]);
  });
});

describe('dee-adapter — addMSHtoDee', () => {
  // Fake `dee`: captures the addSurface call so we can assert on the
  // positions / indices / color / metadata without pulling Three.js.
  function makeFakeDee(origin) {
    const calls = [];
    return {
      dee: {
        origin,
        addSurface(name, opts) {
          const layer = { name, opts };
          calls.push(layer);
          return layer;
        },
      },
      calls,
    };
  }

  it('recentres positions in F64 relative to dee.origin', async () => {
    const r = await readMSH(makeMinimalMsh({
      vertices: new Float64Array([100, 200, 300, 101, 201, 301, 102, 202, 302]),
      triangles: new Int32Array([0, 1, 2]),
    }));
    const { dee, calls } = makeFakeDee([100, 200, 300]);
    addMSHtoDee(dee, r, { color: 0x123456 });
    assert.equal(calls.length, 1);
    const pos = calls[0].opts.positions;
    assert.ok(pos instanceof Float64Array, 'positions stays F64 pre-downcast');
    assert.deepEqual([...pos], [0, 0, 0,   1, 1, 1,   2, 2, 2]);
  });

  it('forwards color as 0xRRGGBB int', async () => {
    const r = await readMSH(makeMinimalMsh());
    const { dee, calls } = makeFakeDee([0, 0, 0]);
    addMSHtoDee(dee, r, { color: 0xff8800 });
    assert.equal(calls[0].opts.color, 0xff8800);
  });

  it('accepts {r,g,b} colour input', async () => {
    const r = await readMSH(makeMinimalMsh());
    const { dee, calls } = makeFakeDee([0, 0, 0]);
    addMSHtoDee(dee, r, { color: { r: 0x33, g: 0x66, b: 0x99 } });
    assert.equal(calls[0].opts.color, 0x336699);
  });

  it('floors low-luminance colours unless disabled', async () => {
    const r = await readMSH(makeMinimalMsh());
    const { dee: d1, calls: c1 } = makeFakeDee([0, 0, 0]);
    addMSHtoDee(d1, r, { color: 0x000000 });
    // Default substitute is the slight-blue charcoal (82,82,92).
    assert.equal(c1[0].opts.color, ((82 << 16) | (82 << 8) | 92));
    // With threshold:0 the floor is disabled.
    const { dee: d2, calls: c2 } = makeFakeDee([0, 0, 0]);
    addMSHtoDee(d2, r, { color: 0x000000, luminance: { threshold: 0 } });
    assert.equal(c2[0].opts.color, 0x000000);
  });

  it('passes through opacity / wireframe / renderOrder / polygonOffset', async () => {
    const r = await readMSH(makeMinimalMsh());
    const { dee, calls } = makeFakeDee([0, 0, 0]);
    addMSHtoDee(dee, r, {
      name: 'HG',
      opacity: 0.6,
      wireframe: true,
      renderOrder: -1000,
      polygonOffset: 3,
    });
    const opts = calls[0].opts;
    assert.equal(calls[0].name, 'HG');
    assert.equal(opts.opacity, 0.6);
    assert.equal(opts.wireframe, true);
    assert.equal(opts.renderOrder, -1000);
    assert.equal(opts.polygonOffset, 3);
    assert.equal(opts.localCoords, true);
  });

  it('attaches _meta with arrays and binarySignature for round-trip', async () => {
    const r = await readMSH(makeMinimalMsh());
    const { dee } = makeFakeDee([0, 0, 0]);
    const layer = addMSHtoDee(dee, r);
    assert.ok(layer._meta);
    assert.ok(layer._meta.arrays instanceof Map);
    assert.equal(layer._meta.binarySignature.length, 12);
    assert.equal(layer._meta.vCount, 3);
    assert.equal(layer._meta.tCount, 1);
  });

  it('throws if vertices/triangles are missing', () => {
    const fakeResult = { vertices: undefined, triangles: undefined };
    const { dee } = makeFakeDee([0, 0, 0]);
    assert.throws(() => addMSHtoDee(dee, fakeResult), /vertices/);
  });
});
