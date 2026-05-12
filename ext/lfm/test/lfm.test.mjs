// @gcu/lfm test suite — synthetic round-trip plus error-path coverage.
//
// readLFM uses DOMParser, which is a browser API not present in Node by
// default. When DOMParser isn't available we report once and skip the
// readLFM-dependent suites cleanly instead of failing — write tests
// (which only need CompressionStream + crypto.subtle, both in Node ≥19)
// still run.
//
// Recommended runner once a fixture exists: playwright component test,
// vitest browser mode, or any Node setup with linkedom/jsdom. The
// adapter would be:
//   import { DOMParser } from 'linkedom';
//   globalThis.DOMParser = DOMParser;
//
// Run directly: `node --test ext/lfm/test/lfm.test.mjs`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readLFM, writeLFM, LFMError } from '../lfm.js';

const HAS_DOM_PARSER = typeof DOMParser !== 'undefined';
if (!HAS_DOM_PARSER) {
  console.warn(
    '[lfm.test] DOMParser unavailable — readLFM-dependent tests skipped. ' +
    'Run in a browser or shim DOMParser (e.g. linkedom) to exercise them.',
  );
}

// Single-triangle mesh: one of the smallest valid synthetic fixtures.
function tinyMesh(name, colour) {
  return {
    name,
    colour,
    attributes: { Volume: '1.0', Area: '0.5' },
    vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangles: new Int32Array([0, 1, 2]),
  };
}

describe('writeLFM', () => {
  test('produces a non-empty ArrayBuffer for a single mesh', async () => {
    const buf = await writeLFM({
      collectionName: 'Test',
      meshes: [tinyMesh('m', { r: 100, g: 150, b: 200 })],
    });
    assert.ok(buf instanceof ArrayBuffer);
    assert.ok(buf.byteLength > 100);
  });

  test('writes the XML close tag + 3-byte separator + zlib magic', async () => {
    const buf = await writeLFM({
      collectionName: 'Test',
      meshes: [tinyMesh('m', { r: 0, g: 0, b: 0 })],
    });
    const bytes = new Uint8Array(buf);
    const text = new TextDecoder().decode(bytes);
    const closeIdx = text.indexOf('</leapfrogModelFile>');
    assert.ok(closeIdx > 0, 'XML close tag must appear');
    const sepStart = closeIdx + '</leapfrogModelFile>'.length;
    // 3-byte separator: newline, backslash, '0'
    assert.equal(bytes[sepStart], 0x0a);
    assert.equal(bytes[sepStart + 1], 0x5c);
    assert.equal(bytes[sepStart + 2], 0x30);
    // First zlib magic comes right after — 0x78 0x9C (default level).
    let zlibStart = -1;
    for (let i = sepStart + 3; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x78 && bytes[i + 1] === 0x9c) { zlibStart = i; break; }
    }
    assert.ok(zlibStart > 0, 'zlib magic must follow the separator');
  });

  test('throws LFMError on missing mesh name', async () => {
    await assert.rejects(
      () => writeLFM({ meshes: [{ vertices: new Float64Array(0), triangles: new Int32Array(0) }] }),
      (e) => e instanceof LFMError && /missing or invalid name/.test(e.message),
    );
  });

  test('throws LFMError when triangle scalar count is not divisible by 3', async () => {
    await assert.rejects(
      () => writeLFM({
        meshes: [{
          name: 'bad', vertices: new Float64Array([0,0,0, 1,0,0, 0,1,0]),
          triangles: new Int32Array([0, 1]),  // 2 scalars — not a full triangle
        }],
      }),
      (e) => e instanceof LFMError && /not divisible by 3/.test(e.message),
    );
  });

  test('throws LFMError when a triangle index is out of range', async () => {
    await assert.rejects(
      () => writeLFM({
        meshes: [{
          name: 'oob', vertices: new Float64Array([0,0,0, 1,0,0, 0,1,0]),
          triangles: new Int32Array([0, 1, 99]),  // 99 ≥ vCount=3
        }],
      }),
      (e) => e instanceof LFMError && /triangle index out of range/.test(e.message),
    );
  });

  test('promotes Float32 vertex input to Float64', async () => {
    // Same shape as Float64 input — writer accepts and converts.
    const buf = await writeLFM({
      meshes: [{
        name: 'f32',
        vertices: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        triangles: new Int32Array([0, 1, 2]),
      }],
    });
    assert.ok(buf.byteLength > 100);
  });
});

