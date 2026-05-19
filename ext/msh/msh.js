// @gcu/msh — ARANZ-1.0 mesh file (.msh) reader and writer.
// Single-file ESM, zero runtime deps. Works in browsers and Node 18+.
//
// Format (self-describing):
//
//   %ARANZ-1.0\n
//   \n
//   [index]\n
//   <Name> <Type> <Components> <Count>;\n
//   ...
//   \n
//   [binary]<12-byte signature><binary data in declared order, little-endian>
//
// The [index] section declares each binary array by name, element type
// (Double | Integer), components per element (e.g. 3 for 3D vertices),
// and element count. The [binary] section starts with a fixed 12-byte
// signature whose meaning is undocumented; we preserve it verbatim on
// round-trip. See the README for the bytes we've observed and our best
// guesses about their meaning (short version: probably an ARANZ-internal
// format sentinel; opaque to us).
//
// Common arrays in practice (single triangulated mesh per file):
//   Location   Double  3   N    — flat XYZ, length 3*N
//   Tri        Integer 3   M    — flat IJK indices, length 3*M
//
// Coordinates are returned unmodified — typically a UTM-like grid in
// metres. Recentring is a rendering concern, not a parsing one (WebGL
// f32 precision drops at the absolute coordinate magnitudes typical of
// UTM, so renderers should subtract a centroid before uploading).
//
// SPDX-License-Identifier: BSD-3-Clause
// Reference: vendor format, no public spec; reverse-engineered from
// MacPass HG/LG and other Leapfrog Geo / Edge exports. ARANZ Geo was
// the original developer (now Seequent / Bentley).

/** Magic line at the start of every .msh file. */
const MSH_MAGIC = '%ARANZ-1.0';

/** Section headers we recognise (case-sensitive). */
const SECTION_INDEX  = '[index]';
const SECTION_BINARY = '[binary]';

/** Length of the opaque-magic prefix that sits between '[binary]' and
 *  the first array's bytes. See README "12-byte signature" section. */
const BINARY_PREFIX_LENGTH = 12;

/** The signature observed across all files we've seen — preserved on
 *  writeback when the caller doesn't supply their own. Probably an
 *  ARANZ-internal format sentinel; we don't interpret it. */
const DEFAULT_BINARY_SIGNATURE = new Uint8Array([
  0xFF, 0x0F, 0xF0, 0x00, 0x1B, 0xDE, 0x83, 0x42,
  0xCA, 0xC0, 0xF3, 0x3F,
]);

/** Type catalog. Maps the index-declared Type name to its byte width
 *  and a constructor for the typed-array we'll hand back. Little-endian
 *  is assumed throughout; we don't write any other endianness either. */
const MSH_TYPES = {
  Double:  { bytes: 8, ctor: Float64Array, kind: 'float' },
  Float:   { bytes: 4, ctor: Float32Array, kind: 'float' },
  Integer: { bytes: 4, ctor: Int32Array,   kind: 'int'   },
  Long:    { bytes: 8, ctor: BigInt64Array, kind: 'int'  },
  Short:   { bytes: 2, ctor: Int16Array,   kind: 'int'   },
  Byte:    { bytes: 1, ctor: Uint8Array,   kind: 'int'   },
};

/** Thrown on any MSH-specific failure: bad magic, malformed index,
 *  unsupported type, declared/decoded size mismatch, out-of-range
 *  triangle indices. */
export class MSHError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MSHError';
  }
}

/** @typedef {Object} MSHArray
 *  @property {string} type        e.g. "Double", "Integer"
 *  @property {number} components  values per element (3 for 3D vertex / triangle)
 *  @property {number} count       element count (vertices, triangles, ...)
 *  @property {TypedArray} data    flat values, length = components * count.
 *                                  Float64Array for Double, Int32Array for
 *                                  Integer, etc. */

