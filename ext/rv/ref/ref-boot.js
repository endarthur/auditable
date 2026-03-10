// Boot test: run the JS reference emulator (Lohr port) and capture UART output
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { createCPU } from './lohr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const imgBuf = fs.readFileSync(path.join(__dirname, 'images', 'Image.bin'));
const dtbBuf = fs.readFileSync(path.join(__dirname, 'sixtyfourmb.dtb'));

let uartOut = '';

const cpu = createCPU({
  mmio_load(addr) {
    addr = addr >>> 0;
    if (addr >= 0x10000000 && addr < 0x10000100) {
      if ((addr & 0xFF) === 5) return 0x60;
      if ((addr & 0xFF) === 0) return 0;
      return 0;
    }
    if (addr >= 0x11000000 && addr < 0x11010000) {
      const o = addr - 0x11000000;
      if (o === 0xBFF8) return cpu.timerl;
      if (o === 0xBFFC) return cpu.timerh;
      if (o === 0x4000) return cpu.timermatchl | 0;
      if (o === 0x4004) return cpu.timermatchh | 0;
      return 0;
    }
    return 0;
  },
  mmio_store(addr, val) {
    addr = addr >>> 0;
    if (addr >= 0x10000000 && addr < 0x10000100) {
      if ((addr & 0xFF) === 0) {
        const ch = String.fromCharCode(val & 0xff);
        uartOut += ch;
        process.stdout.write(ch);
      }
      return;
    }
    if (addr >= 0x11000000 && addr < 0x11010000) {
      const o = addr - 0x11000000;
      if (o === 0x4000) cpu.timermatchl = val >>> 0;
      if (o === 0x4004) cpu.timermatchh = val | 0;
      return;
    }
    if (addr === 0x11100000) {
      console.error(`\nSYSCON write: 0x${val.toString(16)} (${val === 0x5555 ? 'poweroff' : val === 0x7777 ? 'reboot' : 'unknown'})`);
      process.exit(0);
    }
  }
});

cpu.loadImage(imgBuf, 0);
const dtb_ptr = cpu.loadDTB(dtbBuf);
cpu.init(dtb_ptr);

const MAX_CYCLES = parseInt(process.argv[2] || '50000000', 10);
console.error(`Running reference emulator for up to ${MAX_CYCLES} cycles...`);

let totalCycles = 0;
const t0 = performance.now();

while (totalCycles < MAX_CYCLES) {
  cpu.step(1);
  totalCycles++;

  if (totalCycles % 5000000 === 0) {
    const elapsed = (performance.now() - t0) / 1000;
    const mips = totalCycles / elapsed / 1e6;
    console.error(`[${(totalCycles/1e6).toFixed(1)}M] pc=0x${(cpu.pc>>>0).toString(16)} ${mips.toFixed(1)} MIPS, uart=${uartOut.length} chars`);
  }
}

const elapsed = (performance.now() - t0) / 1000;
console.error(`\nDone: ${totalCycles} cycles in ${elapsed.toFixed(1)}s (${(totalCycles/elapsed/1e6).toFixed(1)} MIPS)`);
console.error(`UART output: ${uartOut.length} chars`);
if (uartOut.length > 0) {
  console.error('--- UART ---');
  console.error(uartOut.slice(0, 2000));
}
