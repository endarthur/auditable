// FDT (Flattened Device Tree) builder

function buildDtb({ ramBase = 0x80000000, ramSize = 0x4000000, bootArgs = 'console=hvc0' } = {}) {
  const structs = [], strings = [];
  let strOff = 0;
  const strMap = {};

  function align4(arr) { while (arr.length & 3) arr.push(0); }
  function pushU32(arr, v) {
    arr.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
  }
  function strIdx(name) {
    if (name in strMap) return strMap[name];
    strMap[name] = strOff;
    for (let i = 0; i < name.length; i++) strings.push(name.charCodeAt(i));
    strings.push(0);
    const idx = strOff;
    strOff += name.length + 1;
    return idx;
  }
  function beginNode(name) {
    pushU32(structs, 1); // FDT_BEGIN_NODE
    for (let i = 0; i < name.length; i++) structs.push(name.charCodeAt(i));
    structs.push(0);
    align4(structs);
  }
  function endNode() { pushU32(structs, 2); } // FDT_END_NODE
  function prop(name, data) {
    pushU32(structs, 3); // FDT_PROP
    pushU32(structs, data.length);
    pushU32(structs, strIdx(name));
    for (let i = 0; i < data.length; i++) structs.push(data[i]);
    align4(structs);
  }
  function propStr(name, s) {
    const d = [];
    for (let i = 0; i < s.length; i++) d.push(s.charCodeAt(i));
    d.push(0);
    prop(name, d);
  }
  function propU32(name, v) { const d = []; pushU32(d, v); prop(name, d); }
  function propU64(name, hi, lo) { const d = []; pushU32(d, hi); pushU32(d, lo); prop(name, d); }
  function propReg2(name, addrHi, addrLo, sizeHi, sizeLo) {
    const d = [];
    pushU32(d, addrHi); pushU32(d, addrLo);
    pushU32(d, sizeHi); pushU32(d, sizeLo);
    prop(name, d);
  }

  // Multi-string property (null-separated strings)
  function propStrs(name, strs) {
    const d = [];
    for (const s of strs) {
      for (let i = 0; i < s.length; i++) d.push(s.charCodeAt(i));
      d.push(0);
    }
    prop(name, d);
  }

  // Build tree — node order must match reference DTB
  beginNode('');
  propU32('#address-cells', 2);
  propU32('#size-cells', 2);
  propStr('compatible', 'riscv-minimal-nommu');
  propStr('model', 'riscv-minimal-nommu,qemu');

  beginNode('chosen');
  propStr('bootargs', bootArgs);
  endNode();

  beginNode('memory@80000000');
  propStr('device_type', 'memory');
  propReg2('reg', 0, ramBase, 0, ramSize);
  endNode();

  beginNode('cpus');
  propU32('#address-cells', 1);
  propU32('#size-cells', 0);
  propU32('timebase-frequency', 1000000);
  beginNode('cpu@0');
  propU32('phandle', 1);
  propStr('device_type', 'cpu');
  propU32('reg', 0);
  propStr('status', 'okay');
  propStr('compatible', 'riscv');
  propStr('riscv,isa', 'rv32ima');
  propStr('mmu-type', 'riscv,none');
  beginNode('interrupt-controller');
  propU32('#interrupt-cells', 1);
  prop('interrupt-controller', []);
  propStr('compatible', 'riscv,cpu-intc');
  propU32('phandle', 2);
  endNode(); // interrupt-controller
  endNode(); // cpu@0

  beginNode('cpu-map');
  beginNode('cluster0');
  beginNode('core0');
  propU32('cpu', 1);
  endNode();
  endNode();
  endNode(); // cpu-map

  endNode(); // cpus

  beginNode('soc');
  propU32('#address-cells', 2);
  propU32('#size-cells', 2);
  propStr('compatible', 'simple-bus');
  prop('ranges', []);

  beginNode('uart@10000000');
  propU32('clock-frequency', 0x1000000);
  propReg2('reg', 0, 0x10000000, 0, 0x100);
  propStr('compatible', 'ns16850');
  endNode();

  beginNode('poweroff');
  propU32('value', 0x5555);
  propU32('offset', 0);
  propU32('regmap', 4);
  propStr('compatible', 'syscon-poweroff');
  endNode();

  beginNode('reboot');
  propU32('value', 0x7777);
  propU32('offset', 0);
  propU32('regmap', 4);
  propStr('compatible', 'syscon-reboot');
  endNode();

  beginNode('syscon@11100000');
  propU32('phandle', 4);
  propReg2('reg', 0, 0x11100000, 0, 0x1000);
  propStr('compatible', 'syscon');
  endNode();

  beginNode('clint@11000000');
  const clintInts = [];
  pushU32(clintInts, 2); pushU32(clintInts, 3);
  pushU32(clintInts, 2); pushU32(clintInts, 7);
  prop('interrupts-extended', clintInts);
  propReg2('reg', 0, 0x11000000, 0, 0x10000);
  propStrs('compatible', ['sifive,clint0', 'riscv,clint0']);
  endNode();

  endNode(); // soc

  endNode(); // root
  pushU32(structs, 9); // FDT_END

  // Assemble header + mem_rsvmap + structs + strings
  const hdrSize = 40;
  const rsvmapOff = hdrSize;          // empty reservation map right after header
  const rsvmapSize = 16;              // one all-zeros entry (8-byte addr + 8-byte size)
  const structsOff = rsvmapOff + rsvmapSize;
  const stringsOff = structsOff + structs.length;
  const totalSize = stringsOff + strings.length;
  const aligned = (totalSize + 7) & ~7; // 8-byte align (DTB spec requirement)

  const buf = new Uint8Array(aligned); // zero-initialized
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xd00dfeed); // magic
  dv.setUint32(4, aligned);     // totalsize
  dv.setUint32(8, structsOff);  // off_dt_struct
  dv.setUint32(12, stringsOff); // off_dt_strings
  dv.setUint32(16, rsvmapOff);  // off_mem_rsvmap
  dv.setUint32(20, 17);         // version
  dv.setUint32(24, 16);         // last_comp_version
  dv.setUint32(28, 0);          // boot_cpuid_phys
  dv.setUint32(32, strings.length); // size_dt_strings
  dv.setUint32(36, structs.length); // size_dt_struct
  // rsvmap is already zeros (empty terminator)
  buf.set(structs, structsOff);
  buf.set(strings, stringsOff);
  return buf;
}
