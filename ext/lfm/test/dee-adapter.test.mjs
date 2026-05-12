// @gcu/lfm/dee-adapter — node-runnable smoke tests using a mock dee
// instance. The real dee depends on Three.js + a DOM, but the adapter's
// contract (vertex recentring, renderOrder, polygonOffset, floored
// colour, _meta preservation) is verifiable via a stub `addSurface`
// that just captures the opts it was called with.
//
// Run: `node --test ext/lfm/test/dee-adapter.test.mjs`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addLFMtoDee, lfmCentroid } from '../dee-adapter.js';

function fakeLFM(meshes) {
  return { collectionName: 'fake', version: '1.0', meshes, binary: {} };
}

function fakeMesh({ name = 'm', verts, tris = [0, 1, 2], colour = { r: 100, g: 150, b: 200 }, volume }) {
  const attributes = {};
  if (volume != null) attributes.Volume = String(volume);
  return {
    name,
    colour,
    attributes,
    vertices: new Float64Array(verts),
    triangles: new Int32Array(tris),
    vCount: verts.length / 3,
    tCount: tris.length / 3,
  };
}

function mockDee(origin = [0, 0, 0]) {
  const calls = [];
  return {
    origin,
    addSurface(name, opts) {
      const layer = { name, opts, _meta: null };
      calls.push(layer);
      return layer;
    },
    calls,
  };
}

describe('lfmCentroid', () => {
  test('single mesh — centroid of its bbox', () => {
    const lfm = fakeLFM([fakeMesh({ verts: [0, 0, 0, 10, 20, 30] })]);
    assert.deepEqual(lfmCentroid(lfm), [5, 10, 15]);
  });

  test('multiple meshes — global bbox', () => {
    const lfm = fakeLFM([
      fakeMesh({ verts: [0, 0, 0] }),
      fakeMesh({ verts: [10, 0, 0] }),
      fakeMesh({ verts: [0, 100, 0] }),
      fakeMesh({ verts: [0, 0, 1000] }),
    ]);
    assert.deepEqual(lfmCentroid(lfm), [5, 50, 500]);
  });

  test('UTM-shaped coordinates preserved at full F64 precision', () => {
    const lfm = fakeLFM([
      fakeMesh({ verts: [444700.0, 5000000.5, 2562.0, 444800.0, 5000100.5, 2662.0] }),
    ]);
    const c = lfmCentroid(lfm);
    assert.equal(c[0], 444750);
    assert.equal(c[1], 5000050.5);
    assert.equal(c[2], 2612);
  });

  test('empty input → [0, 0, 0] without crashing', () => {
    assert.deepEqual(lfmCentroid(fakeLFM([])), [0, 0, 0]);
  });
});

