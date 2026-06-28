// @gcu/dxf — v0.1 foundation primitives: the group-code tokenizer, the bulge↔arc math,
// and the un-flattened colour model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairs, serializePairs, valueKind } from '../ext/dxf/src/tokenize.js';
import { arcFromBulge, bulgeFromArc, arcMidpoint, TAU } from '../ext/dxf/src/arc.js';
import { resolveColor, colorToPairs, aciToRgb } from '../ext/dxf/src/color.js';

// ── tokenize ─────────────────────────────────────────────────────────────────────

const SAMPLE = '0\nLINE\n8\nWALL\n10\n600123.456\n20\n7700987.654\n30\n0.0\n62\n256\n';

test('parsePairs: code-driven value typing (doubles vs ints vs strings)', () => {
  const p = parsePairs(SAMPLE);
  assert.deepEqual(p[0], { code: 0, value: 'LINE' });          // 0-9 → string
  assert.deepEqual(p[1], { code: 8, value: 'WALL' });          // layer → string
  assert.deepEqual(p[2], { code: 10, value: 600123.456 });     // 10-59 → double
  assert.equal(p[3].value, 7700987.654);
  assert.deepEqual(p[5], { code: 62, value: 256 });            // 60-79 → int
  assert.equal(typeof p[5].value, 'number');
});

test('parsePairs: handles CRLF and blank lines, never throws on junk', () => {
  assert.deepEqual(parsePairs('0\r\nLINE\r\n8\r\nWALL\r\n')[0], { code: 0, value: 'LINE' });
  // a desynced / garbage code line is skipped, not fatal
  assert.doesNotThrow(() => parsePairs('not-a-code\nLINE\n0\nCIRCLE\n'));
  const p = parsePairs('not-a-code\nLINE\n0\nCIRCLE\n');
  assert.deepEqual(p.at(-1), { code: 0, value: 'CIRCLE' });
  assert.deepEqual(parsePairs(''), []);                        // empty input
  assert.deepEqual(parsePairs('5'), [{ code: 5, value: '' }]); // dangling code → empty value
});

test('valueKind: the DXF code→type ranges', () => {
  assert.equal(valueKind(0), 'str');
  assert.equal(valueKind(8), 'str');
  assert.equal(valueKind(10), 'num');
  assert.equal(valueKind(42), 'num');     // bulge
  assert.equal(valueKind(62), 'int');     // ACI colour
  assert.equal(valueKind(90), 'int');
  assert.equal(valueKind(420), 'int');    // true colour
  assert.equal(valueKind(1000), 'str');   // XDATA string
  assert.equal(valueKind(1040), 'num');   // XDATA real
  assert.equal(valueKind(1070), 'int');   // XDATA int
});

test('serializePairs ↔ parsePairs round-trip', () => {
  const pairs = [
    { code: 0, value: 'LINE' }, { code: 8, value: 'WALL' },
    { code: 10, value: 600123.456 }, { code: 20, value: 7700987.654 }, { code: 30, value: 0 },
    { code: 62, value: 256 },
  ];
  const round = parsePairs(serializePairs(pairs));
  assert.equal(round[2].value, 600123.456);                    // UTM-magnitude double survives
  assert.equal(round[3].value, 7700987.654);
  assert.deepEqual(round[0], { code: 0, value: 'LINE' });
  assert.deepEqual(round[5], { code: 62, value: 256 });
});

// ── arc (the bulge throughline) ────────────────────────────────────────────────────

test('arcFromBulge: a CCW quarter circle about the origin', () => {
  const a = arcFromBulge([1, 0], [0, 1], Math.tan(Math.PI / 8));   // θ = 90°
  assert.ok(Math.hypot(a.center[0], a.center[1]) < 1e-12);         // center at origin
  assert.ok(Math.abs(a.radius - 1) < 1e-12);
  assert.ok(Math.abs(a.sweep - Math.PI / 2) < 1e-12);
  assert.equal(a.ccw, true);
});

