// ISO9660.js — Browser-native ISO 9660 Reader/Writer
// Auto-generated from ext/iso9660/src/ — do not edit directly

// -- constants.js --

// ISO 9660 constants

const SECTOR_SIZE = 2048;

// Volume descriptor types
const VD_PRIMARY = 0x01;
const VD_SUPPLEMENTARY = 0x02;
const VD_TERMINATOR = 0xFF;

// Magic identifier
const CD001 = new Uint8Array([0x43, 0x44, 0x30, 0x30, 0x31]); // "CD001"

// File flags
const FLAG_DIRECTORY = 0x02;

// Joliet escape sequence (UCS-2 Level 3, full BMP)
const JOLIET_ESC = new Uint8Array([0x25, 0x2F, 0x45]); // "%/E"

// GCU greeting
const GREETING = '<!-- good luck out there -->';

// -- both.js --

// Both-endian (LE + BE) encoding for ISO 9660 multi-byte integers

function writeBoth16(view, offset, value) {
  view.setUint16(offset, value, true);      // LE
  view.setUint16(offset + 2, value, false); // BE
}

function writeBoth32(view, offset, value) {
  view.setUint32(offset, value, true);      // LE
  view.setUint32(offset + 4, value, false); // BE
}

function readBoth16(view, offset) {
  return view.getUint16(offset, true); // read LE half
}

function readBoth32(view, offset) {
  return view.getUint32(offset, true); // read LE half
}

// -- ucs2.js --

// UCS-2 Big Endian encode/decode for Joliet filenames

function encodeUCS2(str, maxBytes) {
  const max = maxBytes != null ? maxBytes : str.length * 2;
  const chars = Math.min(str.length, max >> 1);
  const buf = new Uint8Array(chars * 2);
  for (let i = 0; i < chars; i++) {
    const c = str.charCodeAt(i);
    buf[i * 2] = (c >> 8) & 0xFF;
    buf[i * 2 + 1] = c & 0xFF;
  }
  return buf;
}

function decodeUCS2(buf, offset, length) {
  let str = '';
  for (let i = 0; i < length; i += 2) {
    const c = (buf[offset + i] << 8) | buf[offset + i + 1];
    if (c === 0) break;
    str += String.fromCharCode(c);
  }
  return str;
}

// Pad a UCS-2 encoded string into a fixed-size field (for PVD/SVD string fields)
function writeUCS2Padded(target, offset, str, fieldLen) {
  const encoded = encodeUCS2(str, fieldLen);
  target.set(encoded, offset);
  // Pad remaining bytes with 0x00
  for (let i = encoded.length; i < fieldLen; i++) target[offset + i] = 0;
}

// -- dates.js --

// ISO 9660 date/time encoding and decoding

// 7-byte recording date (used in directory records)
// [years-since-1900, month, day, hour, minute, second, GMT-offset-in-15min]
function encodeRecordingDate(date) {
  const buf = new Uint8Array(7);
  buf[0] = date.getFullYear() - 1900;
  buf[1] = date.getMonth() + 1;
  buf[2] = date.getDate();
  buf[3] = date.getHours();
  buf[4] = date.getMinutes();
  buf[5] = date.getSeconds();
  buf[6] = -(date.getTimezoneOffset() / 15) & 0xFF; // signed byte
  return buf;
}

function decodeRecordingDate(buf, offset) {
  const year = buf[offset] + 1900;
  const month = buf[offset + 1] - 1;
  const day = buf[offset + 2];
  const hour = buf[offset + 3];
  const min = buf[offset + 4];
  const sec = buf[offset + 5];
  // GMT offset in 15-min increments, signed
  const gmtOff = (buf[offset + 6] << 24) >> 24; // sign-extend
  const d = new Date(Date.UTC(year, month, day, hour, min, sec));
  d.setMinutes(d.getMinutes() - gmtOff * 15);
  return d;
}

// 17-byte decimal date (used in PVD/SVD)
// ASCII: "YYYYMMDDHHMMSScc" + 1 byte GMT offset
function encodeDecimalDate(date) {
  const buf = new Uint8Array(17);
  const s = date.getFullYear().toString().padStart(4, '0')
    + (date.getMonth() + 1).toString().padStart(2, '0')
    + date.getDate().toString().padStart(2, '0')
    + date.getHours().toString().padStart(2, '0')
    + date.getMinutes().toString().padStart(2, '0')
    + date.getSeconds().toString().padStart(2, '0')
    + '00'; // centiseconds
  for (let i = 0; i < 16; i++) buf[i] = s.charCodeAt(i);
  buf[16] = -(date.getTimezoneOffset() / 15) & 0xFF;
  return buf;
}

