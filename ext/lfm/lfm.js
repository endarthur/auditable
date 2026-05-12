// @gcu/lfm — Leapfrog Model File (.lfm) reader and writer.
// Single-file ESM, zero runtime deps. Browser-only (uses DOMParser,
// DecompressionStream/CompressionStream, crypto.subtle, TextEncoder/
// TextDecoder).
//
// Format: UTF-8 XML descriptor, then a 3-byte separator (0x0A 0x5C 0x30),
// then a binary section of concatenated little-endian zlib streams. The
// XML declares each stream's offset/size/numElements/datatype, plus a
// SHA-256 of the binary section. See SPEC-lfm-reader.md.
//
// SPDX-License-Identifier: BSD-3-Clause
// Reference: https://www.leapfrog3d.com/leapfrogmodelfile

/** XML namespace for every Leapfrog model file element. */
const LFM_NS = 'http://www.leapfrog3d.com/leapfrogmodelfile';

/** End-of-XML sentinel. The descriptor ends here; binary follows. */
const CLOSE_TAG = '</leapfrogModelFile>';

/** Thrown on any LFM-specific failure: malformed file, bad checksum,
 *  unsupported datatype/compression/endian, out-of-range indices, etc.
 *  Other thrown values (e.g. DecompressionStream errors) bubble up
 *  unwrapped, since they already carry meaningful messages. */
export class LFMError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LFMError';
  }
}

/** @typedef {Object} LFMColour - 8-bit RGB as stored in the file.
 *  @property {number} r 0..255
 *  @property {number} g 0..255
 *  @property {number} b 0..255 */

/** @typedef {Object} LFMMesh
 *  @property {string} name                Full mesh name from the file.
 *  @property {LFMColour} colour           File's stored RGB.
 *  @property {Object<string,string>} attributes  meshAttribute name→value
 *                                          map. Common keys: "Volume" (m³),
 *                                          "Area" (m²), "comments". Values
 *                                          are strings; numeric coercion is
 *                                          the consumer's job.
 *  @property {Float64Array} vertices      Flat XYZ, length = 3 * vCount.
 *                                          Coordinates are in the file's
 *                                          native CRS (typically UTM-like,
 *                                          metres). NOT recentred.
 *  @property {Int32Array} triangles       Flat IJK indices, length = 3 * tCount.
 *  @property {number} vCount              vertices.length / 3
 *  @property {number} tCount              triangles.length / 3 */

/** @typedef {Object} LFMResult
 *  @property {string} collectionName      <collectionOfMeshes><name>
 *  @property {string} version             <leapfrogModelFile version="…">
 *  @property {LFMMesh[]} meshes
 *  @property {Object} binary              Provenance for diagnostics.
 *  @property {number} binary.length       Declared binary section length.
 *  @property {string} binary.sha256       Hex digest from <binaryInfo>.
 *  @property {boolean} binary.checksumOk  Always true if readLFM resolved.
 *  @property {number} binary.xmlBytes     Length of the XML descriptor.
 *  @property {number} binary.fileBytes    Total file size. */

/** @typedef {Object} ReadOptions
 *  @property {(message: string) => void} [onProgress]  Coarse status string
 *           emitted at "verifying SHA-256" and per-mesh decode boundaries.
 *           Best-effort, not a stable enum. */

/**
 * Parse an LFM file. The whole file is decoded eagerly — for typical
 * geological deliverables (a few MB to a few hundred MB) this is fine.
 * Lazy per-mesh decoding can be added later without breaking the result
 * shape.
 *
 * @param {ArrayBuffer | Uint8Array} input
 * @param {ReadOptions} [options]
 * @returns {Promise<LFMResult>}
 */
