// Lockstep comparison: Lohr's mini-rv32ima (JS port) vs our Wasm emulator
// Runs both on the same image, compares register + CSR state after each instruction.
// Reports the first divergence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { createCPU } from './lohr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load our Wasm emulator ──
const rvPath = path.join(__dirname, '..', 'index.js');
const rvSrc = fs.readFileSync(rvPath, 'utf8');
let cleanSrc = rvSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+function\s/gm, 'function ')
  .replace(/^export\s+const\s/gm, 'const ')
  .replace(/^export\s+let\s/gm, 'let ');
const mod = {};
new Function('module', cleanSrc + '\nmodule.exports = { instantiate };')(mod);
const { instantiate } = mod.exports;

// ── Load image + DTB ──
const imgBuf = fs.readFileSync(path.join(__dirname, 'images', 'Image.bin'));
const dtbBuf = fs.readFileSync(path.join(__dirname, 'sixtyfourmb.dtb'));

const RAM_SIZE = 64 * 1024 * 1024;
const RAM_BASE = 0x80000000;

// ══════════════════════════════════════════════════════════
// Reference: Lohr's mini-rv32ima via shared module
// ══════════════════════════════════════════════════════════
function createReference() {
  const cpu = createCPU();
  cpu.loadImage(imgBuf, 0);
  const dtb_ptr = cpu.loadDTB(dtbBuf);
  cpu.init(dtb_ptr);
  return cpu;
}

// ══════════════════════════════════════════════════════════
// Our Wasm emulator
// ══════════════════════════════════════════════════════════
function createOurs() {
  const STATE_SIZE = 192;
  const dtb_ptr = RAM_SIZE - dtbBuf.length - STATE_SIZE;

  function makeDtbCopy() {
    const copy = new Uint8Array(dtbBuf.length);
    copy.set(new Uint8Array(dtbBuf.buffer, dtbBuf.byteOffset, dtbBuf.byteLength));
    const dv = new DataView(copy.buffer);
    if (dv.getUint32(0x13c) === 0x03ffc000) dv.setUint32(0x13c, dtb_ptr);
    return copy;
  }

  const totalPages = (RAM_SIZE / 65536) + 1;
  const memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages });

  function mmio_read(a) {
    a >>>= 0;
    if (a >= 0x10000000 && a < 0x10000100) { if ((a & 0xFF) === 5) return 0x60; if ((a & 0xFF) === 0) return 0; return 0; }
    if (a >= 0x11000000 && a < 0x11010000) { const o = a - 0x11000000; if (o === 0xBFF8) return cpu.get_mtime_lo(); if (o === 0xBFFC) return cpu.get_mtime_hi(); if (o === 0x4000) return cpu.get_mtimecmp_lo(); if (o === 0x4004) return cpu.get_mtimecmp_hi(); return 0; }
    return 0;
  }
  function mmio_write(a, v) {
    a >>>= 0;
    if (a >= 0x10000000 && a < 0x10000100) return;
    if (a >= 0x11000000 && a < 0x11010000) { const o = a - 0x11000000; if (o === 0x4000) cpu.set_mtimecmp(v >>> 0, cpu.get_mtimecmp_hi()); if (o === 0x4004) cpu.set_mtimecmp(cpu.get_mtimecmp_lo(), v | 0); return; }
  }

  const cpu = instantiate({ memory, mmio_read, mmio_write });
  const mem8 = new Uint8Array(memory.buffer);
  mem8.fill(0, 0, RAM_SIZE);
  mem8.set(new Uint8Array(imgBuf.buffer, imgBuf.byteOffset, imgBuf.byteLength), 0);
  const dtbCopy = makeDtbCopy();
  mem8.set(dtbCopy, dtb_ptr);
  cpu.set_pc(RAM_BASE);
  const regs = new Int32Array(memory.buffer, 0x04000000, 32);
  const ram32 = new Uint32Array(memory.buffer);
  regs[10] = 0;
  regs[11] = RAM_BASE + dtb_ptr;
  cpu.set_extraflags(3);

  return { cpu, regs, ram32 };
}

// ══════════════════════════════════════════════════════════
// Lockstep comparison
// ══════════════════════════════════════════════════════════
const ref = createReference();
const ours = createOurs();

const MAX = parseInt(process.argv[2] || '200000', 10);
const RN = ['zero','ra','sp','gp','tp','t0','t1','t2','s0','s1','a0','a1','a2','a3','a4','a5','a6','a7','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','t3','t4','t5','t6'];

console.error(`Lockstep comparison for ${MAX} cycles...\n`);

const TRACE_SIZE = 30;
const traceRing = new Array(TRACE_SIZE);
let traceIdx = 0;