function decodeDecimalDate(buf, offset) {
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(buf[offset + i]);
  if (s.trim() === '' || s[0] === '0' && s[1] === '0' && s[2] === '0' && s[3] === '0') return null;
  const year = parseInt(s.substring(0, 4));
  const month = parseInt(s.substring(4, 6)) - 1;
  const day = parseInt(s.substring(6, 8));
  const hour = parseInt(s.substring(8, 10));
  const min = parseInt(s.substring(10, 12));
  const sec = parseInt(s.substring(12, 14));
  const gmtOff = (buf[offset + 16] << 24) >> 24;
  const d = new Date(Date.UTC(year, month, day, hour, min, sec));
  d.setMinutes(d.getMinutes() - gmtOff * 15);
  return d;
}

// Zero-filled 17-byte date (for unused date fields)
function zeroDecimalDate() {
  return new Uint8Array(17);
}

// -- path-table.js --

// ISO 9660 path table encode/decode


// Encode a path table from an array of directory entries
// dirs: [{ name, extentLBA, parentIndex }] — parentIndex is 1-based
// endianness: 'le' or 'be'
function encodePathTable(dirs, endianness) {
  const isLE = endianness === 'le';

  // Compute total size first
  let totalSize = 0;
  for (const dir of dirs) {
    const nameBytes = dir.nameBytes || new Uint8Array(dir.name === '\x00' ? [0] : Array.from(dir.name, c => c.charCodeAt(0)));
    const n = nameBytes.length;
    totalSize += 8 + n + (n % 2); // 8 fixed + name + padding
  }

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  for (const dir of dirs) {
    const nameBytes = dir.nameBytes || new Uint8Array(dir.name === '\x00' ? [0] : Array.from(dir.name, c => c.charCodeAt(0)));
    const n = nameBytes.length;

    buf[offset] = n;     // Directory Identifier Length
    buf[offset + 1] = 0; // Extended Attribute Record Length

    if (isLE) {
      view.setUint32(offset + 2, dir.extentLBA, true);
      view.setUint16(offset + 6, dir.parentIndex, true);
    } else {
      view.setUint32(offset + 2, dir.extentLBA, false);
      view.setUint16(offset + 6, dir.parentIndex, false);
    }

    buf.set(nameBytes, offset + 8);
    offset += 8 + n + (n % 2);
  }

  return buf;
}

// Decode a path table
function decodePathTable(buf, offset, size, endianness) {
  const isLE = endianness === 'le';
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dirs = [];
  let pos = 0;

  while (pos < size) {
    const n = buf[offset + pos];
    if (n === 0) break;
    const extentLBA = isLE
      ? view.getUint32(offset + pos + 2, true)
      : view.getUint32(offset + pos + 2, false);
    const parentIndex = isLE
      ? view.getUint16(offset + pos + 6, true)
      : view.getUint16(offset + pos + 6, false);

    let name;
    if (n === 1 && buf[offset + pos + 8] === 0) {
      name = '\x00'; // root
    } else {
      name = '';
      for (let i = 0; i < n; i++) name += String.fromCharCode(buf[offset + pos + 8 + i]);
    }

    dirs.push({ name, extentLBA, parentIndex });
    pos += 8 + n + (n % 2);
  }

  return dirs;
}

// -- dir-record.js --

// ISO 9660 directory record encode/decode





// Compute the length of a directory record given the identifier
function dirRecordLength(identLen) {
  // Fixed fields: 33 bytes + identifier + padding if even-length identifier
  const base = 33 + identLen;
  return base + (base % 2 === 1 ? 1 : 0); // pad to even total
}

// Encode a directory record into a buffer at the given offset
// Returns the number of bytes written
function encodeDirRecord(buf, offset, opts) {
  const { extentLBA, dataLen, date, isDir, identifier } = opts;
  // identifier: Uint8Array (already encoded — ASCII or UCS-2)
  const identLen = identifier.length;
  const recLen = dirRecordLength(identLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf[offset] = recLen;                              // Record length
  buf[offset + 1] = 0;                               // Extended attribute record length
  writeBoth32(view, offset + 2, extentLBA);           // Extent location
  writeBoth32(view, offset + 10, dataLen);            // Data length
  const dateBytes = encodeRecordingDate(date || new Date());
  buf.set(dateBytes, offset + 18);                    // Recording date
  buf[offset + 25] = isDir ? FLAG_DIRECTORY : 0;      // File flags
  buf[offset + 26] = 0;                               // File unit size
  buf[offset + 27] = 0;                               // Interleave gap size
  writeBoth16(view, offset + 28, 1);                  // Volume sequence number
  buf[offset + 32] = identLen;                        // File identifier length
  buf.set(identifier, offset + 33);                   // File identifier

  return recLen;
}

// Encode the dot (self) entry
function encodeDotRecord(buf, offset, extentLBA, dataLen, date) {
  return encodeDirRecord(buf, offset, {
    extentLBA, dataLen, date, isDir: true,
    identifier: new Uint8Array([0x00]),
  });
}

// Encode the dotdot (parent) entry
function encodeDotDotRecord(buf, offset, parentLBA, parentDataLen, date) {
  return encodeDirRecord(buf, offset, {
    extentLBA: parentLBA, dataLen: parentDataLen, date, isDir: true,
    identifier: new Uint8Array([0x01]),
  });
}

// Encode a filename for the base (ISO 9660 Level 2) tree
// Uppercase, max 31 chars, invalid chars replaced with _, ;1 suffix for files
function encodeBaseIdentifier(name, isDir) {
  let base = name.toUpperCase().replace(/[^A-Z0-9_.\-]/g, '_');
  if (isDir) {
    base = base.substring(0, 31);
  } else {
    base = base.substring(0, 29) + ';1'; // leave room for ;1
    if (base.length > 31) base = base.substring(0, 31);
  }
  const buf = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) buf[i] = base.charCodeAt(i);
  return buf;
}

