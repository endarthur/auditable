import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// import the built bundle
const { sheet } = await import('../ext/sheet/index.js');

// ═════════════════════════════════════════════════════════════════════
// CRC32
// ═════════════════════════════════════════════════════════════════════

describe('crc32', () => {
  it('empty input', () => {
    assert.equal(sheet._crc32(new Uint8Array(0)), 0x00000000);
  });

  it('known vector: "123456789"', () => {
    const input = new TextEncoder().encode('123456789');
    assert.equal(sheet._crc32(input), 0xCBF43926);
  });

  it('single byte', () => {
    const result = sheet._crc32(new Uint8Array([0x00]));
    assert.equal(typeof result, 'number');
    assert.ok(result >= 0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ZIP round-trip
// ═════════════════════════════════════════════════════════════════════

describe('zip/unzip', () => {
  it('round-trips a single file', async () => {
    const data = new TextEncoder().encode('hello world');
    const entries = new Map([['test.txt', data]]);
    const zipped = await sheet._zip(entries);
    assert.ok(zipped instanceof Uint8Array);
    assert.ok(zipped.length > 0);

    const result = await sheet._unzip(zipped);
    assert.ok(result.has('test.txt'));
    assert.deepEqual(result.get('test.txt'), data);
  });

  it('round-trips multiple files', async () => {
    const enc = new TextEncoder();
    const entries = new Map([
      ['a.txt', enc.encode('alpha')],
      ['dir/b.xml', enc.encode('<root>beta</root>')],
      ['c.bin', new Uint8Array([0, 1, 2, 255, 254, 253])],
    ]);
    const zipped = await sheet._zip(entries);
    const result = await sheet._unzip(zipped);

    assert.equal(result.size, 3);
    assert.deepEqual(new TextDecoder().decode(result.get('a.txt')), 'alpha');
    assert.deepEqual(new TextDecoder().decode(result.get('dir/b.xml')), '<root>beta</root>');
    assert.deepEqual(result.get('c.bin'), new Uint8Array([0, 1, 2, 255, 254, 253]));
  });

  it('handles empty file', async () => {
    const entries = new Map([['empty.txt', new Uint8Array(0)]]);
    const zipped = await sheet._zip(entries);
    const result = await sheet._unzip(zipped);
    assert.equal(result.get('empty.txt').length, 0);
  });

  it('handles large compressible data', async () => {
    const data = new Uint8Array(10000);
    data.fill(65); // all 'A's — highly compressible
    const entries = new Map([['big.txt', data]]);
    const zipped = await sheet._zip(entries);
    assert.ok(zipped.length < data.length); // should compress well
    const result = await sheet._unzip(zipped);
    assert.deepEqual(result.get('big.txt'), data);
  });
});

// ═════════════════════════════════════════════════════════════════════
// XML builder
// ═════════════════════════════════════════════════════════════════════

describe('tag()', () => {
  it('self-closing with no children', () => {
    assert.equal(sheet._tag('br', null), '<br/>');
  });

  it('with attributes', () => {
    assert.equal(sheet._tag('c', { r: 'A1', t: 's' }), '<c r="A1" t="s"/>');
  });

  it('with children', () => {
    const result = sheet._tag('row', { r: 1 }, sheet._tag('c', { r: 'A1' }, 'hello'));
    assert.equal(result, '<row r="1"><c r="A1">hello</c></row>');
  });

  it('escapes attribute values', () => {
    const result = sheet._tag('t', null, sheet._escape('a & b < c'));
    assert.equal(result, '<t>a &amp; b &lt; c</t>');
  });

  it('skips null/undefined attributes', () => {
    const result = sheet._tag('x', { a: 1, b: null, c: undefined, d: 'ok' });
    assert.equal(result, '<x a="1" d="ok"/>');
  });
});

// ═════════════════════════════════════════════════════════════════════
// XML parser
// ═════════════════════════════════════════════════════════════════════

describe('parseXml()', () => {
  it('parses simple element', () => {
    const doc = sheet._parseXml('<root><child>text</child></root>');
    assert.equal(doc.tag, 'root');
    assert.equal(doc.children.length, 1);
    assert.equal(doc.children[0].tag, 'child');
    assert.equal(doc.children[0].text, 'text');
  });

  it('parses attributes', () => {
    const doc = sheet._parseXml('<c r="A1" t="s"/>');
    assert.equal(doc.tag, 'c');
    assert.equal(doc.attrs.r, 'A1');
    assert.equal(doc.attrs.t, 's');
  });

  it('strips namespace prefixes', () => {
    const doc = sheet._parseXml('<x:row r:id="rId1"><x:c>val</x:c></x:row>');
    assert.equal(doc.tag, 'row');
    assert.equal(doc.attrs.id, 'rId1');
    assert.equal(doc.children[0].tag, 'c');
  });

  it('handles XML declaration', () => {
    const doc = sheet._parseXml('<?xml version="1.0"?><root/>');
    assert.equal(doc.tag, 'root');
  });

  it('unescapes entities in attributes', () => {
    const doc = sheet._parseXml('<t val="a&amp;b&lt;c"/>');
    assert.equal(doc.attrs.val, 'a&b<c');
  });

  it('handles nested structure', () => {
    const xml = '<a><b><c>deep</c></b><d>sibling</d></a>';
    const doc = sheet._parseXml(xml);
    assert.equal(doc.children.length, 2);
    assert.equal(sheet._find(doc, 'c').text, 'deep');
    assert.equal(sheet._find(doc, 'd').text, 'sibling');
  });

  it('findAll collects all matching nodes', () => {
    const xml = '<root><item>1</item><sub><item>2</item></sub></root>';
    const doc = sheet._parseXml(xml);
    const items = sheet._findAll(doc, 'item');
    assert.equal(items.length, 2);
    assert.equal(items[0].text, '1');
    assert.equal(items[1].text, '2');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Utilities
// ═════════════════════════════════════════════════════════════════════

describe('colLetter / colIndex', () => {
  it('A=0, Z=25, AA=26', () => {
    assert.equal(sheet.colLetter(0), 'A');
    assert.equal(sheet.colLetter(25), 'Z');
    assert.equal(sheet.colLetter(26), 'AA');
    assert.equal(sheet.colLetter(27), 'AB');
    assert.equal(sheet.colLetter(701), 'ZZ');
  });

  it('reverse: colIndex', () => {
    assert.equal(sheet.colIndex('A'), 0);
    assert.equal(sheet.colIndex('Z'), 25);
    assert.equal(sheet.colIndex('AA'), 26);
    assert.equal(sheet.colIndex('AB'), 27);
    assert.equal(sheet.colIndex('ZZ'), 701);
  });

  it('round-trips', () => {
    for (let i = 0; i < 100; i++) {
      assert.equal(sheet.colIndex(sheet.colLetter(i)), i);
    }
  });
});

describe('cellRef / parseRef', () => {
  it('cellRef(0, 0) = "A1"', () => {
    assert.equal(sheet.cellRef(0, 0), 'A1');
  });

  it('cellRef(2, 3) = "C4"', () => {
    assert.equal(sheet.cellRef(2, 3), 'C4');
  });

  it('absolute ref', () => {
    assert.equal(sheet.cellRef(1, 2, true), '$B$3');
  });

  it('parseRef', () => {
    assert.deepEqual(sheet.parseRef('B3'), { col: 1, row: 2 });
    assert.deepEqual(sheet.parseRef('$B$3'), { col: 1, row: 2 });
    assert.deepEqual(sheet.parseRef('AA1'), { col: 26, row: 0 });
  });

  it('round-trips', () => {
    for (let c = 0; c < 50; c++) {
      for (let r = 0; r < 10; r++) {
        const ref = sheet.cellRef(c, r);
        const parsed = sheet.parseRef(ref);
        assert.equal(parsed.col, c);
        assert.equal(parsed.row, r);
      }
    }
  });
});

describe('dateToSerial / serialToDate', () => {
  it('Jan 1, 1900 = serial 1', () => {
    assert.equal(sheet.dateToSerial(new Date(1900, 0, 1)), 1);
  });

  it('Feb 28, 1900 = serial 59', () => {
    assert.equal(sheet.dateToSerial(new Date(1900, 1, 28)), 59);
  });

  it('Mar 1, 1900 = serial 61 (skips fake Feb 29)', () => {
    assert.equal(sheet.dateToSerial(new Date(1900, 2, 1)), 61);
  });

  it('Jan 1, 2025 = serial 45658', () => {
    // known value from Excel
    assert.equal(sheet.dateToSerial(new Date(2025, 0, 1)), 45658);
  });

  it('serialToDate reverses dateToSerial', () => {
    const dates = [
      new Date(1900, 0, 1), new Date(1950, 5, 15),
      new Date(2000, 0, 1), new Date(2025, 2, 3),
    ];
    for (const d of dates) {
      const serial = sheet.dateToSerial(d);
      const back = sheet.serialToDate(serial);
      assert.equal(back.getUTCFullYear(), d.getFullYear());
      assert.equal(back.getUTCMonth(), d.getMonth());
      assert.equal(back.getUTCDate(), d.getDate());
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// Writer → Reader round-trip
// ═════════════════════════════════════════════════════════════════════

describe('write → read round-trip', () => {
  it('simple string + number columns', async () => {
    const wb = {
      sheets: [{
        name: 'Test',
        columns: {
          Name: ['Alice', 'Bob', 'Carol'],
          Score: [95, 87, 92],
        }
      }]
    };

    const bytes = await sheet.write(wb);
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);

    const result = await sheet.read(bytes);
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0].name, 'Test');
    assert.deepEqual(result.sheets[0].headers, ['Name', 'Score']);
    assert.equal(result.sheets[0].rows, 3);

    // string column
    const names = result.sheets[0].columns.Name;
    assert.ok(Array.isArray(names));
    assert.deepEqual(names, ['Alice', 'Bob', 'Carol']);

    // number column
    const scores = result.sheets[0].columns.Score;
    assert.ok(scores instanceof Float64Array);
    assert.equal(scores[0], 95);
    assert.equal(scores[1], 87);
    assert.equal(scores[2], 92);
  });

  it('boolean column', async () => {
    const wb = {
      sheets: [{
        name: 'Bools',
        columns: {
          Flag: [true, false, true],
        }
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    const flags = result.sheets[0].columns.Flag;
    assert.ok(flags instanceof Uint8Array);
    assert.equal(flags[0], 1);
    assert.equal(flags[1], 0);
    assert.equal(flags[2], 1);
  });

  it('multiple sheets', async () => {
    const wb = {
      sheets: [
        { name: 'Sheet1', columns: { A: [1, 2] } },
        { name: 'Sheet2', columns: { B: ['x', 'y'] } },
      ]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    assert.equal(result.sheets.length, 2);
    assert.equal(result.sheets[0].name, 'Sheet1');
    assert.equal(result.sheets[1].name, 'Sheet2');
    assert.ok(result.sheets[0].columns.A instanceof Float64Array);
    assert.deepEqual(result.sheets[1].columns.B, ['x', 'y']);
  });

  it('columns with formulas preserve values', async () => {
    const wb = {
      sheets: [{
        name: 'Formulas',
        columns: {
          Price: [10, 20],
          Tax: {
            values: [1.5, 3.0],
            formulas: ['=A2*0.15', '=A3*0.15'],
          },
        }
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    const tax = result.sheets[0].columns.Tax;
    assert.ok(tax instanceof Float64Array);
    assert.equal(tax[0], 1.5);
    assert.equal(tax[1], 3.0);
  });

  it('shared formula', async () => {
    const wb = {
      sheets: [{
        name: 'Shared',
        columns: {
          Base: [100, 200, 300],
          Doubled: {
            values: [200, 400, 600],
            sharedFormula: { base: '=A2*2', ref: 'B2:B4' },
          },
        }
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    const doubled = result.sheets[0].columns.Doubled;
    assert.ok(doubled instanceof Float64Array);
    assert.equal(doubled[0], 200);
    assert.equal(doubled[1], 400);
    assert.equal(doubled[2], 600);
  });

  it('empty workbook', async () => {
    const wb = { sheets: [{ name: 'Empty', columns: {} }] };
    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0].rows, 0);
  });

  it('shared strings deduplication', async () => {
    const wb = {
      sheets: [{
        name: 'Dedup',
        columns: {
          Color: ['red', 'blue', 'red', 'blue', 'red'],
        }
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    assert.deepEqual(result.sheets[0].columns.Color, ['red', 'blue', 'red', 'blue', 'red']);
  });

  it('typed array input', async () => {
    const wb = {
      sheets: [{
        name: 'Typed',
        columns: {
          Values: Float64Array.of(1.5, 2.5, 3.5),
        }
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    const vals = result.sheets[0].columns.Values;
    assert.ok(vals instanceof Float64Array);
    assert.equal(vals[0], 1.5);
    assert.equal(vals[1], 2.5);
    assert.equal(vals[2], 3.5);
  });

  it('filter by sheet name', async () => {
    const wb = {
      sheets: [
        { name: 'Keep', columns: { X: [1] } },
        { name: 'Skip', columns: { Y: [2] } },
      ]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes, { sheet: 'Keep' });
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0].name, 'Keep');
  });

  it('defined names are written', async () => {
    const wb = {
      sheets: [{ name: 'S1', columns: { A: [1] } }],
      definedNames: [{ name: 'myRange', formula: 'S1!$A$1' }],
    };

    // just verify it doesn't crash and produces valid xlsx
    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    assert.equal(result.sheets.length, 1);
  });
});

describe('write with tables', () => {
  it('table produces valid xlsx', async () => {
    const wb = {
      sheets: [{
        name: 'Data',
        columns: {
          Name: ['Alice', 'Bob'],
          Score: [95, 87],
        },
        tables: [{ ref: 'A1:B3', name: 'DataTable' }],
      }]
    };

    const bytes = await sheet.write(wb);
    const result = await sheet.read(bytes);
    assert.equal(result.sheets[0].rows, 2);
    assert.deepEqual(result.sheets[0].columns.Name, ['Alice', 'Bob']);
  });
});

// ═════════════════════════════════════════════════════════════════════
// table-document adapter (census + openSheet)
// ═════════════════════════════════════════════════════════════════════

describe('census / openSheet', () => {
  const CUTOFFS = {
    sheets: [
      { name: 'Cutoffs', columns: { DOMAIN: ['HEM', 'ITA', 'WASTE'], CUTOFF: [55, 50, 0], PRICE: [105.5, 98, 0] } },
      { name: 'Notes', columns: { NOTE: ['nothing here'] } },
    ],
  };

  it('census names every sheet with its size', async () => {
    const c = await sheet.census(await sheet.write(CUTOFFS));
    assert.equal(c.sheets.length, 2);
    assert.equal(c.sheets[0].name, 'Cutoffs');
    assert.equal(c.sheets[0].rows, 3);
    assert.equal(c.sheets[0].columns, 3);
    assert.deepEqual(c.sheets[0].headers, ['DOMAIN', 'CUTOFF', 'PRICE']);
    assert.equal(c.sheets[1].name, 'Notes');
    assert.equal(c.sheets[1].rows, 1);
  });

  it('a worksheet IS a table document — types from Excel, no CSV round-trip', async () => {
    const doc = await sheet.openSheet(await sheet.write(CUTOFFS), { sheet: 'Cutoffs' });
    assert.equal(doc.header.table, true);
    assert.equal(doc.header.sheet, 'Cutoffs');
    assert.equal(doc.header.count, 3);
    assert.deepEqual(doc.header.columns, ['DOMAIN', 'CUTOFF', 'PRICE']);
    assert.equal(doc.header.mapping, null);                // a workbook is not a coordinate system
    // numeric because EXCEL said so — never because a string happened to parse
    assert.deepEqual(doc.header.numericColumns.map((c) => c.name), ['CUTOFF', 'PRICE']);
    assert.deepEqual(doc.at(0), ['HEM', 55, 105.5]);
    assert.equal(typeof doc.at(0)[2], 'number');
  });

  it('batched rows stream like any other table', async () => {
    const names = [], vals = [];
    for (let i = 0; i < 10; i++) { names.push(`r${i}`); vals.push(i); }
    const doc = await sheet.openSheet(await sheet.write({ sheets: [{ name: 'S', columns: { A: names, B: vals } }] }));
    const seen = [];
    for await (const batch of doc.rows({ batch: 4 })) seen.push(batch.length);
    assert.deepEqual(seen, [4, 4, 2]);
    assert.equal(doc.header.count, 10);
  });

  it('a named sheet that is not there fails loudly', async () => {
    const wb = await sheet.write({ sheets: [{ name: 'Only', columns: { A: [1] } }] });
    await assert.rejects(() => sheet.openSheet(wb, { sheet: 'Missing' }), /not found/);
  });
});