/** @typedef {Object} MSHResult
 *  @property {string} version              From the magic line; '1.0' in practice.
 *  @property {Map<string,MSHArray>} arrays Declared arrays, keyed by name in
 *                                          DECLARATION ORDER (Map iteration
 *                                          preserves insertion order).
 *  @property {Uint8Array} binarySignature  The 12 bytes between '[binary]'
 *                                          and the first array. Preserved
 *                                          for byte-identical round-trip.
 *  @property {Float64Array=} vertices      Convenience: the first Double-3
 *                                          array (typically named "Location"),
 *                                          if present.
 *  @property {Int32Array=} triangles       Convenience: the first Integer-3
 *                                          array (typically "Tri"), if present. */

/** Read an .msh ArrayBuffer / Uint8Array and return a fully decoded
 *  {@link MSHResult}. Throws {@link MSHError} on any structural problem.
 *  @param {ArrayBuffer|Uint8Array} input
 *  @param {Object} [opts]
 *  @param {boolean} [opts.validateIndices=true]  Bounds-check triangle
 *      indices against vertex count. Set false to skip if you have a
 *      file with non-Location/Tri arrays whose meaning we can't infer.
 *  @returns {Promise<MSHResult>}
 */
export async function readMSH(input, opts = {}) {
  const bytes = _coerceBytes(input);
  const validateIndices = opts.validateIndices !== false;

  // 1. Find the [binary] header by locating its literal bytes — the
  //    section header sits on its own line in practice, but the binary
  //    data starts IMMEDIATELY after the closing ']' (no newline).
  const binaryHeaderStart = _indexOfBytes(bytes, SECTION_BINARY);
  if (binaryHeaderStart < 0) {
    throw new MSHError('missing [binary] section header');
  }
  const binaryStart = binaryHeaderStart + SECTION_BINARY.length;

  // 2. Decode the text header (everything before [binary]) as UTF-8
  //    and parse out the magic + index declarations.
  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, binaryHeaderStart));
  const { version, declarations } = _parseTextHeader(headerText);

  // 3. Capture the 12-byte signature.
  if (binaryStart + BINARY_PREFIX_LENGTH > bytes.length) {
    throw new MSHError('binary section truncated before signature');
  }
  const binarySignature = bytes.slice(binaryStart, binaryStart + BINARY_PREFIX_LENGTH);

  // 4. Walk declarations in order, slicing the appropriate number of
  //    bytes per array. Little-endian — we copy into a fresh typed
  //    array rather than view-aliasing the source so the result is
  //    independent of the input buffer (the caller may free it).
  let cursor = binaryStart + BINARY_PREFIX_LENGTH;
  const arrays = new Map();
  for (const decl of declarations) {
    const info = MSH_TYPES[decl.type];
    if (!info) {
      throw new MSHError(`unsupported type "${decl.type}" for array "${decl.name}"`);
    }
    const totalValues = decl.components * decl.count;
    const totalBytes = totalValues * info.bytes;
    if (cursor + totalBytes > bytes.length) {
      throw new MSHError(
        `array "${decl.name}" declared ${totalBytes} bytes but file has only ${bytes.length - cursor} remaining`
      );
    }
    const data = _readTypedArray(bytes, cursor, totalValues, info);
    arrays.set(decl.name, {
      type: decl.type,
      components: decl.components,
      count: decl.count,
      data,
    });
    cursor += totalBytes;
  }
  // Trailing bytes? Real files don't have any, but tolerate up to 8
  // bytes of alignment padding (some writers append a record terminator).
  const trailing = bytes.length - cursor;
  if (trailing > 8) {
    throw new MSHError(`${trailing} unexpected bytes after the last declared array`);
  }

  const result = { version, arrays, binarySignature };

  // 5. Convenience accessors. Pick the FIRST Double-3 array as
  //    vertices and the FIRST Integer-3 array as triangles. Files with
  //    multiple Double-3 arrays (e.g. per-vertex normals) would need
  //    the caller to reach into `arrays` directly — we don't try to
  //    guess from names alone.
  let vertices, triangles;
  for (const [, arr] of arrays) {
    if (!vertices && arr.type === 'Double' && arr.components === 3) {
      vertices = arr.data;
    } else if (!triangles && arr.type === 'Integer' && arr.components === 3) {
      triangles = arr.data;
    }
  }
  if (vertices) result.vertices = vertices;
  if (triangles) result.triangles = triangles;

  // 6. Validation: every triangle index must reference a real vertex.
  //    Catches truncation / corruption that survived the size checks
  //    (e.g. a swapped array order).
  if (validateIndices && vertices && triangles) {
    const vCount = vertices.length / 3 | 0;
    for (let i = 0; i < triangles.length; i++) {
      const idx = triangles[i];
      if (idx < 0 || idx >= vCount) {
        throw new MSHError(
          `triangle index ${idx} at position ${i} is out of range (0..${vCount - 1})`
        );
      }
    }
  }

  return result;
}