// Encode a filename for the Joliet tree (UCS-2 BE, max 64 chars)
function encodeJolietIdentifier(name, isDir) {
  let s = isDir ? name.substring(0, 64) : name.substring(0, 62) + ';1';
  if (s.length > 64) s = s.substring(0, 64);
  return encodeUCS2(s);
}

// Decode a single directory record from buffer
function decodeDirRecord(buf, offset, isJoliet) {
  const recLen = buf[offset];
  if (recLen === 0) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const extentLBA = readBoth32(view, offset + 2);
  const dataLen = readBoth32(view, offset + 10);
  const date = decodeRecordingDate(buf, offset + 18);
  const flags = buf[offset + 25];
  const isDir = (flags & FLAG_DIRECTORY) !== 0;
  const identLen = buf[offset + 32];

  let name;
  if (identLen === 1 && buf[offset + 33] === 0x00) {
    name = '.';
  } else if (identLen === 1 && buf[offset + 33] === 0x01) {
    name = '..';
  } else if (isJoliet) {
    name = decodeUCS2(buf, offset + 33, identLen);
  } else {
    name = '';
    for (let i = 0; i < identLen; i++) name += String.fromCharCode(buf[offset + 33 + i]);
  }

  // Strip ;1 version suffix
  if (name.endsWith(';1')) name = name.substring(0, name.length - 2);

  return { name, extentLBA, dataLen, date, isDir, recordLen: recLen };
}

// Decode all directory records in a directory extent (may span multiple sectors)
function decodeDirExtent(buf, extentOffset, sectorCount, isJoliet) {
  const entries = [];
  const totalLen = sectorCount * SECTOR_SIZE;
  let pos = 0;

  while (pos < totalLen) {
    // Check if we're at a zero byte — skip to next sector boundary
    if (buf[extentOffset + pos] === 0) {
      const nextSector = (Math.floor(pos / SECTOR_SIZE) + 1) * SECTOR_SIZE;
      if (nextSector >= totalLen) break;
      pos = nextSector;
      continue;
    }

    const rec = decodeDirRecord(buf, extentOffset + pos, isJoliet);
    if (!rec) break;
    entries.push(rec);
    pos += rec.recordLen;
  }

  return entries;
}

// -- pvd.js --

// ISO 9660 Primary/Supplementary Volume Descriptor encode/decode





// Write an ASCII string padded with spaces into a buffer
function writeAsciiPadded(buf, offset, str, len) {
  for (let i = 0; i < len; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) : 0x20; // space-pad
  }
}

// Read an ASCII string from buffer, trim trailing spaces
function readAsciiPadded(buf, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s.trimEnd();
}

// Encode a Primary Volume Descriptor (2048 bytes)
function encodePVD(opts) {
  const buf = new Uint8Array(SECTOR_SIZE);
  const view = new DataView(buf.buffer);

  buf[0] = VD_PRIMARY;
  buf.set(CD001, 1);
  buf[6] = 0x01; // version

  writeAsciiPadded(buf, 8, opts.systemId || '', 32);
  writeAsciiPadded(buf, 40, opts.volumeId || '', 32);
  writeBoth32(view, 80, opts.volumeSpaceSize);
  writeBoth16(view, 120, 1); // volume set size
  writeBoth16(view, 124, 1); // volume sequence number
  writeBoth16(view, 128, SECTOR_SIZE); // logical block size
  writeBoth32(view, 132, opts.pathTableSize);
  view.setUint32(140, opts.pathTableLBA_LE, true);
  view.setUint32(144, 0, true); // optional path table LE
  view.setUint32(148, opts.pathTableLBA_BE, false);
  view.setUint32(152, 0, false); // optional path table BE

  // Root directory record (34 bytes at offset 156)
  if (opts.rootRecord) buf.set(opts.rootRecord, 156);

  writeAsciiPadded(buf, 190, '', 128);  // volume set identifier
  writeAsciiPadded(buf, 318, opts.publisher || '', 128);
  writeAsciiPadded(buf, 446, opts.preparer || '', 128);
  writeAsciiPadded(buf, 574, opts.application || '', 128);
  writeAsciiPadded(buf, 702, '', 37);   // copyright file
  writeAsciiPadded(buf, 739, '', 37);   // abstract file
  writeAsciiPadded(buf, 776, '', 37);   // bibliographic file

  const now = opts.date || new Date();
  buf.set(encodeDecimalDate(now), 813);          // creation
  buf.set(encodeDecimalDate(now), 830);          // modification
  buf.set(zeroDecimalDate(), 847);               // expiration
  buf.set(zeroDecimalDate(), 864);               // effective

  buf[881] = 0x01; // file structure version

  return buf;
}

