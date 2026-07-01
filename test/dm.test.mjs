// @gcu/dm — Datamine .DM reader. Validated against synthetic .dm files built here
// (the spec ships no writer; these fixtures are test-only). Covers SP/EP, both
// endiannesses, multi-word alpha, file constants, and the missing-value sentinel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDM, detectDM, parseHeader, recordRange, decodeRecord, DMFormatError } from '../ext/dm/src/dm.js';
import { makeDM } from './dm-make.mjs';


test('readDM: SP, numeric fields, round-trip', () => {
  const buf = makeDM([{ name: 'X', type: 'N' }, { name: 'Y', type: 'N' }, { name: 'AU', type: 'N' }],
    [{ X: 1, Y: 2, AU: 0.5 }, { X: 3, Y: 4, AU: 1.25 }, { X: 5, Y: 6, AU: 9 }]);
  const dm = readDM(buf);
  assert.equal(dm.precision, 'sp');
  assert.equal(dm.byteOrder, 'le');
  assert.equal(dm.recordCount, 3);
  assert.deepEqual(dm.fields.map((f) => f.name), ['X', 'Y', 'AU']);
  assert.equal(dm.fields[2].type, 'number');
  assert.deepEqual(dm.getRecord(0), { X: 1, Y: 2, AU: 0.5 });
  assert.equal(dm.getRecord(2).AU, 9);
  const cols = dm.getColumns();
  assert.ok(cols.X instanceof Float32Array);
  assert.deepEqual([...cols.AU], [0.5, 1.25, 9]);
});

test('readDM: multi-word alpha (BHID, 8 chars) reconstructs', () => {
  const buf = makeDM([{ name: 'BHID', type: 'A', width: 8 }, { name: 'FROM', type: 'N' }, { name: 'TO', type: 'N' }],
    [{ BHID: 'DDH00012', FROM: 0, TO: 1.5 }, { BHID: 'DDH00012', FROM: 1.5, TO: 3 }, { BHID: 'RC0007', FROM: 0, TO: 2 }]);
  const dm = readDM(buf);
  assert.equal(dm.fields[0].type, 'string');
  assert.equal(dm.fields[0].name, 'BHID');
  assert.equal(dm.getRecord(0).BHID, 'DDH00012');
  assert.equal(dm.getRecord(2).BHID, 'RC0007');           // trimmed
  assert.equal(dm.getRecord(1).TO, 3);
});

test('readDM: file constant (SW=0) — numeric + alpha', () => {
  const buf = makeDM([{ name: 'X', type: 'N' }, { name: 'ROCK', type: 'A', width: 4, constant: 'OX' }, { name: 'DENS', type: 'N', constant: 2.7 }],
    [{ X: 10 }, { X: 20 }]);
  const dm = readDM(buf);
  const rec = dm.getRecord(0);
  assert.equal(rec.X, 10);
  assert.equal(rec.ROCK, 'OX');
  assert.ok(Math.abs(rec.DENS - 2.7) < 1e-5);             // f32 constant
  assert.ok(Math.abs(dm.getColumns().DENS - 2.7) < 1e-5); // constant → single value
});

test('readDM: missing-value sentinel → null / NaN', () => {
  const buf = makeDM([{ name: 'X', type: 'N' }, { name: 'AU', type: 'N' }], [{ X: 1, AU: null }, { X: 2, AU: 3 }]);
  const dm = readDM(buf);
  assert.equal(dm.getRecord(0).AU, null);
  assert.equal(dm.getRecord(1).AU, 3);
  assert.ok(Number.isNaN(dm.getColumns().AU[0]));
});

test('readDM: EP (Float64) round-trip', () => {
  const buf = makeDM([{ name: 'X', type: 'N' }, { name: 'V', type: 'N' }],
    [{ X: 1, V: 0.1 }, { X: 2, V: 0.2 }], { precision: 'ep' });
  const dm = readDM(buf);
  assert.equal(dm.precision, 'ep');
  assert.equal(dm.recordCount, 2);
  assert.equal(dm.getRecord(1).V, 0.2);                    // exact in f64
  assert.ok(dm.getColumns().X instanceof Float64Array);
});

test('detectDM: big-endian SP', () => {
  const buf = makeDM([{ name: 'A', type: 'N' }, { name: 'B', type: 'N' }], [{ A: 7, B: 8 }], { byteOrder: 'be' });
  assert.deepEqual(detectDM(new Uint8Array(buf)), { precision: 'sp', byteOrder: 'be' });
  assert.equal(readDM(buf).getRecord(0).A, 7);
});

