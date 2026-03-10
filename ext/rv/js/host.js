// Run loop, MMIO dispatch, timer

const BATCH_SIZE = 1024;
const FRAME_MS = 12; // time budget per frame

function createHost(cpu, memory, uart, { onHalt, onStatus } = {}) {
  let running = false;
  let halted = false;
  let startTime = 0;
  let totalCycles = 0;
  let rafId = null;
  let timeoutId = null;
  let mtimecmp_lo = 0xFFFFFFFF;
  let mtimecmp_hi = 0x7FFFFFFF;

  function clint_read(off) {
    if (off === 0xBFF8) return cpu.get_mtime_lo();
    if (off === 0xBFFC) return cpu.get_mtime_hi();
    if (off === 0x4000) return mtimecmp_lo | 0;
    if (off === 0x4004) return mtimecmp_hi | 0;
    return 0;
  }

  function clint_write(off, val) {
    if (off === 0x4000) { mtimecmp_lo = val >>> 0; cpu.set_mtimecmp(mtimecmp_lo, mtimecmp_hi); }
    if (off === 0x4004) { mtimecmp_hi = val | 0; cpu.set_mtimecmp(mtimecmp_lo, mtimecmp_hi); }
  }

  function mmio_read(addr) {
    addr = addr >>> 0;
    if (addr >= 0x10000000 && addr < 0x10000100) return uart.read(addr - 0x10000000);
    if (addr >= 0x11000000 && addr < 0x11010000) return clint_read(addr - 0x11000000);
    if (addr >= 0x11100000 && addr < 0x11200000) return 0;
    return 0;
  }

  function mmio_write(addr, val) {
    addr = addr >>> 0;
    if (addr >= 0x10000000 && addr < 0x10000100) { uart.write(addr - 0x10000000, val); return; }
    if (addr >= 0x11000000 && addr < 0x11010000) { clint_write(addr - 0x11000000, val); return; }
    if (addr >= 0x11100000 && addr < 0x11200000) {
      if (val === 0x5555) { halted = true; running = false; onHalt?.('poweroff'); }
      if (val === 0x7777) { halted = true; running = false; onHalt?.('reboot'); }
      return;
    }
  }

  function advanceMtime(ticks) {
    const lo = cpu.get_mtime_lo() >>> 0;
    const newLo = (lo + ticks) >>> 0;
    cpu.set_mtime(newLo, newLo < lo ? ((cpu.get_mtime_hi() >>> 0) + 1) | 0 : cpu.get_mtime_hi());
  }

  function tick() {
    if (!running || halted) return;
    let rc = 0;
    const deadline = performance.now() + FRAME_MS;
    while (performance.now() < deadline) {
      advanceMtime(BATCH_SIZE);
      rc = cpu.step_batch(0, BATCH_SIZE);
      totalCycles += BATCH_SIZE;
      if (rc === 1 || rc === 2 || halted) break;
    }
    if (onStatus) {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed > 0) onStatus(((totalCycles / elapsed) / 1000000).toFixed(1));
    }
    if (halted) return;
    if (rc === 2) { halted = true; running = false; onHalt?.('poweroff'); return; }
    if (rc === 1) {
      // WFI: advance mtime by ~10ms worth of ticks (10MHz timebase)
      advanceMtime(100000);
      cpu.clear_wait();
      timeoutId = setTimeout(tick, 10);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  return {
    mmio_read,
    mmio_write,
    start() {
      if (running) return;
      running = true;
      halted = false;
      startTime = performance.now();
      totalCycles = 0;
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    },
    get running() { return running; },
    get halted() { return halted; },
    get cycles() { return totalCycles; }
  };
}