// Encode a Supplementary Volume Descriptor (Joliet)
function encodeSVD(opts) {
  const buf = new Uint8Array(SECTOR_SIZE);
  const view = new DataView(buf.buffer);

  buf[0] = VD_SUPPLEMENTARY;
  buf.set(CD001, 1);
  buf[6] = 0x01;

  // UCS-2 encoded string fields for Joliet
  writeUCS2Padded(buf, 8, opts.systemId || '', 32);
  writeUCS2Padded(buf, 40, opts.volumeId || '', 32);
  writeBoth32(view, 80, opts.volumeSpaceSize);

  // Escape sequences at bytes 88-119 (32 bytes)
  buf.set(JOLIET_ESC, 88);

  writeBoth16(view, 120, 1);
  writeBoth16(view, 124, 1);
  writeBoth16(view, 128, SECTOR_SIZE);
  writeBoth32(view, 132, opts.pathTableSize);
  view.setUint32(140, opts.pathTableLBA_LE, true);
  view.setUint32(144, 0, true);
  view.setUint32(148, opts.pathTableLBA_BE, false);
  view.setUint32(152, 0, false);

  if (opts.rootRecord) buf.set(opts.rootRecord, 156);

  writeUCS2Padded(buf, 190, '', 128);
  writeUCS2Padded(buf, 318, opts.publisher || '', 128);
  writeUCS2Padded(buf, 446, opts.preparer || '', 128);
  writeUCS2Padded(buf, 574, opts.application || '', 128);
  writeUCS2Padded(buf, 702, '', 37);
  writeUCS2Padded(buf, 739, '', 37);
  writeUCS2Padded(buf, 776, '', 37);

  const now = opts.date || new Date();
  buf.set(encodeDecimalDate(now), 813);
  buf.set(encodeDecimalDate(now), 830);
  buf.set(zeroDecimalDate(), 847);
  buf.set(zeroDecimalDate(), 864);

  buf[881] = 0x01;

  return buf;
}

// Encode a Volume Descriptor Set Terminator
function encodeTerminator() {
  const buf = new Uint8Array(SECTOR_SIZE);
  buf[0] = VD_TERMINATOR;
  buf.set(CD001, 1);
  buf[6] = 0x01;
  return buf;
}

// Decode a volume descriptor from buffer at a sector offset
function decodeVolumeDescriptor(buf, sectorOffset) {
  const off = sectorOffset * SECTOR_SIZE;
  const type = buf[off];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Check magic
  for (let i = 0; i < 5; i++) {
    if (buf[off + 1 + i] !== CD001[i]) return null;
  }

  if (type === VD_TERMINATOR) return { type };

  const isJoliet = type === VD_SUPPLEMENTARY &&
    buf[off + 88] === 0x25 && buf[off + 89] === 0x2F &&
    (buf[off + 90] === 0x40 || buf[off + 90] === 0x43 || buf[off + 90] === 0x45);

  const readStr = isJoliet
    ? (o, len) => decodeUCS2(buf, off + o, len)
    : (o, len) => readAsciiPadded(buf, off + o, len);

  return {
    type,
    isJoliet,
    volumeId: readStr(40, 32),
    volumeSpaceSize: readBoth32(view, off + 80),
    pathTableSize: readBoth32(view, off + 132),
    pathTableLBA_LE: view.getUint32(off + 140, true),
    pathTableLBA_BE: view.getUint32(off + 148, false),
    publisher: readStr(318, 128),
    preparer: readStr(446, 128),
    application: readStr(574, 128),
    creationDate: decodeDecimalDate(buf, off + 813),
    rootExtentLBA: readBoth32(view, off + 156 + 2),
    rootDataLen: readBoth32(view, off + 156 + 10),
  };
}

// -- layout.js --

// ISO 9660 two-pass layout engine
// Pass 1: compute sector assignments for all metadata and file extents
// Pass 2: write bytes (handled by writer.js)



