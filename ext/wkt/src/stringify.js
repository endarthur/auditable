// @gcu/wkt stringify — a GeoJSON-shaped geometry → OGC WKT (+ EWKT SRID).
// opts: { srid?, precision? }. srid (or geom.srid) → an `SRID=…;` EWKT prefix; precision →
// fixed decimal places. MULTIPOINT is emitted in the bare form `MULTIPOINT (x y, x y)`.

const fmt = (n, prec) => (prec != null ? String(+n.toFixed(prec)) : String(n));
const coord = (c, p) => c.map((n) => fmt(n, p)).join(' ');
const ring = (r, p) => '(' + r.map((c) => coord(c, p)).join(', ') + ')';
const poly = (g, p) => '(' + g.map((r) => ring(r, p)).join(', ') + ')';

function body(g, p) {
  switch (g.type) {
    case 'Point': return g.coordinates && g.coordinates.length ? `POINT (${coord(g.coordinates, p)})` : 'POINT EMPTY';
    case 'LineString': return g.coordinates && g.coordinates.length ? `LINESTRING ${ring(g.coordinates, p)}` : 'LINESTRING EMPTY';
    case 'Polygon': return g.coordinates && g.coordinates.length ? `POLYGON ${poly(g.coordinates, p)}` : 'POLYGON EMPTY';
    case 'MultiPoint': return g.coordinates && g.coordinates.length ? `MULTIPOINT (${g.coordinates.map((c) => coord(c, p)).join(', ')})` : 'MULTIPOINT EMPTY';
    case 'MultiLineString': return g.coordinates && g.coordinates.length ? `MULTILINESTRING (${g.coordinates.map((ls) => ring(ls, p)).join(', ')})` : 'MULTILINESTRING EMPTY';
    case 'MultiPolygon': return g.coordinates && g.coordinates.length ? `MULTIPOLYGON (${g.coordinates.map((mp) => poly(mp, p)).join(', ')})` : 'MULTIPOLYGON EMPTY';
    case 'GeometryCollection': return g.geometries && g.geometries.length ? `GEOMETRYCOLLECTION (${g.geometries.map((x) => body(x, p)).join(', ')})` : 'GEOMETRYCOLLECTION EMPTY';
    default: throw new Error(`WKT: cannot stringify type "${g.type}"`);
  }
}

export function stringify(geom, opts = {}) {
  const srid = opts.srid != null ? opts.srid : geom.srid;
  const s = body(geom, opts.precision);
  return srid != null ? `SRID=${srid};${s}` : s;
}
