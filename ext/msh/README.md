# @gcu/msh

Reader and writer for **ARANZ-1.0 mesh files** (`.msh`) — the classic
ARANZ Geo / Leapfrog single-mesh export format, predating the newer
`.lfm` (Leapfrog Model File) we handle in [`@gcu/lfm`](../lfm/).

Single-file ESM, zero runtime deps, works in browsers and Node 18+.

## Usage

```js
import { readMSH, writeMSH, MSHError } from '@gcu/msh';

// Read
const result = await readMSH(arrayBuffer);
// {
//   version: '1.0',
//   arrays: Map { 'Location' => {...}, 'Tri' => {...} },
//   binarySignature: Uint8Array(12),
//   vertices: Float64Array,   // first Double-3 array (convenience)
//   triangles: Int32Array,    // first Integer-3 array (convenience)
// }

// Read-modify-write
const buf = await writeMSH(result);
const blob = new Blob([buf], { type: 'application/octet-stream' });
```

Coordinates are returned **unmodified** — typically a UTM-like grid in
metres. Recentring is a rendering concern, not a parsing one (WebGL
`float32` precision degrades at the absolute coordinate magnitudes
typical of UTM, so renderers should subtract a centroid before
uploading to a GPU buffer — see the [`@gcu/dee`](../dee/) layer).

## Rendering with @gcu/dee

If you also use `@gcu/dee` (a Three.js scene layer), there's a thin
adapter:

```js
import { readMSH } from '@gcu/msh';
import { addMSHtoDee, mshCentroid, mshUnionCentroid } from '@gcu/msh/dee-adapter';
import * as dee from '@gcu/dee';

// Single file
const result = await readMSH(arrayBuffer);
const scene = dee.create(container, {
  origin: mshCentroid(result),   // recentre for f32 precision
  THREE,
});
const layer = addMSHtoDee(scene, result, {
  name: 'MacPass HG',
  color: 0xc06030,
  opacity: 0.7,
});

// Multiple .msh domains in one scene
const results = await Promise.all([hgBuf, lgBuf, wasteBuf].map(readMSH));
const scene2 = dee.create(container, {
  origin: mshUnionCentroid(results),
  THREE,
});
addMSHtoDee(scene2, results[0], { name: 'HG',    color: 0xc06030, renderOrder: -3 });
addMSHtoDee(scene2, results[1], { name: 'LG',    color: 0x6080c0, renderOrder: -2 });
addMSHtoDee(scene2, results[2], { name: 'Waste', color: 0x808080, renderOrder: -1, opacity: 0.4 });
```

Vertices get recentred in F64 before the f32 downcast (UTM-scale
coordinates lose precision at f32). The adapter accepts colour as
`0xRRGGBB` or `{r, g, b}` (0-255); low-luminance values get floored to
a charcoal tint so black meshes stay visible against a dark background
(pass `luminance: { threshold: 0 }` to disable). Each layer's `_meta`
field carries the file's full `arrays` Map and `binarySignature` for
round-trip workflows.

## The format

The file is self-describing. The text header declares each binary
array; the binary section is the concatenation of those arrays.

```
%ARANZ-1.0
                                   ← blank line
[index]
Location Double  3 16615;          ← 16,615 vertices, 3 doubles each
Tri      Integer 3 33222;          ← 33,222 triangles, 3 int32 each
                                   ← blank line
[binary]<12-byte signature><raw little-endian binary>
```

Each `[index]` line has the shape `<Name> <Type> <Components> <Count>;`.
Names are vendor-defined strings (we've seen `Location` and `Tri` in
practice; the format admits more). `Type` is `Double` (8-byte LE),
`Integer` (4-byte LE), or any of `Float` / `Long` / `Short` / `Byte`
which the reader handles defensively even though they don't appear in
the files we've tested. `Components` is values per element (3 for 3D
vertices or triangle indices). `Count` is the number of elements.

The binary section starts immediately after `[binary]` (no newline),
with a 12-byte signature, then the arrays in declaration order.

### What the 12-byte signature is (we don't actually know)

```
FF 0F F0 00 1B DE 83 42 CA C0 F3 3F
```