// Build a directory tree from flat file paths
// Returns root node: { name, children: Map<name, node>, files: [{ name, data }], parent }
function buildTree(fileList) {
  const root = { name: '', children: new Map(), files: [], parent: null };

  for (const { path, data } of fileList) {
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length === 0) throw new Error('Empty path');

    let node = root;
    // Create intermediate directories
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      if (!node.children.has(dirName)) {
        const child = { name: dirName, children: new Map(), files: [], parent: node };
        node.children.set(dirName, child);
      }
      node = node.children.get(dirName);
    }

    const fileName = parts[parts.length - 1];
    // Check for duplicate
    if (node.files.some(f => f.name === fileName)) {
      throw new Error(`Duplicate path: ${path}`);
    }
    node.files.push({ name: fileName, data });
  }

  return root;
}

// Flatten directory tree into depth-first order (for path table and sector assignment)
// Returns array of { node, depth, index (1-based), parentIndex (1-based) }
function flattenTree(root) {
  const result = [];
  const queue = [{ node: root, depth: 0, parentIndex: 1 }];

  // BFS to get breadth-first order (required for path tables)
  while (queue.length > 0) {
    const { node, depth, parentIndex } = queue.shift();
    const index = result.length + 1; // 1-based
    result.push({ node, depth, index, parentIndex });

    for (const child of node.children.values()) {
      if (depth + 1 > 8) throw new Error('Directory depth exceeds 8 levels');
      queue.push({ node: child, depth: depth + 1, parentIndex: index });
    }
  }

  return result;
}

// Compute how many sectors a directory extent needs
function computeDirExtentSize(node, isJoliet) {
  // Start with dot and dotdot entries (34 bytes each — identifier is 1 byte)
  let size = 34 + 34;
  let sectorPos = size; // position within current sector

  // Directory entries
  for (const child of node.children.values()) {
    const ident = isJoliet
      ? encodeJolietIdentifier(child.name, true)
      : encodeBaseIdentifier(child.name, true);
    const recLen = dirRecordLength(ident.length);
    // Check if record fits in current sector
    if (sectorPos + recLen > SECTOR_SIZE) {
      // Skip to next sector
      size += (SECTOR_SIZE - sectorPos);
      sectorPos = 0;
    }
    size += recLen;
    sectorPos += recLen;
  }

  // File entries
  for (const file of node.files) {
    const ident = isJoliet
      ? encodeJolietIdentifier(file.name, false)
      : encodeBaseIdentifier(file.name, false);
    const recLen = dirRecordLength(ident.length);
    if (sectorPos + recLen > SECTOR_SIZE) {
      size += (SECTOR_SIZE - sectorPos);
      sectorPos = 0;
    }
    size += recLen;
    sectorPos += recLen;
  }

  // Round up to sector boundary
  return Math.ceil(size / SECTOR_SIZE) * SECTOR_SIZE;
}

// Compute path table size
function computePathTableSize(dirs, isJoliet) {
  let size = 0;
  for (const { node, index } of dirs) {
    let nameLen;
    if (index === 1) {
      nameLen = 1; // root: single zero byte
    } else if (isJoliet) {
      nameLen = encodeJolietIdentifier(node.name, true).length;
      // Path table uses directory name without ;1, so re-encode as dir name
      const name = node.name.substring(0, 64);
      nameLen = name.length * 2; // UCS-2
    } else {
      const name = node.name.toUpperCase().replace(/[^A-Z0-9_.\-]/g, '_').substring(0, 31);
      nameLen = name.length;
    }
    size += 8 + nameLen + (nameLen % 2);
  }
  return size;
}

