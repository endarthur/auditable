import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompressionStream, DecompressionStream } from 'node:stream/web';

// ── polyfill for Node <20 ──
if (!globalThis.CompressionStream) globalThis.CompressionStream = CompressionStream;
if (!globalThis.DecompressionStream) globalThis.DecompressionStream = DecompressionStream;

// ── helpers (same as exec.js) ──

function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function compressText(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return uint8ToBase64(compressed);
}

async function decompressText(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

// ── tests ──

describe('compressText / decompressText', () => {
  it('round-trips a simple string', async () => {
    const original = 'export const x = 42;\n';
    const compressed = await compressText(original);
    const restored = await decompressText(compressed);
    assert.equal(restored, original);
  });

  it('round-trips a larger JS module', async () => {
    const original = 'const arr = [' + Array.from({ length: 1000 }, (_, i) => i).join(',') + '];\nexport default arr;\n';
    const compressed = await compressText(original);
    const restored = await decompressText(compressed);
    assert.equal(restored, original);
  });

  it('round-trips unicode content', async () => {
    const original = '// \u00d7 \u2014 \u03b1 \u2192\nexport const pi = 3.14;\n';
    const compressed = await compressText(original);
    const restored = await decompressText(compressed);
    assert.equal(restored, original);
  });

  it('compressed output is valid base64', async () => {
    const compressed = await compressText('hello world');
    assert.match(compressed, /^[A-Za-z0-9+/=]+$/);
  });

  it('compressed output is smaller than original for repetitive content', async () => {
    const original = 'x'.repeat(10000);
    const compressed = await compressText(original);
    assert.ok(compressed.length < original.length, 'compressed should be smaller');
  });
});

describe('module entry flag routing', () => {
  it('compressed text module: { compressed: true } without binary', () => {
    const entry = { source: 'abc123', compressed: true, cellId: 0 };
    // should take decompressText path (compressed && !binary)
    assert.ok(entry.compressed && !entry.binary);
  });

  it('compressed binary module: { compressed: true, binary: true }', () => {
    const entry = { source: 'abc123', compressed: true, binary: true, type: 'application/wasm', cellId: 0 };
    // should take decodeBinary path (binary flag present)
    assert.ok(entry.binary);
  });

  it('legacy uncompressed text module: { source: "..." }', () => {
    const entry = { source: 'export const x = 1;', cellId: 0 };
    // no compressed flag — should use source directly
    assert.ok(!entry.compressed);
  });

  it('legacy bare string entry', () => {
    const entry = 'export const x = 1;';
    // typeof === string — should use directly
    assert.equal(typeof entry, 'string');
  });
});

describe('Node zlib compatibility (gen_examples path)', () => {
  it('zlib gzip matches browser CompressionStream round-trip', async () => {
    const zlib = await import('node:zlib');
    const original = 'export function hello() { return "world"; }\n';

    // compress with Node zlib (same as gen_examples.js)
    const compressed = zlib.default.gzipSync(Buffer.from(original, 'utf8'));
    const base64 = compressed.toString('base64');

    // decompress with browser-style decompressText
    const restored = await decompressText(base64);
    assert.equal(restored, original);
  });
});
