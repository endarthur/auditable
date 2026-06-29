// @gcu/wkt — OGC WKT codec round-trips, EWKT, EMPTY, Z, both MULTIPOINT spellings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../ext/wkt/src/main.js';

test('Point: parse + stringify round-trip', () => {
  const g = parse('POINT (30 10)');
  assert.deepEqual(g, { type: 'Point', coordinates: [30, 10] });
  assert.equal(stringify(g), 'POINT (30 10)');
});

test('LineString', () => {
  const g = parse('LINESTRING (30 10, 10 30, 40 40)');
  assert.deepEqual(g.coordinates, [[30, 10], [10, 30], [40, 40]]);
  assert.equal(stringify(g), 'LINESTRING (30 10, 10 30, 40 40)');
});

test('Polygon with a hole', () => {
  const wkt = 'POLYGON ((35 10, 45 45, 15 40, 10 20, 35 10), (20 30, 35 35, 30 20, 20 30))';
  const g = parse(wkt);
  assert.equal(g.coordinates.length, 2);
  assert.deepEqual(g.coordinates[0][0], [35, 10]);
  assert.equal(stringify(g), wkt);
});

test('MultiPoint — both spellings parse; emit the bare form', () => {
  const bare = parse('MULTIPOINT (10 40, 40 30, 20 20)');
  const wrapped = parse('MULTIPOINT ((10 40), (40 30), (20 20))');
  assert.deepEqual(bare.coordinates, wrapped.coordinates);
  assert.equal(stringify(bare), 'MULTIPOINT (10 40, 40 30, 20 20)');
});

test('MultiLineString + MultiPolygon', () => {
  const ml = parse('MULTILINESTRING ((10 10, 20 20), (40 40, 30 30))');
  assert.equal(ml.coordinates.length, 2);
  assert.equal(stringify(ml), 'MULTILINESTRING ((10 10, 20 20), (40 40, 30 30))');
  const mp = parse('MULTIPOLYGON (((30 20, 45 40, 10 40, 30 20)), ((15 5, 40 10, 10 20, 15 5)))');
  assert.equal(mp.coordinates.length, 2);
  assert.equal(parse(stringify(mp)).coordinates.length, 2);
});

test('GeometryCollection (nested)', () => {
  const g = parse('GEOMETRYCOLLECTION (POINT (4 6), LINESTRING (4 6, 7 10))');
  assert.equal(g.type, 'GeometryCollection');
  assert.equal(g.geometries.length, 2);
  assert.equal(g.geometries[0].type, 'Point');
  assert.equal(stringify(g), 'GEOMETRYCOLLECTION (POINT (4 6), LINESTRING (4 6, 7 10))');
});

test('EWKT SRID prefix round-trips', () => {
  const g = parse('SRID=31983;POINT (600000 7700000)');
  assert.equal(g.srid, 31983);
  assert.deepEqual(g.coordinates, [600000, 7700000]);
  assert.equal(stringify(g), 'SRID=31983;POINT (600000 7700000)');
  assert.equal(stringify({ type: 'Point', coordinates: [1, 2] }, { srid: 4326 }), 'SRID=4326;POINT (1 2)');
});

test('Z (3D) coordinates self-describe; tag is ignored', () => {
  const g = parse('POINT Z (1 2 3)');
  assert.deepEqual(g.coordinates, [1, 2, 3]);
  assert.deepEqual(parse('LINESTRING (1 2 3, 4 5 6)').coordinates, [[1, 2, 3], [4, 5, 6]]);
});

test('EMPTY geometries', () => {
  assert.deepEqual(parse('POINT EMPTY'), { type: 'Point', coordinates: [] });
  assert.equal(stringify({ type: 'Polygon', coordinates: [] }), 'POLYGON EMPTY');
  assert.deepEqual(parse('GEOMETRYCOLLECTION EMPTY'), { type: 'GeometryCollection', geometries: [] });
});

test('precision option + negative/decimal coords', () => {
  const g = parse('POINT (-1.23456 2.5)');
  assert.deepEqual(g.coordinates, [-1.23456, 2.5]);
  assert.equal(stringify(g, { precision: 2 }), 'POINT (-1.23 2.5)');
});

test('malformed input throws clearly', () => {
  assert.throws(() => parse('POINT (1)'), /coordinate|bad number|expected/);
  assert.throws(() => parse('WIBBLE (1 2)'), /unknown type/);
  assert.throws(() => parse('POINT (1 2) extra'), /trailing/);
});