// Main layout computation
// Returns a layout descriptor with all sector assignments
function computeLayout(fileList, opts = {}) {
  const joliet = opts.joliet !== false;

  // Validate file sizes
  for (const { path, data } of fileList) {
    if (data.byteLength > 0xFFFFFFFF) {
      throw new Error(`File exceeds 4 GiB: ${path}`);
    }
  }

  const root = buildTree(fileList);
  const dirs = flattenTree(root);

  // Sector counter
  let sector = 0;

  // System area: sectors 0-15
  const systemAreaStart = 0;
  sector = 16;

  // PVD: sector 16
  const pvdSector = sector++;

  // SVD (Joliet): sector 17 (if enabled)
  const svdSector = joliet ? sector++ : -1;

  // Terminator
  const terminatorSector = sector++;

  // Path tables (base LE, base BE, joliet LE, joliet BE)
  const basePathTableSize = computePathTableSize(dirs, false);
  const basePathTableSectors = Math.ceil(basePathTableSize / SECTOR_SIZE);

  const basePathTableLE = sector;
  sector += basePathTableSectors;
  const basePathTableBE = sector;
  sector += basePathTableSectors;

  let jolietPathTableLE = -1, jolietPathTableBE = -1, jolietPathTableSize = 0;
  if (joliet) {
    jolietPathTableSize = computePathTableSize(dirs, true);
    const jolietPathTableSectors = Math.ceil(jolietPathTableSize / SECTOR_SIZE);
    jolietPathTableLE = sector;
    sector += jolietPathTableSectors;
    jolietPathTableBE = sector;
    sector += jolietPathTableSectors;
  }

  // Directory extents (base tree)
  const baseDirExtents = [];
  for (const dir of dirs) {
    const extentSize = computeDirExtentSize(dir.node, false);
    baseDirExtents.push({ sector, size: extentSize, sectors: extentSize / SECTOR_SIZE });
    sector += extentSize / SECTOR_SIZE;
  }

  // Directory extents (Joliet tree)
  const jolietDirExtents = [];
  if (joliet) {
    for (const dir of dirs) {
      const extentSize = computeDirExtentSize(dir.node, true);
      jolietDirExtents.push({ sector, size: extentSize, sectors: extentSize / SECTOR_SIZE });
      sector += extentSize / SECTOR_SIZE;
    }
  }

  // File data extents — collect all unique files, assign sectors
  const allFiles = [];
  function collectFiles(node) {
    for (const file of node.files) {
      const sectors = Math.ceil(file.data.byteLength / SECTOR_SIZE) || 1; // at least 1 sector even for empty
      // Actually, empty files can have 0 sectors and LBA 0
      const fileSectors = file.data.byteLength > 0 ? Math.ceil(file.data.byteLength / SECTOR_SIZE) : 0;
      allFiles.push({ file, sector: 0, sectors: fileSectors });
    }
    for (const child of node.children.values()) collectFiles(child);
  }
  collectFiles(root);

  // Assign sectors to files
  for (const entry of allFiles) {
    if (entry.sectors > 0) {
      entry.sector = sector;
      sector += entry.sectors;
    }
    // Store LBA on the file object for later reference
    entry.file._lba = entry.sector;
    entry.file._size = entry.file.data.byteLength;
  }

  const totalSectors = sector;

  return {
    root, dirs,
    totalSectors,
    pvdSector, svdSector, terminatorSector,
    basePathTableLE, basePathTableBE, basePathTableSize,
    jolietPathTableLE, jolietPathTableBE, jolietPathTableSize,
    baseDirExtents, jolietDirExtents,
    allFiles,
    joliet,
  };
}

// -- writer.js --

// ISO 9660 Writer — public API





class ISOWriter {
  constructor(opts = {}) {
    this._opts = {
      volumeId: opts.volumeId || 'UNTITLED',
      publisher: opts.publisher || '',
      preparer: opts.preparer || '',
      application: opts.application || '',
      joliet: opts.joliet !== false,
      greeting: opts.greeting !== false,
    };
    this._files = [];
  }