describe('addLFMtoDee', () => {
  test('produces one layer per mesh, in source order', () => {
    const dee = mockDee([0, 0, 0]);
    const lfm = fakeLFM([
      fakeMesh({ name: 'a', verts: [0,0,0, 1,0,0, 0,1,0], volume: 1 }),
      fakeMesh({ name: 'b', verts: [0,0,0, 1,0,0, 0,1,0], volume: 2 }),
    ]);
    const layers = addLFMtoDee(dee, lfm);
    assert.equal(layers.length, 2);
    assert.equal(layers[0].name, 'a');
    assert.equal(layers[1].name, 'b');
  });

  test('recentres vertices by dee.origin', () => {
    const dee = mockDee([100, 200, 300]);
    const lfm = fakeLFM([
      fakeMesh({ verts: [100, 200, 300, 110, 220, 330] }),
    ]);
    addLFMtoDee(dee, lfm);
    const pos = dee.calls[0].opts.positions;
    assert.deepEqual(Array.from(pos), [0, 0, 0, 10, 20, 30]);
  });

  test('passes localCoords:true to skip dee group transform', () => {
    const dee = mockDee([100, 200, 300]);
    addLFMtoDee(dee, fakeLFM([fakeMesh({ verts: [0, 0, 0] })]));
    assert.equal(dee.calls[0].opts.localCoords, true);
  });

  test('renderOrder is -volume so largest draws first', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({ name: 'small', verts: [0, 0, 0], volume: 1 }),
      fakeMesh({ name: 'large', verts: [0, 0, 0], volume: 1000 }),
    ]);
    addLFMtoDee(dee, lfm);
    assert.equal(dee.calls[0].opts.renderOrder, -1);
    assert.equal(dee.calls[1].opts.renderOrder, -1000);
    assert.ok(dee.calls[1].opts.renderOrder < dee.calls[0].opts.renderOrder);
  });

  test('polygonOffset rank by ascending volume (smallest = 0)', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({ name: 'large',  verts: [0,0,0], volume: 1000 }),
      fakeMesh({ name: 'small',  verts: [0,0,0], volume: 1 }),
      fakeMesh({ name: 'medium', verts: [0,0,0], volume: 100 }),
    ]);
    addLFMtoDee(dee, lfm);
    // 'small' (vol=1) → rank 0, 'medium' (vol=100) → rank 1, 'large' (vol=1000) → rank 2
    assert.equal(dee.calls[0].opts.polygonOffset, 2);    // large
    assert.equal(dee.calls[1].opts.polygonOffset, 0);    // small
    assert.equal(dee.calls[2].opts.polygonOffset, 1);    // medium
  });

  test('floors very-dark stored colours at render time', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({ verts: [0, 0, 0], colour: { r: 0, g: 0, b: 0 } }),
    ]);
    addLFMtoDee(dee, lfm);
    // Floored to (82, 82, 92) by default; encoded as 0xRRGGBB
    assert.equal(dee.calls[0].opts.color, (82 << 16) | (82 << 8) | 92);
  });

  test('preserves bright colours unchanged', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({ verts: [0, 0, 0], colour: { r: 255, g: 100, b: 50 } }),
    ]);
    addLFMtoDee(dee, lfm);
    assert.equal(dee.calls[0].opts.color, (255 << 16) | (100 << 8) | 50);
  });

  test('records stored colour + attributes in layer._meta', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({
        name: 'm',
        verts: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        colour: { r: 0, g: 0, b: 0 },
        volume: 42,
      }),
    ]);
    const [layer] = addLFMtoDee(dee, lfm);
    assert.deepEqual(layer._meta.storedColour, { r: 0, g: 0, b: 0 });
    assert.equal(layer._meta.attributes.Volume, '42');
    assert.equal(layer._meta.volume, 42);
    assert.equal(layer._meta.vCount, 3);
    assert.equal(layer._meta.tCount, 1);
  });

  test('forwards passthrough opts to addSurface', () => {
    const dee = mockDee();
    const lfm = fakeLFM([fakeMesh({ verts: [0, 0, 0] })]);
    addLFMtoDee(dee, lfm, {
      opacity: 0.5, doubleSided: false, wireframe: true, pickable: false,
      surface: { customExtra: 42 },
    });
    const opts = dee.calls[0].opts;
    assert.equal(opts.opacity, 0.5);
    assert.equal(opts.doubleSided, false);
    assert.equal(opts.wireframe, true);
    assert.equal(opts.pickable, false);
    assert.equal(opts.customExtra, 42);
  });

  test('meshes without a Volume attribute default to 0 → rank 0 / first in offset', () => {
    const dee = mockDee();
    const lfm = fakeLFM([
      fakeMesh({ name: 'ranked',   verts: [0, 0, 0], volume: 100 }),
      fakeMesh({ name: 'unranked', verts: [0, 0, 0] }), // no Volume attr
    ]);
    addLFMtoDee(dee, lfm);
    // Unranked (volume=0) sorts first → polygonOffset rank 0
    assert.equal(dee.calls[1].opts.polygonOffset, 0);
    assert.equal(dee.calls[0].opts.polygonOffset, 1);
    assert.equal(dee.calls[1].opts.renderOrder, -0);
  });

  test('empty meshes input → empty layer list', () => {
    const dee = mockDee();
    assert.deepEqual(addLFMtoDee(dee, fakeLFM([])), []);
    assert.equal(dee.calls.length, 0);
  });
});
