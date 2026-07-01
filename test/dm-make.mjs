// Test-only synthetic Datamine .DM writer — builds valid SP/EP/LE/BE buffers so
// the @gcu/dm reader can be validated without shipping a writer. Shared by
// test/dm.test.mjs and test/lamina-smoke.mjs.
// ── a minimal .dm writer (test-only) ──
// fields: [{ name, type:'N'|'A', width?, constant?, longName? }]; rows: objects.
// `longName` (EP only, ≤24 chars) writes the extended-name encoding: legacy 8-char
// prefix in words 0–1 low halves, chars 9–24 in the high halves + word 5, flagged
// by "LONG" in the type word's high half (see dm-reader-long-field-names.md §7).
export function makeDM(fields, rows, { precision = 'sp', byteOrder = 'le' } = {}) {
  const ws = precision === 'ep' ? 8 : 4;
  const ps = precision === 'ep' ? 4096 : 2048;
  const isLE = byteOrder === 'le';
  const dateOff = precision === 'ep' ? 192 : 96;

  // Assign stored-word positions; build the field-definition entry list.
  const entries = [];          // { name, type, sw, wordno, def }
  let sw = 1;
  for (const f of fields) {
    const words = f.type === 'A' ? (f.width || 4) / 4 : 1;
    for (let w = 0; w < words; w++) {
      const isConst = f.constant !== undefined;
      entries.push({ name: f.name, type: f.type, sw: isConst ? 0 : sw + w, wordno: w + 1, def: f.constant, fieldWord: w, longName: w === 0 ? f.longName : undefined });
    }
    if (f.constant === undefined) sw += words;
  }
  const maxLen = sw - 1;
  const recsPerPage = Math.floor(508 / maxLen);
  const dataPages = Math.max(1, Math.ceil(rows.length / recsPerPage));
  const lastPage = 1 + dataPages;
  const lastRec = rows.length - (dataPages - 1) * recsPerPage;

  const buf = new ArrayBuffer(ps * (1 + dataPages));
  const dv = new DataView(buf);
  const setNum = (o, v) => (precision === 'ep' ? dv.setFloat64(o, v, isLE) : dv.setFloat32(o, v, isLE));
  const setText = (o, s, nWords) => { for (let w = 0; w < nWords; w++) for (let b = 0; b < 4; b++) dv.setUint8(o + w * ws + b, b < s.length - w * 4 ? s.charCodeAt(w * 4 + b) : 32); };
  const packChars = (s) => { const tb = new DataView(new ArrayBuffer(8)); for (let b = 0; b < 4; b++) tb.setUint8(b, b < s.length ? s.charCodeAt(b) : 32); return precision === 'ep' ? tb.getFloat64(0, isLE) : tb.getFloat32(0, isLE); };

  // DD header
  setText(0, 'TESTDM', 2);
  setText(precision === 'ep' ? 32 : 16, 'a test file', 20);
  setNum(dateOff, 20240615);
  setNum(dateOff + ws, entries.length);          // NVAR
  setNum(dateOff + ws * 2, lastPage);
  setNum(dateOff + ws * 3, lastRec);
  const fieldStart = dateOff + ws * 4, fieldSize = ws * 7;
  entries.forEach((e, i) => {
    const o = fieldStart + i * fieldSize;
    setText(o, e.name, 2);
    setText(o + ws * 2, e.type, 1);
    if (e.longName && precision === 'ep') {                // extended-name encoding (§7)
      const p = e.longName.slice(0, 24).padEnd(24, ' ');
      const put = [[0, 0], [ws, 4], [4, 8], [ws + 4, 12], [ws * 5, 16], [ws * 5 + 4, 20]];
      for (const [pos, c] of put) for (let b = 0; b < 4; b++) dv.setUint8(o + pos + b, p.charCodeAt(c + b));
      for (let b = 0; b < 4; b++) dv.setUint8(o + ws * 2 + 4 + b, [0x4C, 0x4F, 0x4E, 0x47][b]);  // "LONG"
    }
    setNum(o + ws * 3, e.sw);
    setNum(o + ws * 4, e.wordno);
    let def = 0;
    if (e.def !== undefined) def = e.type === 'A' ? packChars(String(e.def).slice(e.fieldWord * 4, e.fieldWord * 4 + 4)) : e.def;
    setNum(o + ws * 6, def);
  });

  // Data pages
  const stored = entries.filter((e) => e.sw > 0);
  rows.forEach((row, ri) => {
    const page = Math.floor(ri / recsPerPage), recInPage = ri % recsPerPage;
    const recStart = ps * (1 + page) + recInPage * maxLen * ws;
    for (const e of stored) {
      const o = recStart + (e.sw - 1) * ws;
      const val = e.longName !== undefined && e.longName in row ? row[e.longName] : row[e.name];
      if (e.type === 'A') { const chunk = String(val ?? '').slice(e.fieldWord * 4, e.fieldWord * 4 + 4); for (let b = 0; b < 4; b++) dv.setUint8(o + b, b < chunk.length ? chunk.charCodeAt(b) : 32); }
      else setNum(o, val == null ? -1e30 : val);
    }
  });
  return buf;
}
