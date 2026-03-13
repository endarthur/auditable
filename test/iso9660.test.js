import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { writeBoth16, writeBoth32, readBoth16, readBoth32 } = await import('../ext/iso9660/src/both.js');
const { encodeUCS2, decodeUCS2 } = await import('../ext/iso9660/src/ucs2.js');
const { encodeRecordingDate, decodeRecordingDate, encodeDecimalDate, decodeDecimalDate } = await import('../ext/iso9660/src/dates.js');
const { dirRecordLength, encodeBaseIdentifier, encodeJolietIdentifier } = await import('../ext/iso9660/src/dir-record.js');
const { encodePathTable, decodePathTable } = await import('../ext/iso9660/src/path-table.js');
const { encodePVD, decodeVolumeDescriptor } = await import('../ext/iso9660/src/pvd.js');
const { ISOWriter } = await import('../ext/iso9660/src/writer.js');
const { ISOReader } = await import('../ext/iso9660/src/reader.js');

describe('iso9660: both-endian encoding', () => {
  it('uint16 round-trip', () => {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    writeBoth16(view, 0, 0x1234);
    assert.equal(readBoth16(view, 0), 0x1234);
    // Verify LE then BE layout
    assert.equal(view.getUint16(0, true), 0x1234);
    assert.equal(view.getUint16(2, false), 0x1234);
  });

  it('uint32 round-trip', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    writeBoth32(view, 0, 0xDEADBEEF);
    assert.equal(readBoth32(view, 0), 0xDEADBEEF);
    assert.equal(view.getUint32(0, true), 0xDEADBEEF);
    assert.equal(view.getUint32(4, false), 0xDEADBEEF);
  });
});

describe('iso9660: UCS-2 encoding', () => {
  it('ASCII round-trip', () => {
    const encoded = encodeUCS2('hello');
    assert.equal(encoded.length, 10); // 5 chars × 2 bytes
    assert.equal(decodeUCS2(encoded, 0, encoded.length), 'hello');
  });

  it('non-ASCII round-trip', () => {
    const s = '\u00e9\u00e8\u00ea'; // éèê
    const encoded = encodeUCS2(s);
    assert.equal(decodeUCS2(encoded, 0, encoded.length), s);
  });

  it('truncation', () => {
    const encoded = encodeUCS2('hello world', 6); // max 6 bytes = 3 chars
    assert.equal(encoded.length, 6);
    assert.equal(decodeUCS2(encoded, 0, encoded.length), 'hel');
  });
});

describe('iso9660: date encoding', () => {
  it('recording date round-trip', () => {
    const d = new Date(2026, 2, 13, 14, 30, 45); // March 13, 2026
    const encoded = encodeRecordingDate(d);
    assert.equal(encoded.length, 7);
    assert.equal(encoded[0], 126); // 2026 - 1900
    assert.equal(encoded[1], 3);   // March
    assert.equal(encoded[2], 13);
    const decoded = decodeRecordingDate(encoded, 0);
    // Allow timezone differences — compare UTC components
    assert.equal(decoded.getUTCFullYear(), d.getUTCFullYear());
    assert.equal(decoded.getUTCMonth(), d.getUTCMonth());
    assert.equal(decoded.getUTCDate(), d.getUTCDate());
  });

  it('decimal date round-trip', () => {
    const d = new Date(2026, 2, 13, 14, 30, 45);
    const encoded = encodeDecimalDate(d);
    assert.equal(encoded.length, 17);
    const decoded = decodeDecimalDate(encoded, 0);
    assert.equal(decoded.getUTCFullYear(), d.getUTCFullYear());
    assert.equal(decoded.getUTCMonth(), d.getUTCMonth());
  });
});

describe('iso9660: directory record', () => {
  it('base identifier uppercase and ;1 suffix', () => {
    const ident = encodeBaseIdentifier('readme.txt', false);
    const name = String.fromCharCode(...ident);
    assert.equal(name, 'README.TXT;1');
  });

  it('base directory identifier no ;1', () => {
    const ident = encodeBaseIdentifier('mydir', true);
    const name = String.fromCharCode(...ident);
    assert.equal(name, 'MYDIR');
  });

  it('joliet identifier preserves case', () => {
    const ident = encodeJolietIdentifier('ReadMe.txt', false);
    const name = decodeUCS2(ident, 0, ident.length);
    assert.equal(name, 'ReadMe.txt;1');
  });

  it('record length calculation', () => {
    // Identifier length 1 (dot/dotdot): 33 + 1 = 34 (even, +1 pad = but wait, 34 is even total, need pad)
    // Actually: base = 33 + 1 = 34. 34 % 2 === 0, so +1 pad. But that breaks the standard...
    // Let me check: record length must be even. 34 is even, so no pad needed.
    // The padding rule: base = 33 + N. If base is even, pad 1 byte. So 33+1=34, even, pad to 35? No.
    // ISO 9660: padding byte exists if file identifier length is even (because 33 is odd, + even N = odd total, needs padding to be even)
    // Wait: 33 + N. If N is even: 33 + N is odd, add 1 pad. If N is odd: 33 + N is even, no pad.
    assert.equal(dirRecordLength(1), 34); // 33 + 1 = 34, even, no pad
    assert.equal(dirRecordLength(2), 36); // 33 + 2 = 35, odd, +1 = 36
    assert.equal(dirRecordLength(11), 44); // 33 + 11 = 44, even, no pad
    assert.equal(dirRecordLength(12), 46); // 33 + 12 = 45, odd, +1 = 46
  });
});

