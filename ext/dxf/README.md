# @gcu/dxf

A bulletproof, round-trippable **DXF** reader/writer (R2000 ASCII) for the GCU geometry
stack. Zero heavy dependencies — geometry is plain `Float64Array` + an [`@gcu/frame`]
offset, so it loads in lamina and notebooks without the ndarray engine.

## The contract

- **Coordinate provenance.** The importer never silently mutates coordinates. Original
  WCS is canonical; any working offset is an explicit, inspectable `@gcu/frame`. The
  writer restores world coordinates — the round-trip most tools fail.
- **Bulletproof.** A total function over arbitrary bytes: never throws on malformed
  input, always imports what it can, and logs everything it tessellated or punted in
  `warnings[]`.
- **Bulge-arc native.** `LWPOLYLINE` bulges and `ARC`/`CIRCLE` entities are read as
  **true arcs**, not faceted polylines — the one-curve-type throughline starts at import.
  Tessellation is reserved for the genuinely un-representable (`SPLINE`, `ELLIPSE`).
- **Hoard everything.** Handle, layer, **un-flattened colour** (ACI vs BYLAYER vs
  true-colour, kept distinct), linetype, and **XDATA grouped by app-id** — where mining
  packages stash lithology, rock codes, and confidence. Dropping XDATA drops the geology.
- **Blocks preserved.** `BLOCK` definitions + `INSERT`s (with transform + folded
  `ATTRIB`s) are kept as the canonical, compact model; `explode()` is an opt-in derived
  view. No legion of flat entities at import; lossless structural round-trip.

`@gcu/dxf` defines the canonical 2D geometry primitive (frame-native, bulge-canonical)
that [`@gcu/regula`] later builds offset / fillet / trim on.

## Status — v0.1 (in progress)

Landed and tested:

- **`tokenize`** — the bulletproof group-code pair reader/writer (`parsePairs`,
  `serializePairs`), code-driven value typing, resync on malformed input.
- **`arc`** — bulge ↔ arc conversions (`arcFromBulge`, `bulgeFromArc`, `arcMidpoint`):
  endpoint+bulge canonical, center/radius/angles derived.
- **`color`** — the un-flattened colour model (`resolveColor`, `colorToPairs`,
  `aciToRgb`).
- **`read`** — the Document assembler: LINE / LWPOLYLINE / POLYLINE (2D+3D) / CIRCLE /
  ARC / POINT / 3DFACE, the attribute bag (handle / layer / un-flattened colour /
  linetype / XDATA-by-app-id), blocks preserved (BlockDef + INSERT, ATTRIBs folded),
  the recommended `Frame` from the bbox, `warnings[]`, never throws.
- **`write`** — Document → R2000 ASCII: world-restore (`toWorld` on `fromLocal`),
  HEADER/TABLES scaffolding + unique handles, XDATA + block round-trip, bulge-native
  entity emission (arc → ARC, planar → LWPOLYLINE, else 3D POLYLINE).
- **`explode`** — the opt-in block resolver: composes INSERT transforms over block defs
  (nested, with a cyclic-reference guard) into flat world geometry.

v0.1 round-trips a file (read → write → read) preserving geometry, blocks, XDATA,
ATTRIBs, handles, and the working frame.

## Roadmap

The fidelity tiers are documented decisions — the punt tier is a decision, not a hole.

**3D coordinates are first-class throughout** (geometry is 3D `Float64Array` + a Frame);
3D POLYLINE and 3DFACE read in v0.1. The remaining 3D work is mapped:

| Tier | Plan |
|---|---|
| **Mesh entities** — POLYLINE polyface (flag 64) / polygon mesh (flag 16) / `MESH` | **v0.2.** The real "3D DXF" — how mining packages export triangulated surfaces & wireframe solids. New `mesh` primitive (vertices + faces); feeds voxmesh / dee, round-trips to OBJ / msh. The `Frame` is what keeps a UTM-coord wireframe from jittering. Currently punted-with-warning. |
| **SPLINE / ELLIPSE** | v0.2 — tessellate at an explicit tolerance, recorded in `warnings[]`. |
| **OCS arbitrary-axis** | v0.2 — full resolution for entities whose extrusion ≠ +Z (v0.1 handles the +Z common case, retains `extrusion` in the bag). |
| **3DSOLID / REGION / BODY** (ACIS SAT/SAB) | **Permanent metadata-only.** An opaque proprietary kernel blob — no geometry recoverable without an ACIS kernel; handle / layer / XDATA kept. This is precisely why OBJ/msh beat 3D-solid DXF for interchange. |

## License

MIT © Arthur Endlein Correia

[`@gcu/frame`]: ../frame
[`@gcu/regula`]: ../regula