export async function readLFM(input, options = {}) {
  const { onProgress } = options;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // ── XML descriptor ────────────────────────────────────────────────
  const xmlEnd = findCloseTag(bytes);
  if (xmlEnd < 0) throw new LFMError('not an LFM file: no </leapfrogModelFile> tag');
  const xmlText = new TextDecoder('utf-8').decode(bytes.subarray(0, xmlEnd));
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const perr = xml.querySelector('parsererror');
  if (perr) throw new LFMError('XML parse failure: ' + perr.textContent.split('\n')[0]);

  // ── binaryInfo ────────────────────────────────────────────────────
  const binfo = xml.getElementsByTagNameNS(LFM_NS, 'binaryInfo')[0];
  if (!binfo) throw new LFMError('missing <binaryInfo>');
  const endian      = binfo.getAttribute('endian');
  const compression = binfo.getAttribute('compression');
  const length      = parseInt(binfo.getAttribute('length'), 10);
  const expectedSha = binfo.getAttribute('sha256checksum');
  if (endian !== 'little')    throw new LFMError(`unsupported endian "${endian}"`);
  if (compression !== 'zlib') throw new LFMError(`unsupported compression "${compression}"`);
  if (!Number.isFinite(length)) throw new LFMError('missing/invalid binary length');

  // ── locate binary section ────────────────────────────────────────
  // Past XML close + 3-byte separator (0x0A 0x5C 0x30), the binary
  // section starts at the first zlib magic. Scanning is more robust
  // than trusting the separator's exact form.
  const bs = findZlibMagic(bytes, xmlEnd);
  if (bs < 0) throw new LFMError('no zlib stream after XML descriptor');
  if (bs + length > bytes.length) throw new LFMError('binary section truncated');
  const binary = bytes.subarray(bs, bs + length);

  onProgress?.('verifying SHA-256');
  const actualSha = await sha256Hex(binary);
  if (actualSha !== expectedSha) {
    throw new LFMError(
      `SHA-256 mismatch\n  expected ${expectedSha}\n  got      ${actualSha}`);
  }

  // ── walk meshes ───────────────────────────────────────────────────
  const collection = xml.getElementsByTagNameNS(LFM_NS, 'collectionOfMeshes')[0];
  if (!collection) throw new LFMError('missing <collectionOfMeshes>');
  const collectionName =
    collection.getElementsByTagNameNS(LFM_NS, 'name')[0]?.textContent ?? '';

  const meshes = [];
  const ams = collection.getElementsByTagNameNS(LFM_NS, 'attributedMesh');
  for (let i = 0; i < ams.length; i++) {
    const am   = ams[i];
    const mesh = am.getElementsByTagNameNS(LFM_NS, 'mesh')[0];
    const name = mesh.getElementsByTagNameNS(LFM_NS, 'name')[0].textContent;
    onProgress?.(`decoding mesh ${i + 1}/${ams.length}`);

    const v = mesh.getElementsByTagNameNS(LFM_NS, 'vertices')[0];
    const t = mesh.getElementsByTagNameNS(LFM_NS, 'triangles')[0];
    const c = mesh.getElementsByTagNameNS(LFM_NS, 'colour')[0];

    const vertices  = await decodeBlock(binary, v, 'Float64Array', name);
    const triangles = await decodeBlock(binary, t, 'Int32Array',   name);

    if (vertices.length  % 3 !== 0)
      throw new LFMError(`${name}: vertex scalar count ${vertices.length} not divisible by 3`);
    if (triangles.length % 3 !== 0)
      throw new LFMError(`${name}: triangle scalar count ${triangles.length} not divisible by 3`);

    const vCount = vertices.length / 3;
    const tCount = triangles.length / 3;
    let maxIdx = -1, minIdx = Infinity;
    for (let k = 0; k < triangles.length; k++) {
      if (triangles[k] > maxIdx) maxIdx = triangles[k];
      if (triangles[k] < minIdx) minIdx = triangles[k];
    }
    if (vCount > 0 && (maxIdx >= vCount || minIdx < 0)) {
      throw new LFMError(
        `${name}: triangle index out of range [${minIdx},${maxIdx}] vs ${vCount} vertices`);
    }

    const colour = {
      r: parseInt(c.getAttribute('red'),   10),
      g: parseInt(c.getAttribute('green'), 10),
      b: parseInt(c.getAttribute('blue'),  10),
    };
    const attributes = {};
    for (const ma of am.getElementsByTagNameNS(LFM_NS, 'meshAttribute')) {
      attributes[ma.getAttribute('name')] = ma.getAttribute('value');
    }

    meshes.push({ name, colour, attributes, vertices, triangles, vCount, tCount });
  }

  return {
    collectionName,
    version: xml.documentElement.getAttribute('version') ?? '?',
    meshes,
    binary: {
      length,
      sha256: expectedSha,
      checksumOk: true,
      xmlBytes: xmlEnd,
      fileBytes: bytes.length,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function findCloseTag(bytes) {
  const tag = new TextEncoder().encode(CLOSE_TAG);
  const limit = Math.min(bytes.length, 8 * 1024 * 1024); // headers should be small
  outer: for (let i = 0; i <= limit - tag.length; i++) {
    for (let j = 0; j < tag.length; j++) {
      if (bytes[i + j] !== tag[j]) continue outer;
    }
    return i + tag.length;
  }
  return -1;
}

function findZlibMagic(bytes, from) {
  // Leapfrog emits zlib default-compression: 0x78 0x9C. A strict scan
  // is safe in practice; if other CMF/FLG combinations ever appear,
  // tighten to "0x78 followed by a byte that makes a valid CMF check".
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x78 && bytes[i + 1] === 0x9c) return i;
  }
  return -1;
}

async function inflate(compressedBytes) {
  // WHATWG "deflate" = RFC 1950 zlib (with header). Despite the name,
  // this is exactly what LFM uses; "deflate-raw" is RFC 1951.
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([compressedBytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

async function sha256Hex(bytes) {
  // SubtleCrypto wants a contiguous buffer; non-zero-offset views must
  // be copied before hashing.
  const slice = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const hash = await crypto.subtle.digest('SHA-256', slice);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function decodeBlock(binary, decl, typeName, meshName) {
  const datatype = decl.getAttribute('datatype');
  const offset = parseInt(decl.getAttribute('offset'), 10);
  const size   = parseInt(decl.getAttribute('size'),   10);
  const numEl  = parseInt(decl.getAttribute('numElements'), 10);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || !Number.isFinite(numEl)) {
    throw new LFMError(`${meshName}: malformed block declaration on <${decl.localName}>`);
  }
  if (datatype !== '3float64' && datatype !== '3int32') {
    throw new LFMError(`${meshName}: unsupported datatype "${datatype}"`);
  }
  const expectedScalarBytes = typeName === 'Float64Array' ? 8 : 4;

  const compressed   = binary.subarray(offset, offset + size);
  const decompressed = await inflate(compressed);
  if (decompressed.length !== numEl * expectedScalarBytes) {
    throw new LFMError(
      `${meshName}: <${decl.localName}> decompressed to ${decompressed.length}B, ` +
      `expected ${numEl * expectedScalarBytes}B (${numEl} × ${expectedScalarBytes})`);
  }

  // Response.arrayBuffer() returns a fresh, byteOffset=0 ArrayBuffer,
  // so the typed-array view is alignment-safe with no copy.
  return typeName === 'Float64Array'
    ? new Float64Array(decompressed.buffer)
    : new Int32Array(decompressed.buffer);
}

// ════════════════════════════════════════════════════════════════════
// Writer
// ════════════════════════════════════════════════════════════════════

/** @typedef {Object} LFMMeshInput
 *  @property {string} name
 *  @property {LFMColour} [colour]                  Defaults to mid-grey.
 *  @property {Object<string,string|number>} [attributes]  Numeric values
 *           are coerced to string. Pass-through; no synthesis of Volume/Area.
 *  @property {Float64Array | Float32Array | number[]} vertices
 *           Flat XYZ. Float32 / regular arrays are promoted to Float64
 *           (the format only stores 3float64). Passing Float32 means you
 *           already paid the precision cost — the writer doesn't add any.
 *  @property {Int32Array | Uint32Array | number[]} triangles
 *           Flat IJK indices. Uint32 / regular arrays are converted to Int32. */

/** @typedef {Object} WriteInput
 *  @property {string} [collectionName]
 *  @property {LFMMeshInput[]} meshes
 *  @property {string} [version]                    Defaults to "1.0". */

/** @typedef {Object} WriteOptions
 *  @property {(message: string) => void} [onProgress] */

/**
 * Build an LFM file from a (collection name, meshes) input. Returns an
 * ArrayBuffer the caller can save as `.lfm` directly. The output passes
 * the same validation `readLFM` runs (SHA-256 verification, length and
 * index checks).
 *
 * Compression is whatever `CompressionStream("deflate")` decides —
 * typically default zlib level. Round-trips are NOT byte-identical with
 * Leapfrog's own output (different compressor, different SHA-256), but
 * are semantically identical: same vertices, triangles, colours, and
 * attributes.
 *
 * Endianness assumption: the host runs little-endian (every modern
 * consumer machine does). On a big-endian host this would emit
 * byte-swapped vertex/triangle data; if that ever matters, switch the
 * raw-byte builds below to DataView writes.
 *
 * @param {WriteInput} input
 * @param {WriteOptions} [options]
 * @returns {Promise<ArrayBuffer>}
 */
export async function writeLFM(input, options = {}) {
  const { onProgress } = options;
  const { collectionName = '', meshes = [], version = '1.0' } = input;

  // ── 1. Normalise + validate every mesh, compress its blocks ──────
  // Each mesh contributes two blocks in order: vertices, then triangles.
  // We capture the compressed bytes plus numElements (scalar count) so we
  // can fill in the XML offsets/sizes after concatenation.
  const blocks = [];                         // {compressed, numElements, kind}
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    if (!m || typeof m.name !== 'string') {
      throw new LFMError(`mesh #${i}: missing or invalid name`);
    }
    onProgress?.(`compressing mesh ${i + 1}/${meshes.length}`);

    const verts = ensureFloat64(m.vertices, `${m.name}.vertices`);
    const tris  = ensureInt32(m.triangles,  `${m.name}.triangles`);
    if (verts.length % 3 !== 0)
      throw new LFMError(`${m.name}: vertices length ${verts.length} not divisible by 3`);
    if (tris.length % 3 !== 0)
      throw new LFMError(`${m.name}: triangles length ${tris.length} not divisible by 3`);

    const vCount = verts.length / 3;
    if (vCount > 0) {
      let maxIdx = -1, minIdx = Infinity;
      for (let k = 0; k < tris.length; k++) {
        if (tris[k] > maxIdx) maxIdx = tris[k];
        if (tris[k] < minIdx) minIdx = tris[k];
      }
      if (tris.length > 0 && (maxIdx >= vCount || minIdx < 0)) {
        throw new LFMError(
          `${m.name}: triangle index out of range [${minIdx},${maxIdx}] vs ${vCount} vertices`);
      }
    }

    blocks.push({
      kind: 'vertices',
      numElements: verts.length,
      compressed: await deflate(asBytes(verts)),
    });
    blocks.push({
      kind: 'triangles',
      numElements: tris.length,
      compressed: await deflate(asBytes(tris)),
    });
  }

  // ── 2. Compute offsets, concat the binary section ────────────────
  let cursor = 0;
  for (const b of blocks) { b.offset = cursor; cursor += b.compressed.length; }
  const binaryLength = cursor;
  const binary = new Uint8Array(binaryLength);
  for (const b of blocks) binary.set(b.compressed, b.offset);

  // ── 3. SHA-256 of the binary section ─────────────────────────────
  onProgress?.('computing SHA-256');
  const sha = await sha256Hex(binary);

  // ── 4. Build XML descriptor with all attributes filled in ────────
  const xml = buildXml({ collectionName, meshes, blocks, binaryLength, sha, version });
  const xmlBytes = new TextEncoder().encode(xml);

  // ── 5. Concatenate XML + 3-byte separator + binary section ───────
  const sep = new Uint8Array([0x0A, 0x5C, 0x30]);
  const out = new Uint8Array(xmlBytes.length + sep.length + binary.length);
  out.set(xmlBytes, 0);
  out.set(sep, xmlBytes.length);
  out.set(binary, xmlBytes.length + sep.length);

  // Detach so the caller owns a clean ArrayBuffer (typed-array .buffer
  // can be larger than the view; here they're identical, but explicit is
  // less surprising).
  return out.buffer;
}

// ────────────────────────────────────────────────────────────────────
// Writer internals
// ────────────────────────────────────────────────────────────────────

function ensureFloat64(arr, label) {
  if (arr == null) throw new LFMError(`${label}: missing`);
  if (arr instanceof Float64Array) return arr;
  // Float32Array, Array, Uint8Array (raw bytes — unlikely but harmless),
  // anything iterable of numbers. Float64Array constructor accepts all.
  return new Float64Array(arr);
}

function ensureInt32(arr, label) {
  if (arr == null) throw new LFMError(`${label}: missing`);
  if (arr instanceof Int32Array) return arr;
  return new Int32Array(arr);
}

function asBytes(typedArr) {
  // Aliased view over the same memory — no copy. CompressionStream
  // tolerates non-zero byteOffsets.
  return new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
}

async function deflate(data) {
  // Symmetric with inflate(): WHATWG "deflate" = RFC 1950 zlib (header
  // + Adler-32). Output starts with 0x78 0x9C-ish CMF/FLG, which the
  // reader's findZlibMagic finds.
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data]).stream().pipeThrough(cs);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function buildXml({ collectionName, meshes, blocks, binaryLength, sha, version }) {
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<leapfrogModelFile version="${escAttr(version)}"` +
    ` xmlns="${LFM_NS}"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xsi:schemaLocation="${LFM_NS} http://www.leapfrog3d.com/xml_schemas/leapfrogmodelfile.xsd">`
  );
  out.push(`  <leapfrogObject>`);
  out.push(`    <collectionOfMeshes>`);
  out.push(`      <name>${escText(collectionName)}</name>`);

  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const vBlock = blocks[i * 2];
    const tBlock = blocks[i * 2 + 1];
    const c = m.colour ?? { r: 128, g: 128, b: 128 };

    out.push(`      <attributedMesh>`);
    out.push(`        <mesh>`);
    out.push(`          <name>${escText(m.name)}</name>`);
    out.push(
      `          <vertices datatype="3float64"` +
      ` offset="${vBlock.offset}"` +
      ` size="${vBlock.compressed.length}"` +
      ` numElements="${vBlock.numElements}"/>`
    );
    out.push(
      `          <triangles datatype="3int32"` +
      ` offset="${tBlock.offset}"` +
      ` size="${tBlock.compressed.length}"` +
      ` numElements="${tBlock.numElements}"/>`
    );
    out.push(
      `          <colour red="${c.r | 0}" green="${c.g | 0}" blue="${c.b | 0}"/>`
    );
    out.push(`        </mesh>`);

    const attrs = m.attributes ?? {};
    for (const [name, value] of Object.entries(attrs)) {
      out.push(
        `        <meshAttribute name="${escAttr(name)}" value="${escAttr(value)}"/>`
      );
    }
    out.push(`      </attributedMesh>`);
  }

  out.push(`    </collectionOfMeshes>`);
  out.push(`  </leapfrogObject>`);
  out.push(
    `  <binaryInfo endian="little" compression="zlib"` +
    ` length="${binaryLength}"` +
    ` sha256checksum="${sha}"/>`
  );
  out.push(`</leapfrogModelFile>`);
  return out.join('\n');
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