describe('readLFM', { skip: !HAS_DOM_PARSER }, () => {
  test('round-trips a single mesh: same data after write→read', async () => {
    const original = {
      collectionName: 'Round Trip',
      meshes: [tinyMesh('Granite', { r: 200, g: 100, b: 50 })],
    };
    const buf = await writeLFM(original);
    const result = await readLFM(buf);

    assert.equal(result.collectionName, 'Round Trip');
    assert.equal(result.version, '1.0');
    assert.equal(result.meshes.length, 1);
    const m = result.meshes[0];
    assert.equal(m.name, 'Granite');
    assert.deepEqual(m.colour, { r: 200, g: 100, b: 50 });
    assert.equal(m.vCount, 3);
    assert.equal(m.tCount, 1);
    assert.deepEqual(Array.from(m.vertices), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(Array.from(m.triangles), [0, 1, 2]);
    assert.deepEqual(m.attributes, { Volume: '1.0', Area: '0.5' });
    assert.equal(result.binary.checksumOk, true);
  });

  test('round-trips XML-escape characters in names/attributes', async () => {
    const tricky = 'Has <, >, & and " in name';
    const buf = await writeLFM({
      collectionName: tricky,
      meshes: [{
        ...tinyMesh('mesh ' + tricky, { r: 0, g: 0, b: 0 }),
        attributes: { 'weird & key': '<value>"with"&entities' },
      }],
    });
    const result = await readLFM(buf);
    assert.equal(result.collectionName, tricky);
    assert.equal(result.meshes[0].name, 'mesh ' + tricky);
    assert.equal(result.meshes[0].attributes['weird & key'], '<value>"with"&entities');
  });

  test('throws LFMError with "SHA-256 mismatch" on corrupted binary', async () => {
    const buf = await writeLFM({
      meshes: [tinyMesh('corrupt-me', { r: 10, g: 20, b: 30 })],
    });
    const bytes = new Uint8Array(buf);
    // Find the zlib magic, flip one byte after it.
    let zlib = -1;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x78 && bytes[i + 1] === 0x9c) { zlib = i; break; }
    }
    assert.ok(zlib > 0);
    // Mutate a byte well past the zlib header so deflate doesn't outright
    // explode before we hit the SHA check.
    bytes[zlib + 8] ^= 0xff;
    await assert.rejects(
      () => readLFM(bytes.buffer),
      (e) => e instanceof LFMError && /SHA-256 mismatch/.test(e.message),
    );
  });

  test('throws LFMError on missing </leapfrogModelFile>', async () => {
    const bytes = new TextEncoder().encode('<xml>not lfm</xml>');
    await assert.rejects(
      () => readLFM(bytes.buffer),
      (e) => e instanceof LFMError && /no <\/leapfrogModelFile>/.test(e.message),
    );
  });

  test('handles multiple meshes, preserves order', async () => {
    const buf = await writeLFM({
      meshes: [
        tinyMesh('first',  { r: 1, g: 2, b: 3 }),
        tinyMesh('second', { r: 4, g: 5, b: 6 }),
        tinyMesh('third',  { r: 7, g: 8, b: 9 }),
      ],
    });
    const result = await readLFM(buf);
    assert.equal(result.meshes.length, 3);
    assert.deepEqual(result.meshes.map(m => m.name), ['first', 'second', 'third']);
    assert.deepEqual(result.meshes[0].colour, { r: 1, g: 2, b: 3 });
    assert.deepEqual(result.meshes[2].colour, { r: 7, g: 8, b: 9 });
  });

  test('defaults colour to mid-grey when not supplied to writeLFM', async () => {
    const buf = await writeLFM({
      meshes: [{
        name: 'no-colour',
        vertices: new Float64Array([0,0,0, 1,0,0, 0,1,0]),
        triangles: new Int32Array([0, 1, 2]),
      }],
    });
    const result = await readLFM(buf);
    assert.deepEqual(result.meshes[0].colour, { r: 128, g: 128, b: 128 });
  });
});