These twelve bytes appear at the head of the `[binary]` section in
every `.msh` file we've examined. They're **identical** across our
test files (MacPass HG and MacPass LG, different vertex/triangle
counts, different absolute mesh shapes). The reader skips them, the
writer emits them back unchanged.

We tried interpreting them several ways and nothing was conclusive:

| Interpretation | Value | Notes |
|---|---|---|
| 3 little-endian `int32` | `0x00F00FFF`, `0x4283DE1B`, `0x3FF3C0CA` | First is visually distinctive (`1111 1111 0000 1111…`) but doesn't match a known magic. Others don't correspond to file size or vertex/triangle counts. |
| 4 LE bytes + 1 LE `double` | `FF 0F F0 00`, then `0x3FF3C0CA4283DE1B` ≈ **1.2353** | The double isn't a recognisable math constant (not π, e, √2, φ). |
| 1 LE `double` + 1 LE `float32` | ≈ 647 and ≈ 1.9043 | Neither rings a bell. |
| 6 LE half-floats | Five noise, one ≈ 1.996 ≈ 2.0 | Coincidence; only the last one comes out cleanly. |
| 12 ASCII bytes | Not printable | No string interpretation works. |

The leading `FF 0F F0 00` byte pattern *looks* deliberate enough to be
a format/endianness sentinel ARANZ baked in, but without their docs we
can't say more.

For now: **opaque magic, preserved verbatim on round-trip.** The
`DEFAULT_BINARY_SIGNATURE` constant in `msh.js` is the canonical value;
the writer emits it when no `binarySignature` is supplied. If you ever
figure out what they mean, please [open an
issue](https://github.com/endarthur/auditable/issues) — we'd love to
update this section.

## API

### `readMSH(input, opts?) → Promise<MSHResult>`

`input` is an `ArrayBuffer` or `Uint8Array` containing the file bytes.

Options:
- `validateIndices` (default `true`) — bounds-check every triangle
  index against the vertex count and throw `MSHError` on out-of-range
  values. Set to `false` if you're working with an exotic file whose
  Integer-3 array isn't actually triangle indices.

Returns:

```ts
{
  version: string;                    // From the magic line ('1.0' in practice)
  arrays: Map<string, {
    type: 'Double' | 'Integer' | ...;
    components: number;
    count: number;
    data: Float64Array | Int32Array | ...;  // length = components * count
  }>;
  binarySignature: Uint8Array;        // The 12 mystery bytes, preserved
  vertices?: Float64Array;            // Convenience: first Double-3 array
  triangles?: Int32Array;             // Convenience: first Integer-3 array
}
```

### `writeMSH(result) → Promise<Uint8Array>`

Round-trips a `MSHResult` (or any object with the same shape — `arrays`
can be a `Map` or a plain object) back to bytes. Validates that every
array's `data.length === components * count` before emitting.

If you don't supply `binarySignature`, the canonical observed signature
is emitted. Supply your own to round-trip files whose signature
happened to be different (we haven't seen any in the wild but the
writer doesn't lock you in).

### `MSHError extends Error`

Thrown on:
- Missing/malformed `%ARANZ-N` magic line
- Missing `[binary]` section
- Malformed index declarations
- Unsupported `Type` name
- Declared-vs-actual byte mismatch (file too short or too long)
- Triangle indices out of range (when `validateIndices` is on)
- Writer: array data length doesn't match `components * count`
- Writer: bad `binarySignature` length

Other thrown values (e.g. `TextDecoder` errors on a non-UTF-8 header)
bubble up unwrapped — they already carry meaningful messages.

## Round-trip property

`writeMSH(await readMSH(buf))` is byte-identical to `buf` for every
test file we've tried. This holds because:

1. The text header is emitted in canonical form, and the .msh files we
   see in the wild use that same canonical form (no extra whitespace,
   no comments inside `[index]`).
2. The 12-byte signature is preserved verbatim.
3. Array byte order is little-endian on both read and write paths.
4. Declaration order is preserved (we use a `Map` for `arrays`, which
   preserves insertion order).

If you have a file that doesn't round-trip cleanly, please share it —
that's the most useful kind of bug report.

## Versioning

Pre-1.0: API is unstable. Breaking changes may happen on minor bumps.

## License

BSD-3-Clause.

## Author

Arthur Endlein Correia / [Geoscientific Chaos Union](https://gentropic.org)