/** Serialise an {@link MSHResult} (or a synthesised mesh) back to bytes.
 *  Round-trips byte-identical when given a result from readMSH that
 *  hasn't been modified.
 *  @param {Object} input
 *  @param {string} [input.version='1.0']
 *  @param {Map<string,MSHArray>|Object<string,MSHArray>} input.arrays
 *  @param {Uint8Array} [input.binarySignature]   12-byte prefix; defaults
 *      to the canonical observed signature.
 *  @returns {Promise<Uint8Array>}
 */
export async function writeMSH(input) {
  const version = input.version || '1.0';
  const arrays = input.arrays instanceof Map
    ? input.arrays
    : new Map(Object.entries(input.arrays || {}));
  if (arrays.size === 0) {
    throw new MSHError('writeMSH: at least one declared array is required');
  }
  const signature = input.binarySignature || DEFAULT_BINARY_SIGNATURE;
  if (signature.length !== BINARY_PREFIX_LENGTH) {
    throw new MSHError(`binarySignature must be ${BINARY_PREFIX_LENGTH} bytes`);
  }

  // 1. Validate every array AND compute total binary length so we can
  //    allocate once. Keeps the writer single-pass and predictable.
  let binaryLen = BINARY_PREFIX_LENGTH;
  const orderedDeclarations = [];
  for (const [name, arr] of arrays) {
    const info = MSH_TYPES[arr.type];
    if (!info) {
      throw new MSHError(`writeMSH: unsupported type "${arr.type}" for array "${name}"`);
    }
    const declaredValues = arr.components * arr.count;
    if (!arr.data || arr.data.length !== declaredValues) {
      throw new MSHError(
        `writeMSH: array "${name}" declares ${declaredValues} values but data has ${arr.data?.length ?? 0}`
      );
    }
    orderedDeclarations.push({ name, ...arr, info });
    binaryLen += declaredValues * info.bytes;
  }

  // 2. Build the text header.
  const lines = [];
  lines.push(`%ARANZ-${version}`);
  lines.push('');
  lines.push(SECTION_INDEX);
  for (const decl of orderedDeclarations) {
    lines.push(`${decl.name} ${decl.type} ${decl.components} ${decl.count};`);
  }
  lines.push('');
  // The binary section header has NO trailing newline — the magic
  // signature starts immediately after the closing ']' (matching what
  // the readers in the wild expect, including the one this is based on).
  // Join with \n and append the literal '[binary]' separately so we
  // don't accidentally add one.
  const headerText = lines.join('\n') + '\n' + SECTION_BINARY;
  const headerBytes = new TextEncoder().encode(headerText);

  // 3. Allocate the final buffer and copy in:
  //    [header][signature][array 0 bytes][array 1 bytes]...
  const out = new Uint8Array(headerBytes.length + binaryLen);
  out.set(headerBytes, 0);
  let cursor = headerBytes.length;
  out.set(signature, cursor);
  cursor += BINARY_PREFIX_LENGTH;
  for (const decl of orderedDeclarations) {
    _writeTypedArray(out, cursor, decl.data, decl.info);
    cursor += decl.data.length * decl.info.bytes;
  }
  return out;
}