describe('iso9660: path table', () => {
  it('encode/decode round-trip', () => {
    const dirs = [
      { nameBytes: new Uint8Array([0]), extentLBA: 19, parentIndex: 1 },
      { nameBytes: new Uint8Array([0x44, 0x41, 0x54, 0x41]), extentLBA: 20, parentIndex: 1 }, // "DATA"
    ];
    const encoded = encodePathTable(dirs, 'le');
    const decoded = decodePathTable(encoded, 0, encoded.length, 'le');
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].name, '\x00'); // root
    assert.equal(decoded[0].extentLBA, 19);
    assert.equal(decoded[1].name, 'DATA');
    assert.equal(decoded[1].extentLBA, 20);
    assert.equal(decoded[1].parentIndex, 1);
  });
});

describe('iso9660: PVD', () => {
  it('encode/decode round-trip', () => {
    const rootRec = new Uint8Array(34);
    rootRec[0] = 34; // record length

    const pvd = encodePVD({
      volumeId: 'TEST_VOLUME',
      publisher: 'GCU',
      volumeSpaceSize: 100,
      pathTableSize: 10,
      pathTableLBA_LE: 19,
      pathTableLBA_BE: 20,
      rootRecord: rootRec,
    });

    // Wrap in a buffer at sector 16
    const buf = new Uint8Array(17 * 2048);
    buf.set(pvd, 16 * 2048);

    const vd = decodeVolumeDescriptor(buf, 16);
    assert.equal(vd.type, 0x01);
    assert.equal(vd.volumeId, 'TEST_VOLUME');
    assert.equal(vd.publisher, 'GCU');
    assert.equal(vd.volumeSpaceSize, 100);
  });
});

