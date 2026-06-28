# @gcu/wkt

OGC Simple-Features **Well-Known Text** (WKT) reader/writer, plus **EWKT** `SRID=…;`,
over a **GeoJSON-shaped geometry**. Zero-dependency. The GIS/DB-native interchange codec
for the GCU geometry stack — the data-bridge serialization that complements
[`@gcu/dxf`](../dxf) (the CAD-native one).

```js
import { parse, stringify } from '@gcu/wkt';

parse('POINT (30 10)');
// → { type: 'Point', coordinates: [30, 10] }

parse('SRID=31983;POINT (600000 7700000)');
// → { type: 'Point', coordinates: [600000, 7700000], srid: 31983 }

stringify({ type: 'LineString', coordinates: [[0, 0], [10, 5]] });
// → 'LINESTRING (0 0, 10 5)'

stringify({ type: 'Point', coordinates: [1, 2] }, { srid: 4326, precision: 3 });
// → 'SRID=4326;POINT (1 2)'
```

## Geometry shape

The neutral intermediate is the GeoJSON geometry object — `{ type, coordinates }` (or
`{ type: 'GeometryCollection', geometries }`), with an optional `srid`:

| WKT | `type` | `coordinates` |
|---|---|---|
| `POINT` | `Point` | `[x, y]` (or `[x, y, z]`) |
| `LINESTRING` | `LineString` | `[[x, y], …]` |
| `POLYGON` | `Polygon` | `[ring, …]` (first ring = outer, rest = holes) |
| `MULTIPOINT` | `MultiPoint` | `[[x, y], …]` |
| `MULTILINESTRING` | `MultiLineString` | `[lineString, …]` |
| `MULTIPOLYGON` | `MultiPolygon` | `[polygon, …]` |
| `GEOMETRYCOLLECTION` | `GeometryCollection` | — (`geometries: [...]`) |

## Coverage

- All seven geometry types; `EMPTY`; **Z** (3D — coordinates self-describe dimensionality);
  both `MULTIPOINT` spellings (`(1 2, 3 4)` and `((1 2), (3 4))`).
- EWKT `SRID=…;` on parse + stringify; `{ srid, precision }` stringify options.
- Total-ish: throws a clear error (with offset) on malformed input.

## Not (yet) in scope

WKB (binary); M / measured coordinates; the ISO SQL/MM curve types
(`CIRCULARSTRING`/`COMPOUNDCURVE`/`CURVEPOLYGON`); the GCU **WKTAH** bulge dialect (a
bulge-native extension for lossless GCU↔GCU automation — designed, see
`spec_inbox/CAD/SPEC-wkt.md`).

MIT · part of [auditable](https://github.com/gentropic/auditable).
