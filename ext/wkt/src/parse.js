// @gcu/wkt parse — OGC Simple-Features WKT (+ EWKT SRID) → a GeoJSON-shaped geometry:
//   { type:'Point'|'LineString'|'Polygon'|'MultiPoint'|'MultiLineString'|'MultiPolygon'|
//     'GeometryCollection', coordinates|geometries, srid? }
// Coordinates self-describe dimensionality (2 → [x,y], 3 → [x,y,z]); the Z/M tag is read
// and ignored. Handles EMPTY, both MULTIPOINT spellings, and `SRID=…;` (EWKT). Throws a
// clear error on malformed input.

const TYPES = {
  POINT: 'Point', LINESTRING: 'LineString', POLYGON: 'Polygon',
  MULTIPOINT: 'MultiPoint', MULTILINESTRING: 'MultiLineString',
  MULTIPOLYGON: 'MultiPolygon', GEOMETRYCOLLECTION: 'GeometryCollection',
};

class Cursor {
  constructor(s) { this.s = s; this.i = 0; }
  eof() { this.skipWs(); return this.i >= this.s.length; }
  skipWs() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  peek() { this.skipWs(); return this.s[this.i]; }
  word() { this.skipWs(); let j = this.i; while (j < this.s.length && /[A-Za-z]/.test(this.s[j])) j++; const w = this.s.slice(this.i, j); this.i = j; return w.toUpperCase(); }
  expect(ch) { this.skipWs(); if (this.s[this.i] !== ch) throw new Error(`WKT: expected '${ch}' at ${this.i}, got '${this.s[this.i] || 'EOF'}'`); this.i++; }
  number() {
    this.skipWs(); let j = this.i;
    while (j < this.s.length && !/[\s,()]/.test(this.s[j])) j++;
    const tok = this.s.slice(this.i, j), n = Number(tok);
    if (tok === '' || Number.isNaN(n)) throw new Error(`WKT: bad number "${tok}" at ${this.i}`);
    this.i = j; return n;
  }
}

// one coordinate: read numbers until ',' or ')' — auto 2D/3D
function readCoord(p) {
  const c = [p.number()];
  while (p.peek() !== ',' && p.peek() !== ')') c.push(p.number());
  if (c.length < 2) throw new Error(`WKT: coordinate needs ≥2 numbers at ${p.i}`);
  return c;
}
// ( item, item, … )
function readGroup(p, readItem) {
  p.expect('('); const out = [];
  do { out.push(readItem(p)); } while (p.peek() === ',' && (p.i++, true));
  p.expect(')'); return out;
}
const readLineString = (p) => readGroup(p, readCoord);     // [[x,y],…]
const readPolygon = (p) => readGroup(p, readLineString);   // [ring,…]
// MULTIPOINT: bare `(1 2, 3 4)` or wrapped `((1 2),(3 4))`
function readMultiPoint(p) {
  p.expect('('); const out = [];
  do { out.push(p.peek() === '(' ? readGroup(p, readCoord)[0] : readCoord(p)); } while (p.peek() === ',' && (p.i++, true));
  p.expect(')'); return out;
}

function parseGeometry(p) {
  const type = p.word();
  if (!TYPES[type]) throw new Error(`WKT: unknown type "${type}"`);
  const kind = TYPES[type];
  let save = p.i; const tag = p.word();                 // optional Z / M / ZM (read + ignore)
  if (tag !== 'Z' && tag !== 'M' && tag !== 'ZM') p.i = save;
  save = p.i; if (p.word() === 'EMPTY') return kind === 'GeometryCollection' ? { type: kind, geometries: [] } : { type: kind, coordinates: [] };
  p.i = save;
  if (kind === 'Point') { p.expect('('); const c = readCoord(p); p.expect(')'); return { type: kind, coordinates: c }; }
  if (kind === 'LineString') return { type: kind, coordinates: readLineString(p) };
  if (kind === 'Polygon') return { type: kind, coordinates: readPolygon(p) };
  if (kind === 'MultiPoint') return { type: kind, coordinates: readMultiPoint(p) };
  if (kind === 'MultiLineString') return { type: kind, coordinates: readGroup(p, readLineString) };
  if (kind === 'MultiPolygon') return { type: kind, coordinates: readGroup(p, readPolygon) };
  return { type: kind, geometries: readGroup(p, parseGeometry) };   // GeometryCollection
}

export function parse(text) {
  let s = String(text).trim(), srid;
  const m = /^SRID=(\d+)\s*;\s*/i.exec(s);
  if (m) { srid = Number(m[1]); s = s.slice(m[0].length); }
  const p = new Cursor(s);
  const g = parseGeometry(p);
  if (!p.eof()) throw new Error(`WKT: trailing text at ${p.i}`);
  if (srid != null) g.srid = srid;
  return g;
}