  // Add a file to the image
  // path: string with "/" separators (e.g., "data/file.txt")
  // data: Uint8Array or ArrayBuffer
  add(path, data) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array or ArrayBuffer');
    this._files.push({ path, data });
  }

  _build() {
    const layout = computeLayout(this._files, { joliet: this._opts.joliet });
    const buf = new Uint8Array(layout.totalSectors * SECTOR_SIZE);
    const date = new Date();

    // System area (sectors 0-15) — zeros + optional greeting
    if (this._opts.greeting) {
      const greetBytes = new TextEncoder().encode(GREETING);
      const greetOffset = 16 * SECTOR_SIZE - greetBytes.length;
      buf.set(greetBytes, greetOffset);
    }

    // Build root directory record for PVD (34 bytes)
    function makeRootDirRecord(extentLBA, dataLen) {
      const rec = new Uint8Array(34);
      encodeDotRecord(rec, 0, extentLBA, dataLen, date);
      return rec;
    }

    // Write PVD
    const baseRootRec = makeRootDirRecord(
      layout.baseDirExtents[0].sector,
      layout.baseDirExtents[0].size,
    );
    const pvd = encodePVD({
      volumeId: this._opts.volumeId,
      publisher: this._opts.publisher,
      preparer: this._opts.preparer,
      application: this._opts.application,
      volumeSpaceSize: layout.totalSectors,
      pathTableSize: layout.basePathTableSize,
      pathTableLBA_LE: layout.basePathTableLE,
      pathTableLBA_BE: layout.basePathTableBE,
      rootRecord: baseRootRec,
      date,
    });
    buf.set(pvd, layout.pvdSector * SECTOR_SIZE);

    // Write SVD (Joliet)
    if (layout.joliet) {
      const jolietRootRec = makeRootDirRecord(
        layout.jolietDirExtents[0].sector,
        layout.jolietDirExtents[0].size,
      );
      const svd = encodeSVD({
        volumeId: this._opts.volumeId,
        publisher: this._opts.publisher,
        preparer: this._opts.preparer,
        application: this._opts.application,
        volumeSpaceSize: layout.totalSectors,
        pathTableSize: layout.jolietPathTableSize,
        pathTableLBA_LE: layout.jolietPathTableLE,
        pathTableLBA_BE: layout.jolietPathTableBE,
        rootRecord: jolietRootRec,
        date,
      });
      buf.set(svd, layout.svdSector * SECTOR_SIZE);
    }

    // Write terminator
    buf.set(encodeTerminator(), layout.terminatorSector * SECTOR_SIZE);

    // Write path tables
    this._writePathTables(buf, layout, false); // base
    if (layout.joliet) this._writePathTables(buf, layout, true); // joliet

    // Write directory extents
    this._writeDirExtents(buf, layout, false, date);
    if (layout.joliet) this._writeDirExtents(buf, layout, true, date);

    // Write file data
    for (const entry of layout.allFiles) {
      if (entry.file.data.byteLength > 0) {
        buf.set(entry.file.data, entry.sector * SECTOR_SIZE);
      }
    }

    return buf;
  }

  _writePathTables(buf, layout, isJoliet) {
    const dirs = layout.dirs;
    const extents = isJoliet ? layout.jolietDirExtents : layout.baseDirExtents;
    const leLBA = isJoliet ? layout.jolietPathTableLE : layout.basePathTableLE;
    const beLBA = isJoliet ? layout.jolietPathTableBE : layout.basePathTableBE;

    const entries = dirs.map((dir, i) => {
      let nameBytes;
      if (dir.index === 1) {
        nameBytes = new Uint8Array([0]); // root
      } else if (isJoliet) {
        const name = dir.node.name.substring(0, 64);
        nameBytes = encodeUCS2(name);
      } else {
        const name = dir.node.name.toUpperCase().replace(/[^A-Z0-9_.\-]/g, '_').substring(0, 31);
        nameBytes = new Uint8Array(Array.from(name, c => c.charCodeAt(0)));
      }
      return {
        nameBytes,
        extentLBA: extents[i].sector,
        parentIndex: dir.parentIndex,
      };
    });

    const leTable = encodePathTable(entries, 'le');
    const beTable = encodePathTable(entries, 'be');
    buf.set(leTable, leLBA * SECTOR_SIZE);
    buf.set(beTable, beLBA * SECTOR_SIZE);
  }

  _writeDirExtents(buf, layout, isJoliet, date) {
    const dirs = layout.dirs;
    const extents = isJoliet ? layout.jolietDirExtents : layout.baseDirExtents;

    for (let di = 0; di < dirs.length; di++) {
      const { node } = dirs[di];
      const extent = extents[di];
      const extentOff = extent.sector * SECTOR_SIZE;

      // Parent extent info
      const parentIdx = dirs[di].parentIndex - 1; // 0-based for array lookup
      const parentExtent = extents[parentIdx];

      let pos = 0;

      // Dot entry (self)
      pos += encodeDotRecord(buf, extentOff + pos, extent.sector, extent.size, date);

      // Dotdot entry (parent)
      pos += encodeDotDotRecord(buf, extentOff + pos, parentExtent.sector, parentExtent.size, date);

      // Directory children
      for (const child of node.children.values()) {
        const childDirIdx = dirs.findIndex(d => d.node === child);
        const childExtent = extents[childDirIdx];

        const ident = isJoliet
          ? encodeJolietIdentifier(child.name, true)
          : encodeBaseIdentifier(child.name, true);

        const recLen = 33 + ident.length + ((33 + ident.length) % 2 === 1 ? 1 : 0);

        // Sector boundary check
        const sectorPos = pos % SECTOR_SIZE;
        if (sectorPos + recLen > SECTOR_SIZE) {
          pos += SECTOR_SIZE - sectorPos; // skip to next sector
        }

        pos += encodeDirRecord(buf, extentOff + pos, {
          extentLBA: childExtent.sector,
          dataLen: childExtent.size,
          date,
          isDir: true,
          identifier: ident,
        });
      }

      // File entries
      for (const file of node.files) {
        const ident = isJoliet
          ? encodeJolietIdentifier(file.name, false)
          : encodeBaseIdentifier(file.name, false);

        const recLen = 33 + ident.length + ((33 + ident.length) % 2 === 1 ? 1 : 0);

        const sectorPos = pos % SECTOR_SIZE;
        if (sectorPos + recLen > SECTOR_SIZE) {
          pos += SECTOR_SIZE - sectorPos;
        }

        pos += encodeDirRecord(buf, extentOff + pos, {
          extentLBA: file._lba,
          dataLen: file._size,
          date,
          isDir: false,
          identifier: ident,
        });
      }
    }
  }

  toUint8Array() {
    return this._build();
  }

  toBlob() {
    return new Blob([this._build()], { type: 'application/octet-stream' });
  }

  download(filename) {
    const blob = this.toBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'image.iso';
    a.click();
    URL.revokeObjectURL(url);
  }
}

// -- reader.js --

// ISO 9660 Reader — public API




class ISOReader {
  constructor(arrayBuffer) {
    this._buf = new Uint8Array(arrayBuffer);
    this._pvd = null;
    this._svd = null;
    this._joliet = false;

    this._parseDescriptors();
  }