// ── internals ──

function _coerceBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && input.buffer instanceof ArrayBuffer) {
    // Other typed-array view: use its underlying buffer slice.
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new MSHError('readMSH: input must be ArrayBuffer or Uint8Array');
}

function _indexOfBytes(haystack, needleString) {
  // Search for an ASCII substring in a Uint8Array. Used to find the
  // [binary] header; we don't decode the whole file as UTF-8 because
  // the binary section will contain arbitrary bytes that may form
  // partial-UTF-8 sequences and corrupt the decoder.
  const needle = new TextEncoder().encode(needleString);
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function _parseTextHeader(text) {
  // Magic must be the first non-empty content line.
  const lines = text.split('\n');
  if (lines.length === 0 || !lines[0].startsWith('%ARANZ-')) {
    throw new MSHError('missing %ARANZ-N magic line');
  }
  const version = lines[0].slice('%ARANZ-'.length).trim();
  // Walk lines looking for [index]. Everything between [index] and the
  // next bracketed-section header (we expect [binary]) is declarations.
  let inIndex = false;
  const declarations = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      if (line === SECTION_INDEX) { inIndex = true; continue; }
      // Any other bracketed section ends the index. (We only know
      // about [binary] here, but other vendors might extend later.)
      inIndex = false;
      continue;
    }
    if (!inIndex) continue;
    declarations.push(_parseDeclaration(line));
  }
  if (declarations.length === 0) {
    throw new MSHError('[index] section is missing or empty');
  }
  return { version, declarations };
}

function _parseDeclaration(line) {
  // Shape: "<Name> <Type> <Components> <Count>;"
  // Name can contain spaces in theory (vendor-defined); we treat the
  // trailing ';' as the terminator and walk backwards through the
  // 3 numeric / type tokens. Anything before them is the name.
  const stripped = line.endsWith(';') ? line.slice(0, -1).trim() : line.trim();
  const tokens = stripped.split(/\s+/);
  if (tokens.length < 4) {
    throw new MSHError(`malformed index declaration: "${line}"`);
  }
  const count      = parseInt(tokens[tokens.length - 1], 10);
  const components = parseInt(tokens[tokens.length - 2], 10);
  const type       = tokens[tokens.length - 3];
  const name       = tokens.slice(0, tokens.length - 3).join(' ');
  if (!Number.isFinite(count) || count < 0
      || !Number.isFinite(components) || components < 1
      || !name) {
    throw new MSHError(`malformed index declaration: "${line}"`);
  }
  return { name, type, components, count };
}

function _readTypedArray(bytes, offset, length, info) {
  // The src bytes may not be aligned to the typed-array's stride, and
  // even when aligned, slicing into a fresh buffer guarantees the
  // returned array is independent of the input (we make NO promises
  // about the lifetime of the input ArrayBuffer). Copy bytes then
  // build the typed view on the copy.
  const totalBytes = length * info.bytes;
  const buf = new ArrayBuffer(totalBytes);
  new Uint8Array(buf).set(bytes.subarray(offset, offset + totalBytes));
  // BigInt64Array constructor takes (buffer, byteOffset, length).
  // All others same shape.
  return new info.ctor(buf, 0, length);
}

function _writeTypedArray(dst, offset, src, info) {
  // src is already a typed array (Float64Array etc.). We need its raw
  // bytes copied into dst at the given byte offset. The simplest path
  // is to view the SAME bytes via Uint8Array and let .set() handle
  // the copy.
  const view = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  // Sanity check: declared values × stride MUST match.
  if (view.byteLength !== src.length * info.bytes) {
    throw new MSHError(
      `writeMSH: typed-array stride mismatch (got ${view.byteLength}, expected ${src.length * info.bytes})`
    );
  }
  dst.set(view, offset);
}
