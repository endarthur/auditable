// ByteWriter — binary builder for Wasm output

export class ByteWriter {
  constructor() { this.buf = []; }
  byte(b) { this.buf.push(b & 0xff); }
  bytes(arr) { for (const b of arr) this.byte(b); }
  u32(v) { // LEB128 unsigned
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; this.byte(b); } while (v);
  }
  s32(v) { // LEB128 signed
    let more = true;
    while (more) {
      let b = v & 0x7f; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false; else b |= 0x80;
      this.byte(b);
    }
  }
  s64(v) { // LEB128 signed for i64 (BigInt)
    v = BigInt(v);
    let more = true;
    while (more) {
      let b = Number(v & 0x7fn); v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = false; else b |= 0x80;
      this.byte(b);
    }
  }
  f32(v) { const buf = new ArrayBuffer(4); new DataView(buf).setFloat32(0, v, true); this.bytes(new Uint8Array(buf)); }
  f64(v) { const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, v, true); this.bytes(new Uint8Array(buf)); }
  str(s) { const enc = new TextEncoder().encode(s); this.u32(enc.length); this.bytes(enc); }
  section(id, contentFn) {
    const inner = new ByteWriter();
    contentFn(inner);
    this.byte(id);
    this.u32(inner.buf.length);
    this.bytes(inner.buf);
  }
  toUint8Array() { return new Uint8Array(this.buf); }
}