test('arcFromBulge: semicircle (|bulge|=1) puts the center at the chord midpoint', () => {
  const a = arcFromBulge([0, 0], [2, 0], 1);                       // θ = 180°
  assert.ok(Math.abs(a.center[0] - 1) < 1e-12 && Math.abs(a.center[1]) < 1e-12);
  assert.ok(Math.abs(a.radius - 1) < 1e-12);
});

test('arcFromBulge: straight / degenerate spans return null (treated as lines)', () => {
  assert.equal(arcFromBulge([0, 0], [1, 1], 0), null);            // bulge 0 = line
  assert.equal(arcFromBulge([5, 5], [5, 5], 0.5), null);         // coincident endpoints
});

test('bulgeFromArc: a DXF ARC (center-form, CCW) → endpoint+bulge', () => {
  const { start, end, bulge } = bulgeFromArc([0, 0], 1, 0, Math.PI / 2);
  assert.ok(Math.abs(start[0] - 1) < 1e-12 && Math.abs(start[1]) < 1e-12);
  assert.ok(Math.abs(end[0]) < 1e-12 && Math.abs(end[1] - 1) < 1e-12);
  assert.ok(Math.abs(bulge - Math.tan(Math.PI / 8)) < 1e-12);
});

test('bulge ↔ arc round-trip (CCW) recovers endpoints and bulge', () => {
  // bulgeFromArc assumes the DXF CCW convention, so its clean inverse is positive bulges.
  for (const b of [0.2, 0.4142, 1, 2.5]) {
    const p0 = [3, 7], p1 = [9, 5];
    const a = arcFromBulge(p0, p1, b);
    const rt = bulgeFromArc(a.center, a.radius, a.startAngle, a.endAngle);
    assert.ok(Math.abs(rt.start[0] - p0[0]) < 1e-9 && Math.abs(rt.start[1] - p0[1]) < 1e-9);
    assert.ok(Math.abs(rt.end[0] - p1[0]) < 1e-9 && Math.abs(rt.end[1] - p1[1]) < 1e-9);
    assert.ok(Math.abs(rt.bulge - b) < 1e-9);
  }
});

test('arcFromBulge: a negative bulge is the CW arc (same shape, opposite side)', () => {
  const a = arcFromBulge([0, 0], [2, 0], -1);                     // CW semicircle
  assert.ok(Math.abs(a.center[0] - 1) < 1e-12 && Math.abs(a.center[1]) < 1e-12);
  assert.ok(Math.abs(a.radius - 1) < 1e-12);
  assert.equal(a.ccw, false);
});

test('DXF arc round-trip: bulgeFromArc → arcFromBulge recovers center & radius', () => {
  for (const [s, e] of [[0, Math.PI / 2], [0.3, 2.7], [Math.PI, Math.PI / 4]]) {
    const { start, end, bulge } = bulgeFromArc([10, -4], 5, s, e);
    const a = arcFromBulge(start, end, bulge);
    assert.ok(Math.abs(a.center[0] - 10) < 1e-9 && Math.abs(a.center[1] + 4) < 1e-9);
    assert.ok(Math.abs(a.radius - 5) < 1e-9);
  }
});