describe('iso9660: writer + reader round-trip', () => {
  it('single file', () => {
    const iso = new ISOWriter({ volumeId: 'SINGLE', joliet: false });
    const content = new TextEncoder().encode('hello world');
    iso.add('readme.txt', content);

    const bytes = iso.toUint8Array();
    const reader = new ISOReader(bytes.buffer);

    assert.equal(reader.volumeId, 'SINGLE');
    const files = reader.list();
    assert.equal(files.length, 1);
    assert.equal(files[0], '/README.TXT');

    const data = reader.read('/README.TXT');
    assert.equal(new TextDecoder().decode(data), 'hello world');
  });

  it('multiple files in root', () => {
    const iso = new ISOWriter({ volumeId: 'MULTI', joliet: false });
    iso.add('a.txt', new TextEncoder().encode('aaa'));
    iso.add('b.txt', new TextEncoder().encode('bbb'));
    iso.add('c.txt', new TextEncoder().encode('ccc'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const files = reader.list().sort();
    assert.equal(files.length, 3);
    assert.equal(reader.readText('/A.TXT'), 'aaa');
    assert.equal(reader.readText('/B.TXT'), 'bbb');
    assert.equal(reader.readText('/C.TXT'), 'ccc');
  });

  it('nested directories', () => {
    const iso = new ISOWriter({ volumeId: 'NESTED', joliet: false });
    iso.add('dir1/file1.txt', new TextEncoder().encode('f1'));
    iso.add('dir1/dir2/file2.txt', new TextEncoder().encode('f2'));
    iso.add('root.txt', new TextEncoder().encode('root'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const files = reader.list().sort();
    assert.equal(files.length, 3);
    assert.ok(files.includes('/ROOT.TXT'));
    assert.ok(files.includes('/DIR1/FILE1.TXT'));
    assert.ok(files.includes('/DIR1/DIR2/FILE2.TXT'));

    assert.equal(reader.readText('/DIR1/DIR2/FILE2.TXT'), 'f2');
  });

  it('empty file', () => {
    const iso = new ISOWriter({ volumeId: 'EMPTY', joliet: false });
    iso.add('empty.dat', new Uint8Array(0));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const files = reader.list();
    assert.equal(files.length, 1);
    const data = reader.read('/EMPTY.DAT');
    assert.equal(data.length, 0);
  });

  it('large file spanning multiple sectors', () => {
    const iso = new ISOWriter({ volumeId: 'LARGE', joliet: false });
    const big = new Uint8Array(5000); // > 2 sectors
    for (let i = 0; i < big.length; i++) big[i] = i & 0xFF;
    iso.add('big.bin', big);

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const data = reader.read('/BIG.BIN');
    assert.equal(data.length, 5000);
    for (let i = 0; i < data.length; i++) {
      assert.equal(data[i], i & 0xFF, `byte ${i}`);
    }
  });

  it('readdir lists directory contents', () => {
    const iso = new ISOWriter({ volumeId: 'READDIR', joliet: false });
    iso.add('a.txt', new TextEncoder().encode('a'));
    iso.add('sub/b.txt', new TextEncoder().encode('b'));
    iso.add('sub/c.txt', new TextEncoder().encode('c'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const root = reader.readdir('/');
    assert.ok(root.some(e => e.name === 'A.TXT' && !e.isDir));
    assert.ok(root.some(e => e.name === 'SUB' && e.isDir));

    const sub = reader.readdir('/SUB');
    assert.equal(sub.length, 2);
    assert.ok(sub.some(e => e.name === 'B.TXT'));
    assert.ok(sub.some(e => e.name === 'C.TXT'));
  });

  it('stat mode returns metadata', () => {
    const iso = new ISOWriter({ volumeId: 'STAT' });
    iso.add('test.txt', new TextEncoder().encode('hello'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    const files = reader.list({ stat: true });
    assert.equal(files.length, 1);
    assert.equal(files[0].size, 5);
    assert.ok(files[0].date instanceof Date);
    assert.equal(files[0].isDir, false);
  });
});

describe('iso9660: Joliet support', () => {
  it('preserves case and long filenames', () => {
    const iso = new ISOWriter({ volumeId: 'JOLIET', joliet: true });
    iso.add('MyDocument.txt', new TextEncoder().encode('content'));
    iso.add('Data/Results.csv', new TextEncoder().encode('csv'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    assert.equal(reader.joliet, true);

    // Joliet tree should preserve case
    const files = reader.list().sort();
    assert.equal(files.length, 2);
    assert.ok(files.includes('/Data/Results.csv'));
    assert.ok(files.includes('/MyDocument.txt'));

    // Base tree should be uppercase
    const baseFiles = reader.list({ joliet: false }).sort();
    assert.ok(baseFiles.includes('/DATA/RESULTS.CSV'));
    assert.ok(baseFiles.includes('/MYDOCUMENT.TXT'));
  });
});

describe('iso9660: volume metadata', () => {
  it('round-trips volume identifiers', () => {
    const iso = new ISOWriter({
      volumeId: 'MY_ARCHIVE',
      publisher: 'GCU Press',
      preparer: 'Auditable',
      application: 'iso9660.js',
    });
    iso.add('test.txt', new TextEncoder().encode('x'));

    const reader = new ISOReader(iso.toUint8Array().buffer);
    assert.equal(reader.volumeId, 'MY_ARCHIVE');
    assert.equal(reader.publisher, 'GCU Press');
    assert.equal(reader.preparer, 'Auditable');
    assert.equal(reader.application, 'iso9660.js');
  });
});

describe('iso9660: greeting', () => {
  it('writes greeting in system area', () => {
    const iso = new ISOWriter({ greeting: true, joliet: false });
    iso.add('a.txt', new TextEncoder().encode('a'));
    const bytes = iso.toUint8Array();

    const greeting = '<!-- good luck out there -->';
    const greetOff = 16 * 2048 - greeting.length;
    const found = new TextDecoder().decode(bytes.slice(greetOff, greetOff + greeting.length));
    assert.equal(found, greeting);
  });

  it('no greeting when disabled', () => {
    const iso = new ISOWriter({ greeting: false, joliet: false });
    iso.add('a.txt', new TextEncoder().encode('a'));
    const bytes = iso.toUint8Array();

    // System area should be all zeros
    for (let i = 0; i < 16 * 2048; i++) {
      assert.equal(bytes[i], 0, `byte ${i} should be 0`);
    }
  });
});

describe('iso9660: validation', () => {
  it('rejects duplicate paths', () => {
    const iso = new ISOWriter({ joliet: false });
    iso.add('test.txt', new TextEncoder().encode('a'));
    iso.add('test.txt', new TextEncoder().encode('b'));
    assert.throws(() => iso.toUint8Array(), /Duplicate path/);
  });

  it('rejects depth > 8', () => {
    const iso = new ISOWriter({ joliet: false });
    iso.add('a/b/c/d/e/f/g/h/i/file.txt', new TextEncoder().encode('deep')); // 9 levels
    assert.throws(() => iso.toUint8Array(), /depth/i);
  });
});
