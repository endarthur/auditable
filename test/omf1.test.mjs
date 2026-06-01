// @gcu/omf1 — OMF v1 reader/writer. Round-trip is the core correctness proof
// (write → read → deep-equal arrays + metadata); plus header/uuid/helper units.
// Cross-validation against real Leapfrog/Vulcan/Python-omf files (spec §9.3)
// needs reference .omf files and is a separate follow-up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readOMF, openOMF, writeOMF, blockModelGrid, blockModelCentroids, formatUUID, parseUUID, readHeader } from '../ext/omf1/index.js';

function sampleProject() {
  return {
    type: 'Project', name: 'Test', description: 'a project', origin: [1000, 2000, 0],
    date_created: '2026-06-01T00:00:00Z', date_modified: '2026-06-01T00:00:00Z',
    elements: [
      {
        type: 'VolumeElement', name: 'bm', description: 'block model', color: null,
        geometry: {
          type: 'VolumeGridGeometry', origin: [0, 0, 0],
          axis_u: [1, 0, 0], axis_v: [0, 1, 0], axis_w: [0, 0, 1],
          tensor_u: new Float64Array([10, 10, 10]), tensor_v: new Float64Array([10, 10]), tensor_w: new Float64Array([5]),
        },
        data: [
          { type: 'ScalarData', name: 'au', description: 'gold', location: 'cells', colormap: null, array: new Float64Array([1, 2, 3, 4, 5, 6]) },
          {
            type: 'MappedData', name: 'lito', description: 'lithology', location: 'cells',
            indices: new BigInt64Array([0n, 1n, 0n, 1n, 2n, 0n]),
            legends: [{ type: 'Legend', name: 'rock', values: new Float64Array([0, 1, 2]) }],
          },
        ],
      },
      {
        type: 'PointSetElement', name: 'pts', description: '', color: [255, 0, 0],
        geometry: { type: 'PointSetGeometry', vertices: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]) },
        data: [{ type: 'ScalarData', name: 'g', description: '', location: 'vertices', colormap: null, array: new Float64Array([0.1, 0.2, 0.3]) }],
      },
      {
        type: 'SurfaceElement', name: 'surf', description: '', color: null, textures: [],
        geometry: { type: 'SurfaceGeometry', vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: new BigInt64Array([0n, 1n, 2n]) },
        data: [],
      },
    ],
  };
}

describe('omf1 round-trip', () => {
  it('write → read preserves project metadata', async () => {
    const p = await readOMF(await writeOMF(sampleProject()));
    assert.equal(p.type, 'Project');
    assert.equal(p.name, 'Test');
    assert.equal(p.description, 'a project');
    assert.deepEqual(p.origin, [1000, 2000, 0]);
    assert.equal(p.elements.length, 3);
    assert.deepEqual(p.elements.map((e) => e.type), ['VolumeElement', 'PointSetElement', 'SurfaceElement']);
  });

  it('preserves a volume grid geometry + scalar + mapped data', async () => {
    const p = await readOMF(await writeOMF(sampleProject()));
    const vol = p.elements.find((e) => e.type === 'VolumeElement');
    assert.deepEqual(vol.geometry.tensor_u, new Float64Array([10, 10, 10]));
    assert.deepEqual(vol.geometry.tensor_v, new Float64Array([10, 10]));
    assert.deepEqual(vol.geometry.tensor_w, new Float64Array([5]));
    assert.deepEqual(vol.geometry.axis_w, [0, 0, 1]);

    const au = vol.data.find((d) => d.name === 'au');
    assert.equal(au.type, 'ScalarData');
    assert.equal(au.location, 'cells');
    assert.deepEqual(au.array, new Float64Array([1, 2, 3, 4, 5, 6]));

    const lito = vol.data.find((d) => d.name === 'lito');
    assert.equal(lito.type, 'MappedData');
    assert.deepEqual(lito.indices, new BigInt64Array([0n, 1n, 0n, 1n, 2n, 0n]));
    assert.equal(lito.legends.length, 1);
    assert.deepEqual(lito.legends[0].values, new Float64Array([0, 1, 2]));
  });

  it('preserves pointset + surface geometry (incl. int64 index arrays + color)', async () => {
    const p = await readOMF(await writeOMF(sampleProject()));
    const pts = p.elements.find((e) => e.type === 'PointSetElement');
    assert.deepEqual(pts.geometry.vertices, new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]));
    assert.deepEqual(pts.color, [255, 0, 0]);
    assert.deepEqual(pts.data[0].array, new Float64Array([0.1, 0.2, 0.3]));

    const surf = p.elements.find((e) => e.type === 'SurfaceElement');
    assert.deepEqual(surf.geometry.triangles, new BigInt64Array([0n, 1n, 2n]));
  });
});

describe('omf1 lazy reader (openOMF)', () => {
  it('returns array stubs + loads on demand', async () => {
    const reader = await openOMF(await writeOMF(sampleProject()));
    const vol = reader.project.elements.find((e) => e.type === 'VolumeElement');
    const au = vol.data.find((d) => d.name === 'au');
    assert.equal(au.array.__arrayRef, true);                 // stub, not loaded
    assert.equal(au.array.dtype, '<f8');
    const arr = await reader.loadArray(au.array);
    assert.deepEqual(arr, new Float64Array([1, 2, 3, 4, 5, 6]));
    reader.close();
  });
});

describe('omf1 header + uuid', () => {
  it('written bytes carry a valid header', async () => {
    const bytes = await writeOMF(sampleProject());
    const h = readHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.ok(h.version.startsWith('OMF-v0.9'));
    assert.ok(h.jsonStart >= 60);
    assert.match(h.uid, /^[0-9a-f-]{36}$/);
  });
  it('rejects non-OMF bytes', async () => {
    await assert.rejects(() => readOMF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer), /bad magic/);
  });
  it('uuid format/parse round-trips', () => {
    const u = '12345678-9abc-def0-1234-56789abcdef0';
    assert.equal(formatUUID(parseUUID(u)), u);
  });
});

describe('omf1 block-model helpers', () => {
  const geom = {
    type: 'VolumeGridGeometry', origin: [100, 200, 0],
    axis_u: [1, 0, 0], axis_v: [0, 1, 0], axis_w: [0, 0, 1],
    tensor_u: new Float64Array([10, 10, 10]), tensor_v: new Float64Array([10, 10]), tensor_w: new Float64Array([5, 5]),
  };
  it('blockModelGrid → [nu, nv, nw]', () => {
    assert.deepEqual(blockModelGrid(geom), [3, 2, 2]);
  });
  it('blockModelCentroids → N×3, first centroid offset by half-cell from origin', () => {
    const c = blockModelCentroids(geom);
    assert.equal(c.length, 3 * 2 * 2 * 3);
    // first cell centroid = origin + half of first tensor on each axis
    assert.deepEqual([c[0], c[1], c[2]], [100 + 5, 200 + 5, 0 + 2.5]);
  });
});
