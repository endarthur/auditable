// Boot benchmark: run our Wasm emulator at full speed in Node
// Tests both CPU and DTB generation. Compare MIPS with native mini-rv32ima.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load CPU instantiate from index.js
const rvPath = path.join(__dirname, '..', 'index.js');
const rvSrc = fs.readFileSync(rvPath, 'utf8');
let cleanSrc = rvSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+function\s/gm, 'function ')
  .replace(/^export\s+const\s/gm, 'const ')
  .replace(/^export\s+let\s/gm, 'let ');
const mod = {};
new Function('module', cleanSrc + '\nmodule.exports = { instantiate };')(mod);
const { instantiate } = mod.exports;

// Load buildDtb from ext/rv/js/dtb.js
const dtbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'dtb.js'), 'utf8');
const dtbMod = {};
new Function('module', dtbSrc + '\nmodule.exports = { buildDtb };')(dtbMod);
const { buildDtb } = dtbMod.exports;

const imgBuf = fs.readFileSync(path.join(__dirname, 'images', 'Image.bin'));

const RAM_SIZE = 64 * 1024 * 1024;
const RAM_BASE = 0x80000000;
const STATE_SIZE = 192;

const totalPages = (RAM_SIZE / 65536) + 1;
const memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages });

let uartOut = '';
let ier = 0;

function mmio_read(a) {
  a >>>= 0;
  if (a >= 0x10000000 && a < 0x10000100) {
    const off = a & 0xFF;
    if (off === 5) return 0x60;
    if (off === 2) return (ier & 2) ? 0x02 : 0x01;
    if (off === 0) return 0;
    if (off === 1) return ier;
    return 0;
  }
  if (a >= 0x11000000 && a < 0x11010000) {
    const o = a - 0x11000000;
    if (o === 0xBFF8) return cpu.get_mtime_lo();
    if (o === 0xBFFC) return cpu.get_mtime_hi();
    if (o === 0x4000) return cpu.get_mtimecmp_lo();
    if (o === 0x4004) return cpu.get_mtimecmp_hi();
    return 0;
  }
  return 0;
}

function mmio_write(a, v) {
  a >>>= 0;
  if (a >= 0x10000000 && a < 0x10000100) {
    const off = a & 0xFF;
    if (off === 0) {
      const ch = String.fromCharCode(v & 0xff);
      uartOut += ch;
      process.stdout.write(ch);
    }
    if (off === 1) ier = v;
    return;
  }
  if (a >= 0x11000000 && a < 0x11010000) {
    const o = a - 0x11000000;
    if (o === 0x4000) cpu.set_mtimecmp(v >>> 0, cpu.get_mtimecmp_hi());
    if (o === 0x4004) cpu.set_mtimecmp(cpu.get_mtimecmp_lo(), v | 0);
    return;
  }
  if (a === 0x11100000) {
    const elapsed = (performance.now() - t0) / 1000;
    console.error(`\nSYSCON: ${totalCycles} cycles in ${elapsed.toFixed(1)}s (${(totalCycles/elapsed/1e6).toFixed(1)} MIPS)`);
    process.exit(0);
  }
}

const cpu = instantiate({ memory, mmio_read, mmio_write });
const mem8 = new Uint8Array(memory.buffer);
mem8.fill(0, 0, RAM_SIZE);
mem8.set(new Uint8Array(imgBuf.buffer, imgBuf.byteOffset, imgBuf.byteLength), 0);

// Build DTB with our buildDtb()
const bootArgs = 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0';
const dtbEst = buildDtb({ ramBase: RAM_BASE, ramSize: RAM_SIZE - 1024 - STATE_SIZE, bootArgs });
const dtb_ptr = RAM_SIZE - dtbEst.length - STATE_SIZE;
const dtb = buildDtb({ ramBase: RAM_BASE, ramSize: dtb_ptr, bootArgs });
mem8.set(dtb, dtb_ptr);

cpu.set_pc(RAM_BASE);
const regs = new Int32Array(memory.buffer, 0x04000000, 32);
regs[10] = 0;
regs[11] = RAM_BASE + dtb_ptr;
cpu.set_extraflags(3);

const MAX_CYCLES = parseInt(process.argv[2] || '500000000', 10);
const BATCH = 1024;

console.error(`Running Wasm emulator (up to ${MAX_CYCLES/1e6}M cycles, using buildDtb)...`);

let totalCycles = 0;
const t0 = performance.now();

for (let batch = 0; batch < MAX_CYCLES; batch += BATCH) {
  if (cpu.get_wait()) {
    const tl = cpu.get_mtime_lo(), th = cpu.get_mtime_hi();
    const ml = cpu.get_mtimecmp_lo(), mh = cpu.get_mtimecmp_hi();
    if ((mh !== 0 || ml !== 0) && ((th >>> 0) > (mh >>> 0) || ((th >>> 0) === (mh >>> 0) && (tl >>> 0) > (ml >>> 0)))) {
      cpu.clear_wait();
    } else {
      const newLo = (tl + BATCH) >>> 0;
      if (newLo < (tl >>> 0)) cpu.set_mtime(newLo, (th + 1) | 0);
      else cpu.set_mtime(newLo, th);
      totalCycles += BATCH;
      continue;
    }
  }

  {
    const tl = cpu.get_mtime_lo() >>> 0;
    const newLo = (tl + BATCH) >>> 0;
    cpu.set_mtime(newLo, newLo < tl ? ((cpu.get_mtime_hi() >>> 0) + 1) | 0 : cpu.get_mtime_hi());
  }

  cpu.step_batch(0, BATCH);
  totalCycles += BATCH;

  if (totalCycles % 5_000_000 === 0) {
    const elapsed = (performance.now() - t0) / 1000;
    const mips = totalCycles / elapsed / 1e6;
    console.error(`[${(totalCycles/1e6).toFixed(0)}M] pc=0x${(cpu.get_pc()>>>0).toString(16)} ${mips.toFixed(1)} MIPS, uart=${uartOut.length}`);
  }
}

const elapsed = (performance.now() - t0) / 1000;
console.error(`\nDone: ${totalCycles} cycles in ${elapsed.toFixed(1)}s (${(totalCycles/elapsed/1e6).toFixed(1)} MIPS)`);