  _parseDescriptors() {
    let sector = 16;
    while (sector * SECTOR_SIZE < this._buf.length) {
      const vd = decodeVolumeDescriptor(this._buf, sector);
      if (!vd) break;
      if (vd.type === VD_TERMINATOR) break;
      if (vd.type === VD_PRIMARY) this._pvd = vd;
      if (vd.type === VD_SUPPLEMENTARY && vd.isJoliet) this._svd = vd;
      sector++;
    }
    if (!this._pvd) throw new Error('No Primary Volume Descriptor found');
    this._joliet = !!this._svd;
  }

  get volumeId() { return this._pvd.volumeId; }
  get publisher() { return this._pvd.publisher; }
  get preparer() { return this._pvd.preparer; }
  get application() { return this._pvd.application; }
  get joliet() { return this._joliet; }

  // List all files (and optionally directories)
  // opts.stat: include size, date, isDir
  // opts.joliet: force Joliet tree (true/false), default: auto
  list(opts = {}) {
    const useJoliet = opts.joliet != null ? opts.joliet : this._joliet;
    const vd = useJoliet && this._svd ? this._svd : this._pvd;
    const results = [];

    this._walk(vd.rootExtentLBA, Math.ceil(vd.rootDataLen / SECTOR_SIZE), useJoliet, '', results, opts.stat);
    return results;
  }

  _walk(extentLBA, sectorCount, isJoliet, parentPath, results, stat) {
    const entries = decodeDirExtent(this._buf, extentLBA * SECTOR_SIZE, sectorCount, isJoliet);

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;

      const fullPath = parentPath + '/' + entry.name;

      if (entry.isDir) {
        const childSectors = Math.ceil(entry.dataLen / SECTOR_SIZE);
        this._walk(entry.extentLBA, childSectors, isJoliet, fullPath, results, stat);
      } else {
        if (stat) {
          results.push({ path: fullPath, size: entry.dataLen, date: entry.date, isDir: false });
        } else {
          results.push(fullPath);
        }
      }
    }
  }

  // Read a file — returns Uint8Array (zero-copy view into underlying buffer)
  read(path, opts = {}) {
    const useJoliet = opts.joliet != null ? opts.joliet : this._joliet;
    const vd = useJoliet && this._svd ? this._svd : this._pvd;

    const entry = this._findFile(vd.rootExtentLBA, Math.ceil(vd.rootDataLen / SECTOR_SIZE),
      useJoliet, path);
    if (!entry) throw new Error(`File not found: ${path}`);

    return new Uint8Array(this._buf.buffer, this._buf.byteOffset + entry.extentLBA * SECTOR_SIZE, entry.dataLen);
  }

  // Read a file as text
  readText(path, opts = {}) {
    return new TextDecoder().decode(this.read(path, opts));
  }

  // List entries in a specific directory
  readdir(path, opts = {}) {
    const useJoliet = opts.joliet != null ? opts.joliet : this._joliet;
    const vd = useJoliet && this._svd ? this._svd : this._pvd;

    // Find the directory
    const dir = path === '/' || path === ''
      ? { extentLBA: vd.rootExtentLBA, dataLen: vd.rootDataLen }
      : this._findDir(vd.rootExtentLBA, Math.ceil(vd.rootDataLen / SECTOR_SIZE), useJoliet, path);

    if (!dir) throw new Error(`Directory not found: ${path}`);

    const entries = decodeDirExtent(this._buf, dir.extentLBA * SECTOR_SIZE,
      Math.ceil(dir.dataLen / SECTOR_SIZE), useJoliet);

    return entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({ name: e.name, size: e.dataLen, date: e.date, isDir: e.isDir }));
  }

  _findFile(extentLBA, sectorCount, isJoliet, path) {
    // Normalize path
    const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);
    return this._findEntry(extentLBA, sectorCount, isJoliet, parts, false);
  }

  _findDir(extentLBA, sectorCount, isJoliet, path) {
    const parts = path.replace(/^\//, '').split('/').filter(p => p.length > 0);
    return this._findEntry(extentLBA, sectorCount, isJoliet, parts, true);
  }

  _findEntry(extentLBA, sectorCount, isJoliet, parts, isDir) {
    if (parts.length === 0) return null;

    const entries = decodeDirExtent(this._buf, extentLBA * SECTOR_SIZE, sectorCount, isJoliet);
    const target = parts[0];

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;

      // Case-insensitive match for base tree, exact for Joliet
      const match = isJoliet
        ? entry.name === target
        : entry.name.toUpperCase() === target.toUpperCase();

      if (match) {
        if (parts.length === 1) {
          // Last component — check if it's the right type
          if (isDir && !entry.isDir) continue;
          if (!isDir && entry.isDir) continue;
          return entry;
        }
        // More path components — must be a directory
        if (entry.isDir) {
          return this._findEntry(entry.extentLBA, Math.ceil(entry.dataLen / SECTOR_SIZE),
            isJoliet, parts.slice(1), isDir);
        }
      }
    }

    return null;
  }
}
export { ISOWriter, ISOReader };
