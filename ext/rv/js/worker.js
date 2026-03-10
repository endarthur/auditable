// Web Worker — runs CPU + MMIO off the main thread
// Messages IN:  {type: 'boot', image: ArrayBuffer}
//               {type: 'key', ch: number}
//               {type: 'stop'}
// Messages OUT: {type: 'tx', chars: string}
//               {type: 'status', mips: string}
//               {type: 'halt', reason: string}
//               {type: 'ready'}
//               {type: 'booted'}

const RAM_SIZE = 64 * 1024 * 1024;
// RAM_BASE defined in elf.js
const STATE_SIZE = 192;
const BATCH_SIZE = 1024;
const TICK_MS = 50;
const TX_FLUSH_MS = 4;

// MessageChannel for zero-delay scheduling (setTimeout clamps to 4ms)
const schedCh = new MessageChannel();
let schedPending = false;
schedCh.port1.onmessage = () => { schedPending = false; if (running && !halted) tick(); };
function schedule() { if (!schedPending) { schedPending = true; schedCh.port2.postMessage(0); } }

let cpu, memory, uart, running = false, halted = false;
let totalCycles = 0;
let windowStart = 0, windowCycles = 0, lastMipsUpdate = 0;
let txBuf = '', txTimer = null;

function flushTx() {
  if (txBuf) { postMessage({ type: 'tx', chars: txBuf }); txBuf = ''; }
  txTimer = null;
}

function onTx(ch) {
  txBuf += String.fromCharCode(ch);
  if (!txTimer) txTimer = setTimeout(flushTx, TX_FLUSH_MS);
}

function advanceMtime(ticks) {
  const lo = cpu.get_mtime_lo() >>> 0;
  const newLo = (lo + ticks) >>> 0;
  cpu.set_mtime(newLo, newLo < lo ? ((cpu.get_mtime_hi() >>> 0) + 1) | 0 : cpu.get_mtime_hi());
}

let mtimecmp_lo = 0xFFFFFFFF, mtimecmp_hi = 0x7FFFFFFF;

function mmio_read(addr) {
  addr = addr >>> 0;
  if (addr >= 0x10000000 && addr < 0x10000100) return uart.read(addr - 0x10000000);
  if (addr >= 0x11000000 && addr < 0x11010000) {
    const off = addr - 0x11000000;
    if (off === 0xBFF8) return cpu.get_mtime_lo();
    if (off === 0xBFFC) return cpu.get_mtime_hi();
    if (off === 0x4000) return mtimecmp_lo | 0;
    if (off === 0x4004) return mtimecmp_hi | 0;
    return 0;
  }
  return 0;
}

function mmio_write(addr, val) {
  addr = addr >>> 0;
  if (addr >= 0x10000000 && addr < 0x10000100) { uart.write(addr - 0x10000000, val); return; }
  if (addr >= 0x11000000 && addr < 0x11010000) {
    const off = addr - 0x11000000;
    if (off === 0x4000) { mtimecmp_lo = val >>> 0; cpu.set_mtimecmp(mtimecmp_lo, mtimecmp_hi); }
    if (off === 0x4004) { mtimecmp_hi = val | 0; cpu.set_mtimecmp(mtimecmp_lo, mtimecmp_hi); }
    return;
  }
  if (addr >= 0x11100000 && addr < 0x11200000) {
    if (val === 0x5555) { halted = true; running = false; flushTx(); postMessage({ type: 'halt', reason: 'poweroff' }); }
    if (val === 0x7777) { halted = true; running = false; flushTx(); postMessage({ type: 'halt', reason: 'reboot' }); }
  }
}

const BATCHES_PER_TICK = 512;  // 512 * 1024 = ~524k instructions per tick

function tick() {
  if (!running || halted) return;
  let rc = 0;
  for (let i = 0; i < BATCHES_PER_TICK; i++) {
    advanceMtime(BATCH_SIZE);
    rc = cpu.step_batch(0, BATCH_SIZE);
    totalCycles += BATCH_SIZE;
    windowCycles += BATCH_SIZE;
    if (rc === 1 || rc === 2 || halted) break;
  }
  // Status update (~2x per second, sliding window)
  const now = performance.now();
  if (now - lastMipsUpdate > 500) {
    const dt = (now - windowStart) / 1000;
    if (dt > 0) postMessage({ type: 'status', mips: ((windowCycles / dt) / 1000000).toFixed(1) });
    windowStart = now;
    windowCycles = 0;
    lastMipsUpdate = now;
  }
  if (halted) return;
  if (rc === 2) { halted = true; running = false; flushTx(); postMessage({ type: 'halt', reason: 'poweroff' }); return; }
  if (rc === 1) {
    advanceMtime(100000);
    cpu.clear_wait();
    setTimeout(tick, 10);
  } else {
    schedule();
  }
}

self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type === 'boot') {
    // Stop any previous run
    running = false;

    // 1. Create memory
    const totalPages = (RAM_SIZE / 65536) + 1;
    memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages });

    // 2. Create UART
    uart = createUart(onTx);

    // 3. Instantiate CPU
    cpu = instantiate({ memory, mmio_read, mmio_write });
    cpu.set_ram_size(RAM_SIZE);

    // 4. Load image
    const mem8 = new Uint8Array(memory.buffer);
    const imageBuffer = msg.image;
    let entry;
    const magic = new DataView(imageBuffer).getUint32(0, false);
    if (magic === 0x7f454c46) {
      entry = loadElf(imageBuffer, mem8);
    } else {
      mem8.set(new Uint8Array(imageBuffer), 0);
      entry = RAM_BASE;
    }

    // 5. Generate DTB
    const bootArgs = 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0';
    const dtbEst = buildDtb({ ramBase: RAM_BASE, ramSize: RAM_SIZE - 1024 - STATE_SIZE, bootArgs });
    const dtb_ptr = RAM_SIZE - dtbEst.length - STATE_SIZE;
    const dtb = buildDtb({ ramBase: RAM_BASE, ramSize: dtb_ptr, bootArgs });
    mem8.set(dtb, dtb_ptr);

    // 6. Set initial state
    cpu.set_pc(entry);
    const regs = new Int32Array(memory.buffer, RAM_SIZE, 32);
    regs[10] = 0;
    regs[11] = RAM_BASE + dtb_ptr;
    cpu.set_extraflags(3);

    // 7. Start
    running = true;
    halted = false;
    totalCycles = 0;
    windowStart = performance.now();
    windowCycles = 0;
    lastMipsUpdate = 0;
    mtimecmp_lo = 0xFFFFFFFF;
    mtimecmp_hi = 0x7FFFFFFF;
    txBuf = '';
    postMessage({ type: 'booted' });
    schedule();

  } else if (msg.type === 'key') {
    if (uart) uart.pushRx(msg.ch);

  } else if (msg.type === 'stop') {
    running = false;
    flushTx();
  }
};

postMessage({ type: 'ready' });