test('windowed: parseHeader + recordRange + decodeRecord (the lamina path)', () => {
  const buf = makeDM([{ name: 'ID', type: 'A', width: 4 }, { name: 'G', type: 'N' }],
    Array.from({ length: 1500 }, (_, i) => ({ ID: 'P' + (i % 9), G: i * 0.1 })), { precision: 'sp' });
  const u8 = new Uint8Array(buf);
  const fmt = detectDM(u8.subarray(0, 4096));
  const h = parseHeader(u8, fmt);                          // header only (first page)
  assert.equal(h.recordCount, 1500);
  const r = recordRange(h, 1234);                          // a deep record, computed offset
  const vals = decodeRecord(u8.subarray(r.offset, r.offset + r.length), h);
  assert.equal(vals[0], 'P' + (1234 % 9));
  assert.ok(Math.abs(vals[1] - 123.4) < 1e-3);
});

// ── Extended (>8-char) EP field names (dm-reader-long-field-names.md) ──

// What a legacy 8-char reader extracts for field 0 (EP): the low halves of words 0–1.
function legacyName(buf) {
  const dv = new DataView(buf), o = 192 + 8 * 4;
  let s = '';
  for (const w of [0, 8]) for (let b = 0; b < 4; b++) { const c = dv.getUint8(o + w + b); if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  return s.trim();
}

test('EP long name: 16-char name recovered, internal space preserved', () => {
  const buf = makeDM([{ name: 'AU', type: 'N' }, { name: 'RefinedG', type: 'N', longName: 'Refined Geologia' }],
    [{ AU: 1, 'Refined Geologia': 3 }], { precision: 'ep' });
  const dm = readDM(buf);
  assert.ok(dm.fields.some((f) => f.name === 'Refined Geologia'));   // full name, internal space kept
  assert.equal(dm.getRecord(0)['Refined Geologia'], 3);
});

test('EP long name: 24-char name round-trips (encoding bound)', () => {
  const full = 'Densidade Aparente Media';                          // exactly 24 chars
  assert.equal(full.length, 24);
  const buf = makeDM([{ name: 'X', type: 'N' }, { name: 'DensAppM', type: 'N', longName: full }],
    [{ X: 1, [full]: 2.7 }], { precision: 'ep' });
  const dm = readDM(buf);
  assert.ok(dm.fields.some((f) => f.name === full));
  assert.ok(Math.abs(dm.getRecord(0)[full] - 2.7) < 1e-9);
});

test('EP long name: additive — legacy 8-char reader still sees the prefix', () => {
  const buf = makeDM([{ name: 'Refined', type: 'N', longName: 'Refined Geologia' }],
    [{ 'Refined Geologia': 1 }], { precision: 'ep' });
  assert.equal(legacyName(buf), 'Refined');                          // chars 1–8 in the low halves, untouched
  assert.equal(readDM(buf).fields[0].name, 'Refined Geologia');      // new reader recovers the full name
});

test('EP entry WITHOUT the flag: normal 8-char read stands', () => {
  const buf = makeDM([{ name: 'GRADE', type: 'N' }], [{ GRADE: 5 }], { precision: 'ep' });
  assert.equal(readDM(buf).fields[0].name, 'GRADE');                 // no "LONG" flag → legacy path
});

test('SP: readLongName never triggers (no high half)', () => {
  const buf = makeDM([{ name: 'GRADE', type: 'N', longName: 'ignored in SP' }], [{ GRADE: 5 }], { precision: 'sp' });
  assert.equal(readDM(buf).fields[0].name, 'GRADE');                 // SP → 4-byte words, no long mechanism
});

test('EP long names sharing first 8 chars resolve to DISTINCT columns (the bug)', () => {
  const a = 'Refined Geologia', b = 'Refined Estrutural';           // both truncate to "Refined"
  const buf = makeDM([{ name: 'RefinedG', type: 'N', longName: a }, { name: 'RefinedE', type: 'N', longName: b }],
    [{ [a]: 1, [b]: 2 }], { precision: 'ep' });
  const dm = readDM(buf);
  const names = dm.fields.map((f) => f.name);
  assert.ok(names.includes(a) && names.includes(b));                // two columns, not one merged
  assert.equal(dm.recordCount, 1);
  assert.equal(dm.getRecord(0)[a], 1);
  assert.equal(dm.getRecord(0)[b], 2);
});

test('detectDM / readDM: rejects non-dm', () => {
  assert.equal(detectDM(new Uint8Array(2048)), null);     // all zeros → NVAR 0
  assert.throws(() => readDM(new Uint8Array(10)), DMFormatError);
});
