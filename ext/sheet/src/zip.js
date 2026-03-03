// ── CRC32 ──

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c;
}

export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Helpers ──

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deflateRaw(data) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function readU16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function readU32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0; }

function writeU16(buf, off, val) { buf[off] = val & 0xFF; buf[off + 1] = (val >> 8) & 0xFF; }
function writeU32(buf, off, val) { buf[off] = val & 0xFF; buf[off + 1] = (val >> 8) & 0xFF; buf[off + 2] = (val >> 16) & 0xFF; buf[off + 3] = (val >> 24) & 0xFF; }

// ── Unzip ──

export async function unzip(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = new Map();

  // find End of Central Directory (search backwards for signature 0x06054b50)
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (readU32(buf, i) === 0x06054B50) { eocdOff = i; break; }
  }
  if (eocdOff === -1) throw new Error('not a ZIP file: EOCD not found');

  const entryCount = readU16(buf, eocdOff + 10);
  let cdOff = readU32(buf, eocdOff + 16);

  for (let e = 0; e < entryCount; e++) {
    if (readU32(buf, cdOff) !== 0x02014B50) throw new Error('bad central directory entry');

    const method = readU16(buf, cdOff + 10);
    const crc = readU32(buf, cdOff + 16);
    const compSize = readU32(buf, cdOff + 20);
    const uncompSize = readU32(buf, cdOff + 24);
    const nameLen = readU16(buf, cdOff + 28);
    const extraLen = readU16(buf, cdOff + 30);
    const commentLen = readU16(buf, cdOff + 32);
    const localOff = readU32(buf, cdOff + 42);

    const name = decoder.decode(buf.subarray(cdOff + 46, cdOff + 46 + nameLen));
    cdOff += 46 + nameLen + extraLen + commentLen;

    // skip directories
    if (name.endsWith('/')) continue;

    // read local file header to find data offset
    const localNameLen = readU16(buf, localOff + 26);
    const localExtraLen = readU16(buf, localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);

    let data;
    if (method === 0) {
      // stored
      data = compressed.slice();
    } else if (method === 8) {
      // deflated
      data = await inflateRaw(compressed);
    } else {
      throw new Error(`unsupported compression method ${method} for ${name}`);
    }

    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    entries.set(name, data);
  }

  return entries;
}

// ── Zip ──

export async function zip(entries) {
  // entries: Map<string, Uint8Array> or array of [name, data]
  const items = entries instanceof Map ? [...entries] : entries;
  const localHeaders = [];
  const centralEntries = [];
  let offset = 0;

  for (const [name, raw] of items) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);
    const compressed = await deflateRaw(raw);

    // use deflated only if smaller
    const useDeflate = compressed.length < raw.length;
    const stored = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;

    // local file header (30 + nameLen)
    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    writeU32(local, 0, 0x04034B50);    // signature
    writeU16(local, 4, 20);            // version needed
    writeU16(local, 6, 0);             // flags
    writeU16(local, 8, method);        // compression method
    writeU16(local, 10, 0);            // mod time
    writeU16(local, 12, 0);            // mod date
    writeU32(local, 14, crc);          // CRC-32
    writeU32(local, 18, stored.length);  // compressed size
    writeU32(local, 22, raw.length);     // uncompressed size
    writeU16(local, 26, nameBytes.length);
    writeU16(local, 28, 0);            // extra field length
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    localHeaders.push(local);

    // central directory entry (46 + nameLen)
    const central = new Uint8Array(46 + nameBytes.length);
    writeU32(central, 0, 0x02014B50);
    writeU16(central, 4, 20);          // version made by
    writeU16(central, 6, 20);          // version needed
    writeU16(central, 8, 0);           // flags
    writeU16(central, 10, method);
    writeU16(central, 12, 0);          // mod time
    writeU16(central, 14, 0);          // mod date
    writeU32(central, 16, crc);
    writeU32(central, 20, stored.length);
    writeU32(central, 24, raw.length);
    writeU16(central, 28, nameBytes.length);
    writeU16(central, 30, 0);          // extra field length
    writeU16(central, 32, 0);          // comment length
    writeU16(central, 34, 0);          // disk number
    writeU16(central, 36, 0);          // internal attributes
    writeU32(central, 38, 0);          // external attributes
    writeU32(central, 42, offset);     // local header offset
    central.set(nameBytes, 46);
    centralEntries.push(central);

    offset += local.length;
  }

  // End of Central Directory
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralEntries) cdSize += c.length;

  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054B50);
  writeU16(eocd, 4, 0);               // disk number
  writeU16(eocd, 6, 0);               // disk with central dir
  writeU16(eocd, 8, items.length);     // entries on this disk
  writeU16(eocd, 10, items.length);    // total entries
  writeU32(eocd, 12, cdSize);          // central dir size
  writeU32(eocd, 16, cdOffset);        // central dir offset
  writeU16(eocd, 20, 0);              // comment length

  // concatenate all parts
  const total = offset + cdSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const l of localHeaders) { result.set(l, pos); pos += l.length; }
  for (const c of centralEntries) { result.set(c, pos); pos += c.length; }
  result.set(eocd, pos);

  return result;
}
