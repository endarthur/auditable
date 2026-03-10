// UART 16550 emulation — memory-mapped at 0x10000000

function createUart(onTx) {
  const rxQueue = [];
  let ier = 0, lcr = 0, mcr = 0, dll = 0, dlm = 0, scratch = 0;
  let dlab = false;

  return {
    rxQueue,
    read(offset) {
      offset &= 7;
      if (dlab && offset === 0) return dll;
      if (dlab && offset === 1) return dlm;
      switch (offset) {
        case 0: return rxQueue.length ? rxQueue.shift() : -1; // RBR: -1 = no data
        case 1: return ier;
        case 2: return rxQueue.length ? 0x04 : (ier & 2) ? 0x02 : 0x01; // IIR
        case 3: return lcr;
        case 4: return mcr;
        case 5: return 0x60 | (rxQueue.length ? 1 : 0); // LSR: TX empty + TX holding empty + data ready
        case 6: return 0; // MSR
        case 7: return scratch;
        default: return 0;
      }
    },
    write(offset, val) {
      offset &= 7;
      if (dlab && offset === 0) { dll = val; return; }
      if (dlab && offset === 1) { dlm = val; return; }
      switch (offset) {
        case 0: onTx(val & 0xFF); break; // THR
        case 1: ier = val; break;
        case 3: lcr = val; dlab = !!(val & 0x80); break;
        case 4: mcr = val; break;
        case 7: scratch = val; break;
      }
    },
    pushRx(ch) { rxQueue.push(ch & 0xFF); }
  };
}
