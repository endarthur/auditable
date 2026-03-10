// ELF32 loader — parse PT_LOAD segments into Wasm memory

const RAM_BASE = 0x80000000;

function loadElf(buffer, mem8) {
  const v = new DataView(buffer);
  // Verify ELF magic
  if (v.getUint32(0, false) !== 0x7f454c46) throw new Error('Not an ELF file');
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const phsize = v.getUint16(42, true);
  const phnum = v.getUint16(44, true);
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phsize;
    if (v.getUint32(off, true) !== 1) continue; // PT_LOAD only
    const foff = v.getUint32(off + 4, true);
    const vaddr = v.getUint32(off + 8, true);
    const filesz = v.getUint32(off + 16, true);
    const memsz = v.getUint32(off + 20, true);
    const dest = (vaddr - RAM_BASE) >>> 0;
    mem8.set(new Uint8Array(buffer, foff, filesz), dest);
    // Zero BSS
    if (memsz > filesz) mem8.fill(0, dest + filesz, dest + memsz);
  }
  return entry;
}