test('arcMidpoint: on the arc, not the chord', () => {
  const mid = arcMidpoint([1, 0], [0, 1], Math.tan(Math.PI / 8));   // 45° point on unit circle
  assert.ok(Math.abs(mid[0] - Math.SQRT1_2) < 1e-12 && Math.abs(mid[1] - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(arcMidpoint([0, 0], [4, 0], 0), [2, 0]);         // straight → chord midpoint
  assert.ok(TAU > 6.28 && TAU < 6.29);
});

// ── colour (un-flattened) ──────────────────────────────────────────────────────────

test('resolveColor: ACI / BYLAYER / BYBLOCK / true-colour stay DISTINCT', () => {
  assert.deepEqual(resolveColor({ aci: 1 }), { mode: 'aci', index: 1 });
  assert.deepEqual(resolveColor({ aci: 256 }), { mode: 'bylayer' });
  assert.deepEqual(resolveColor({}), { mode: 'bylayer' });                  // absent → bylayer
  assert.deepEqual(resolveColor({ aci: 0 }), { mode: 'byblock' });
  assert.deepEqual(resolveColor({ aci: -3 }), { mode: 'aci', index: 3, off: true });
  assert.deepEqual(resolveColor({ trueColor: 0xff8800 }), { mode: 'rgb', r: 255, g: 136, b: 0 });
  // true colour wins over ACI when both present (DXF precedence)
  assert.deepEqual(resolveColor({ aci: 1, trueColor: 0x0000ff }), { mode: 'rgb', r: 0, g: 0, b: 255 });
});

test('colorToPairs: serialize back to the right group codes, round-trip', () => {
  assert.deepEqual(colorToPairs({ mode: 'aci', index: 5 }), [{ code: 62, value: 5 }]);
  assert.deepEqual(colorToPairs({ mode: 'bylayer' }), [{ code: 62, value: 256 }]);
  assert.deepEqual(colorToPairs({ mode: 'byblock' }), [{ code: 62, value: 0 }]);
  assert.deepEqual(colorToPairs({ mode: 'rgb', r: 255, g: 136, b: 0 }), [{ code: 420, value: 0xff8800 }]);
  // round-trip a true colour through pairs
  const c = resolveColor({ trueColor: 0x123456 });
  assert.deepEqual(resolveColor({ trueColor: colorToPairs(c)[0].value }), c);
});

test('aciToRgb: the 7 standard named colours, null beyond', () => {
  assert.deepEqual(aciToRgb(1), [255, 0, 0]);
  assert.deepEqual(aciToRgb(5), [0, 0, 255]);
  assert.equal(aciToRgb(42), null);
});

// ── read (the Document assembler) ──────────────────────────────────────────────────

import { read } from '../ext/dxf/src/read.js';

const DXF = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
9
$INSUNITS
70
6
0
ENDSEC
0
SECTION
2
TABLES
0
LAYER
2
DH_TRACES
62
1
6
CONTINUOUS
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
COLLAR
10
0.0
20
0.0
30
0.0
0
POINT
8
0
10
0.0
20
0.0
30
0.0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
5
2F1A
8
WALL
10
600000.0
20
7700000.0
30
0.0
11
600100.0
21
7700050.0
31
0.0
1001
GCU_GEOL
1000
IF
1040
0.82
0
LWPOLYLINE
8
OUTLINE
90
3
70
1
10
600000.0
20
7700000.0
42
0.5
10
600100.0
20
7700000.0
10
600100.0
20
7700080.0
0
CIRCLE
8
HOLES
10
600050.0
20
7700040.0
30
0.0
40
5.0
0
ARC
8
CURVE
10
600000.0
20
7700000.0
30
0.0
40
10.0
50
0.0
51
90.0
0
POINT
8
PTS
10
600025.0
20
7700025.0
30
1000.0
0
3DFACE
8
FACE
10
600000.0
20
7700000.0
30
0.0
11
600010.0
21
7700000.0
31
0.0
12
600010.0
22
7700010.0
32
0.0
13
600010.0
23
7700010.0
33
0.0
0
INSERT
8
COLLARS
66
1
2
COLLAR
10
600060.0
20
7700060.0
30
0.0
0
ATTRIB
8
COLLARS
2
HOLEID
1
QF-DH-0421
10
600060.0
20
7700060.0
30
0.0
0
SEQEND
0
SPLINE
8
SPLINES
0
ENDSEC
0
EOF
`;

test('read: header units, layers, and feature roster', () => {
  const doc = read(DXF);
  assert.equal(doc.header.acadver, 'AC1015');
  assert.equal(doc.header.units, 'm');                                   // $INSUNITS 6 → metres
  assert.ok(doc.layers.DH_TRACES);
  assert.deepEqual(doc.features.map((f) => f.type), ['line', 'polyline', 'circle', 'arc', 'point', 'face', 'insert', null]);
});

test('read: LINE keeps WORLD coordinates canonical + the full attribute bag', () => {
  const line = read(DXF).features[0];
  assert.equal(line.geometry.kind, 'polyline');
  assert.deepEqual([...line.geometry.vertices], [600000, 7700000, 0, 600100, 7700050, 0]);   // not shifted
  assert.equal(line.properties.handle, '2F1A');
  assert.equal(line.properties.layer, 'WALL');
  assert.deepEqual(line.properties.color, { mode: 'bylayer' });         // entity has no own colour → defers to its layer
  assert.deepEqual(line.properties.xdata.GCU_GEOL, [{ code: 1000, value: 'IF' }, { code: 1040, value: 0.82 }]);
});

test('read: LWPOLYLINE is bulge-native and closed', () => {
  const pl = read(DXF).features[1];
  assert.equal(pl.geometry.closed, true);
  assert.equal(pl.geometry.vertices.length, 9);                         // 3 verts × 3
  assert.equal(pl.geometry.bulges[0], 0.5);                             // first span is an arc
});

test('read: ARC enters as endpoint+bulge (true arc, not faceted)', () => {
  const arc = read(DXF).features[3];
  assert.equal(arc.type, 'arc');
  const v = arc.geometry.vertices;
  assert.ok(Math.abs(v[0] - 600010) < 1e-6 && Math.abs(v[1] - 7700000) < 1e-6);   // start = centre + (r,0)
  assert.ok(Math.abs(v[3] - 600000) < 1e-6 && Math.abs(v[4] - 7700010) < 1e-6);   // end   = centre + (0,r)
  assert.ok(Math.abs(arc.geometry.bulges[0] - Math.tan(Math.PI / 8)) < 1e-9);     // 90° → bulge tan(22.5°)
});

test('read: 3DFACE collapses a degenerate quad to a triangle; POINT keeps RL', () => {
  const doc = read(DXF);
  assert.equal(doc.features[5].geometry.vertices.length, 9);            // 3 corners (4th == 3rd)
  assert.equal(doc.features[4].geometry.position[2], 1000);             // z / RL preserved
});

test('read: INSERT preserved (block ref + folded ATTRIB hole-id), not exploded', () => {
  const ins = read(DXF).features[6];
  assert.equal(ins.geometry.kind, 'insert');
  assert.equal(ins.geometry.block, 'COLLAR');
  assert.deepEqual(ins.geometry.transform.position, [600060, 7700060, 0]);
  assert.equal(ins.properties.attribs[0].tag, 'HOLEID');
  assert.equal(ins.properties.attribs[0].value, 'QF-DH-0421');         // the geology rides along
  assert.ok(read(DXF).blocks.COLLAR);                                   // block definition kept
});

test('read: unsupported entity is punted with metadata + a warning, never a throw', () => {
  const doc = read(DXF);
  const punt = doc.features[7];
  assert.equal(punt.type, null);
  assert.equal(punt.geometry, null);
  assert.equal(punt.properties.dropped, 'SPLINE');
  assert.ok(doc.warnings.some((w) => w.entity === 'SPLINE'));
});

test('read: recommends a working frame from the bbox (floor), coords stay world', () => {
  const doc = read(DXF);
  assert.deepEqual(doc.frame.origin, [600000, 7700000, 0]);            // floor of bbox-min, rounded
  assert.equal(doc.frame.units, 'm');
  assert.deepEqual(doc.header.coordinate_provenance.bbox_original.max, [600100, 7700080, 1000]);
  assert.equal(doc.header.coordinate_provenance.importer, '@gcu/dxf@0.1.0');
});

test('read: bulletproof over garbage — never throws, returns an empty roster', () => {
  assert.doesNotThrow(() => read('garbage\nnonsense\n\n42\n'));
  assert.deepEqual(read('').features, []);
});

// ── write (round-trip) + explode ─────────────────────────────────────────────────

import { write } from '../ext/dxf/src/write.js';
import { explode } from '../ext/dxf/src/explode.js';

test('write → read round-trip preserves geometry, blocks, XDATA, attribs, handles', () => {
  const doc2 = read(write(read(DXF)));
  // punted SPLINE isn't re-emitted; the seven real entities survive in order
  assert.deepEqual(doc2.features.map((f) => f.type), ['line', 'polyline', 'circle', 'arc', 'point', 'face', 'insert']);

  const line = doc2.features[0];
  assert.deepEqual([...line.geometry.vertices], [600000, 7700000, 0, 600100, 7700050, 0]);   // world coords restored
  assert.equal(line.properties.handle, '2F1A');                                              // source handle preserved
  assert.deepEqual(line.properties.xdata.GCU_GEOL, [{ code: 1000, value: 'IF' }, { code: 1040, value: 0.82 }]);

  const pl = doc2.features[1];
  assert.equal(pl.geometry.closed, true);
  assert.equal(pl.geometry.bulges[0], 0.5);                                                  // bulge survives

  const arc = doc2.features[3];
  assert.ok(Math.abs(arc.geometry.vertices[0] - 600010) < 1e-6);
  assert.ok(Math.abs(arc.geometry.bulges[0] - Math.tan(Math.PI / 8)) < 1e-9);                // true arc, not faceted

  const ins = doc2.features[6];
  assert.equal(ins.geometry.block, 'COLLAR');
  assert.deepEqual(ins.geometry.transform.position, [600060, 7700060, 0]);
  assert.equal(ins.properties.attribs[0].value, 'QF-DH-0421');                               // hole-id round-trips
  assert.ok(doc2.blocks.COLLAR);                                                             // block def round-trips
  assert.equal(doc2.header.units, 'm');
});

test('write: a frame-local doc is restored to world (fromLocal)', () => {
  const doc = read(DXF);
  // simulate working in the local frame: shift the LINE into local coords
  const local = { ...doc, features: doc.features.map((f) => f) };
  const lineLocal = { ...doc.features[0], geometry: { ...doc.features[0].geometry, vertices: Float64Array.from([0, 0, 0, 100, 50, 0]) } };
  local.features = [lineLocal, ...doc.features.slice(1)];
  const back = read(write(local, { fromLocal: true }));               // toWorld re-adds origin [600000,7700000,0]
  assert.deepEqual([...back.features[0].geometry.vertices], [600000, 7700000, 0, 600100, 7700050, 0]);
});

test('explode: resolves INSERT to transformed block geometry (opt-in)', () => {
  const ex = explode(read(DXF));
  assert.ok(!ex.features.some((f) => f.geometry?.kind === 'insert'));   // no inserts remain
  const pts = ex.features.filter((f) => f.geometry?.kind === 'point').map((f) => f.geometry.position);
  assert.ok(pts.some((p) => Math.abs(p[0] - 600060) < 1e-9 && Math.abs(p[1] - 7700060) < 1e-9 && Math.abs(p[2]) < 1e-9));
  assert.equal(ex.exploded, true);
});

test('explode: a cyclic block reference is guarded, not infinite', () => {
  const insA = (pos) => ({ type: 'insert', geometry: { kind: 'insert', block: 'A', transform: { position: pos, scale: [1, 1, 1], rotation: 0 } }, properties: {} });
  const doc = { features: [insA([0, 0, 0])], blocks: { A: { name: 'A', base: [0, 0, 0], features: [insA([1, 0, 0])] } }, warnings: [] };
  let ex;
  assert.doesNotThrow(() => { ex = explode(doc); });
  assert.ok(ex.warnings.some((w) => /cyclic/.test(w.reason)));
});

test('explode: a rotated + translated insert composes correctly', () => {
  // a block with a point at (1,0,0), inserted at (10,20,0) rotated 90° → (10,21,0)
  const doc = {
    features: [{ type: 'insert', geometry: { kind: 'insert', block: 'P', transform: { position: [10, 20, 0], scale: [1, 1, 1], rotation: 90 } }, properties: {} }],
    blocks: { P: { name: 'P', base: [0, 0, 0], features: [{ type: 'point', geometry: { kind: 'point', position: [1, 0, 0] }, properties: {} }] } }, warnings: [],
  };
  const p = explode(doc).features[0].geometry.position;
  assert.ok(Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] - 21) < 1e-9 && Math.abs(p[2]) < 1e-9);
});