for (let cycle = 0; cycle < MAX; cycle++) {
  ref.step(1);
  // Advance mtime by 1 before step (host-managed timer, matches Lohr's step(elapsedUs))
  {
    const tl = ours.cpu.get_mtime_lo() >>> 0;
    const newLo = (tl + 1) >>> 0;
    ours.cpu.set_mtime(newLo, newLo < tl ? ((ours.cpu.get_mtime_hi() >>> 0) + 1) | 0 : ours.cpu.get_mtime_hi());
  }
  ours.cpu.step_batch(0, 1);

  // Record trace
  const refPcT = ref.pc >>> 0;
  const ofsT = (refPcT - RAM_BASE) >>> 0;
  const irT = ofsT < RAM_SIZE ? ref.ram32[ofsT >>> 2] : 0;
  traceRing[traceIdx % TRACE_SIZE] = {
    cycle: cycle + 1, pc: refPcT, ir: irT,
    refMstatus: ref.mstatus, ourMstatus: ours.cpu.get_mstatus(),
    refExtraflags: ref.extraflags, ourExtraflags: ours.cpu.get_extraflags(),
    refMepc: ref.mepc, ourMepc: ours.cpu.get_mepc(),
  };
  traceIdx++;

  // Compare PC
  const refPc = refPcT;
  const ourPc = ours.cpu.get_pc() >>> 0;

  if (refPc !== ourPc) {
    console.error(`DIVERGE at cycle ${cycle + 1}: PC`);
    console.error(`  ref pc=0x${refPc.toString(16)}  ours pc=0x${ourPc.toString(16)}`);
    dumpState(cycle);
    break;
  }

  // Compare registers
  let regDiff = false;
  for (let r = 0; r < 32; r++) {
    if ((ref.regs[r] | 0) !== (ours.regs[r] | 0)) {
      if (!regDiff) {
        console.error(`DIVERGE at cycle ${cycle + 1}: registers (pc=0x${refPc.toString(16)})`);
        regDiff = true;
      }
      console.error(`  ${RN[r]}: ref=0x${(ref.regs[r]>>>0).toString(16)} ours=0x${(ours.regs[r]>>>0).toString(16)}`);
    }
  }
  if (regDiff) { dumpState(cycle); break; }

  // Compare key CSRs
  const csrs = [
    ['mcause', ref.mcause, ours.cpu.get_mcause()],
    ['mepc', ref.mepc, ours.cpu.get_mepc()],
    ['mstatus', ref.mstatus, ours.cpu.get_mstatus()],
    ['mtvec', ref.mtvec, ours.cpu.get_mtvec()],
    ['mie', ref.mie, ours.cpu.get_mie()],
    ['mscratch', ref.mscratch, ours.cpu.get_mscratch()],
    ['extraflags', ref.extraflags, ours.cpu.get_extraflags()],
  ];
  let csrDiff = false;
  for (const [name, rv, ov] of csrs) {
    if ((rv >>> 0) !== (ov >>> 0)) {
      if (!csrDiff) {
        console.error(`DIVERGE at cycle ${cycle + 1}: CSRs (pc=0x${refPc.toString(16)})`);
        csrDiff = true;
      }
      console.error(`  ${name}: ref=0x${(rv>>>0).toString(16)} ours=0x${(ov>>>0).toString(16)}`);
    }
  }
  if (csrDiff) { dumpState(cycle); break; }

  // Progress
  if ((cycle + 1) % 50000 === 0) {
    console.error(`[${(cycle+1)/1000}K] pc=0x${refPc.toString(16)} OK`);
  }
}

function dumpState(cycle) {
  const refPc = ref.pc >>> 0;
  const ofs = (refPc - RAM_BASE) >>> 0;
  const ir = ofs < RAM_SIZE ? ref.ram32[ofs >>> 2] : 0;
  console.error(`\n  Instruction at ref pc: 0x${ir.toString(16).padStart(8, '0')}`);
  console.error(`  ref:  mcause=0x${(ref.mcause>>>0).toString(16)} mepc=0x${(ref.mepc>>>0).toString(16)} mstatus=0x${(ref.mstatus>>>0).toString(16)} mtvec=0x${(ref.mtvec>>>0).toString(16)} extraflags=0x${(ref.extraflags>>>0).toString(16)}`);
  console.error(`  ours: mcause=0x${(ours.cpu.get_mcause()>>>0).toString(16)} mepc=0x${(ours.cpu.get_mepc()>>>0).toString(16)} mstatus=0x${(ours.cpu.get_mstatus()>>>0).toString(16)} mtvec=0x${(ours.cpu.get_mtvec()>>>0).toString(16)} extraflags=0x${(ours.cpu.get_extraflags()>>>0).toString(16)}`);

  // Dump trace ring
  console.error(`\n  Last ${TRACE_SIZE} cycles before divergence:`);
  for (let j = 0; j < Math.min(TRACE_SIZE, traceIdx); j++) {
    const idx = (traceIdx - Math.min(TRACE_SIZE, traceIdx) + j) % TRACE_SIZE;
    const t = traceRing[idx];
    const opcode = t.ir & 0x7f;
    let desc = `op=0x${opcode.toString(16).padStart(2,'0')}`;
    if (opcode === 0x73) {
      const csrno = t.ir >>> 20;
      const microop = (t.ir >>> 12) & 7;
      const rdid = (t.ir >>> 7) & 0x1f;
      const rs1 = (t.ir >>> 15) & 0x1f;
      desc = `SYSTEM csrno=0x${csrno.toString(16)} microop=${microop} rd=x${rdid} rs1=x${rs1}`;
    }
    const msDiff = (t.refMstatus >>> 0) !== (t.ourMstatus >>> 0) ? ' *** MSTATUS DIFF ***' : '';
    const efDiff = (t.refExtraflags >>> 0) !== (t.ourExtraflags >>> 0) ? ' *** EXTRAFLAGS DIFF ***' : '';
    console.error(`  [${t.cycle}] pc=0x${t.pc.toString(16)} ir=0x${t.ir.toString(16).padStart(8,'0')} ${desc} mstatus=ref:0x${(t.refMstatus>>>0).toString(16)}/ours:0x${(t.ourMstatus>>>0).toString(16)} ef=ref:0x${(t.refExtraflags>>>0).toString(16)}/ours:0x${(t.ourExtraflags>>>0).toString(16)}${msDiff}${efDiff}`);
  }
}

console.error('\nDone.');
