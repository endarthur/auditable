// JS port of Charles Lohr's mini-rv32ima (RV32IMA emulator)
// Original: https://github.com/cnlohr/mini-rv32ima
// License: BSD/MIT/CC0
//
// Usage:
//   import { createCPU } from './lohr.js';
//   const cpu = createCPU({ ramSize, ramBase, mmio_load, mmio_store });
//   cpu.loadImage(imageBytes, 0);
//   cpu.loadDTB(dtbBytes);
//   cpu.init();
//   while (running) cpu.step(1);

const STATE_SIZE = 192; // sizeof(MiniRV32IMAState): (32 + 16) * 4

export { STATE_SIZE, createCPU };

function createCPU({ ramSize = 64 * 1024 * 1024, ramBase = 0x80000000, mmio_load, mmio_store } = {}) {
  const ram = new Uint8Array(ramSize);
  const ram32 = new Uint32Array(ram.buffer);
  const ram16 = new Uint16Array(ram.buffer);
  const ramS8 = new Int8Array(ram.buffer);
  const ramS16 = new Int16Array(ram.buffer);

  const regs = new Int32Array(32);
  let pc = 0, mstatus = 0, cyclel = 0, cycleh = 0;
  let timerl = 0, timerh = 0, timermatchl = 0, timermatchh = 0;
  let mscratch = 0, mtvec = 0, mie = 0, mip = 0;
  let mepc = 0, mtval = 0, mcause = 0, extraflags = 0;

  function i32(v) { return v | 0; }
  function u32(v) { return v >>> 0; }

  // Default MMIO: UART 16550, CLINT, SYSCON
  if (!mmio_load) mmio_load = defaultMmioLoad;
  if (!mmio_store) mmio_store = defaultMmioStore;

  function defaultMmioLoad(addr) {
    addr = u32(addr);
    if (addr >= 0x10000000 && addr < 0x10000100) {
      if ((addr & 0xFF) === 5) return 0x60;
      return 0;
    }
    if (addr >= 0x11000000 && addr < 0x11010000) {
      const o = addr - 0x11000000;
      if (o === 0xBFF8) return timerl;
      if (o === 0xBFFC) return timerh;
      if (o === 0x4000) return timermatchl | 0;
      if (o === 0x4004) return timermatchh | 0;
      return 0;
    }
    return 0;
  }

  function defaultMmioStore(addr, val) {
    addr = u32(addr);
    if (addr >= 0x10000000 && addr < 0x10000100) return;
    if (addr >= 0x11000000 && addr < 0x11010000) {
      const o = addr - 0x11000000;
      if (o === 0x4000) timermatchl = u32(val);
      if (o === 0x4004) timermatchh = i32(val);
      return;
    }
  }

  function loadImage(bytes, offset) {
    ram.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset || 0);
  }

  function loadDTB(dtbBytes) {
    const dtb_ptr = ramSize - dtbBytes.length - STATE_SIZE;
    const copy = new Uint8Array(dtbBytes.length);
    copy.set(dtbBytes instanceof Uint8Array ? dtbBytes : new Uint8Array(dtbBytes.buffer, dtbBytes.byteOffset, dtbBytes.byteLength));
    const dv = new DataView(copy.buffer);
    if (dv.getUint32(0x13c) === 0x03ffc000) dv.setUint32(0x13c, dtb_ptr);
    ram.set(copy, dtb_ptr);
    return dtb_ptr;
  }

  function init(dtb_ptr) {
    if (dtb_ptr === undefined) dtb_ptr = ramSize - STATE_SIZE; // fallback if no DTB loaded
    pc = ramBase;
    regs[10] = 0;
    regs[11] = ramBase + dtb_ptr;
    extraflags = 3; // M-mode
  }

  function step(elapsedUs) {
    // Timer update
    const newTimer = u32(timerl + elapsedUs);
    if (newTimer < u32(timerl)) timerh = u32(timerh + 1);
    timerl = newTimer;

    // Timer interrupt check
    if ((u32(timerh) > u32(timermatchh) || (u32(timerh) === u32(timermatchh) && u32(timerl) > u32(timermatchl))) && (timermatchh !== 0 || timermatchl !== 0)) {
      extraflags &= ~4;
      mip |= 128;
    } else {
      mip &= ~128;
    }

    if (extraflags & 4) return 1; // WFI

    let trap = 0, rval = 0;
    let cycle = cyclel;

    if ((mip & 128) && (mie & 128) && (mstatus & 8)) {
      trap = 0x80000007;
      pc = u32(pc - 4);
    } else {
      let ir = 0;
      rval = 0;
      cycle = u32(cycle + 1);
      const ofs_pc = u32(pc - ramBase);

      if (ofs_pc >= ramSize) {
        trap = 1 + 1;
      } else if (ofs_pc & 3) {
        trap = 1 + 0;
      } else {
        ir = ram32[ofs_pc >>> 2];
        let rdid = (ir >>> 7) & 0x1f;

        switch (ir & 0x7f) {
          case 0x37: // LUI
            rval = ir & 0xfffff000;
            break;
          case 0x17: // AUIPC
            rval = u32(pc + i32(ir & 0xfffff000));
            break;
          case 0x6f: { // JAL
            let reladdy = ((ir & 0x80000000) >>> 11) | ((ir & 0x7fe00000) >>> 20) | ((ir & 0x00100000) >>> 9) | (ir & 0x000ff000);
            if (reladdy & 0x00100000) reladdy |= 0xffe00000;
            rval = u32(pc + 4);
            pc = u32(pc + i32(reladdy) - 4);
            break;
          }
          case 0x67: { // JALR
            let imm = ir >>> 20;
            const imm_se = i32(imm | ((imm & 0x800) ? 0xfffff000 : 0));
            rval = u32(pc + 4);
            pc = u32((i32(regs[(ir >>> 15) & 0x1f]) + imm_se) & ~1) - 4;
            break;
          }
          case 0x63: { // Branch
            let immm4 = ((ir & 0xf00) >>> 7) | ((ir & 0x7e000000) >>> 20) | ((ir & 0x80) << 4) | ((ir >>> 31) << 12);
            if (immm4 & 0x1000) immm4 |= 0xffffe000;
            const rs1 = regs[(ir >>> 15) & 0x1f];
            const rs2 = regs[(ir >>> 20) & 0x1f];
            immm4 = u32(pc + i32(immm4) - 4);
            rdid = 0;
            switch ((ir >>> 12) & 7) {
              case 0: if (rs1 === rs2) pc = immm4; break;
              case 1: if (rs1 !== rs2) pc = immm4; break;
              case 4: if (i32(rs1) < i32(rs2)) pc = immm4; break;
              case 5: if (i32(rs1) >= i32(rs2)) pc = immm4; break;
              case 6: if (u32(rs1) < u32(rs2)) pc = immm4; break;
              case 7: if (u32(rs1) >= u32(rs2)) pc = immm4; break;
              default: trap = 2 + 1;
            }
            break;
          }
          case 0x03: { // Load
            const rs1 = regs[(ir >>> 15) & 0x1f];
            let imm = ir >>> 20;
            const imm_se = i32(imm | ((imm & 0x800) ? 0xfffff000 : 0));
            let rsval = u32(i32(rs1) + imm_se);
            let ofs = u32(rsval - ramBase);
            if (ofs >= ramSize - 3) {
              if (rsval >= 0x10000000 && rsval < 0x12000000) {
                rval = mmio_load(rsval);
              } else {
                trap = 5 + 1;
                rval = rsval;
              }
            } else {
              switch ((ir >>> 12) & 7) {
                case 0: rval = ramS8[ofs]; break;
                case 1: rval = ramS16[ofs >>> 1]; break;
                case 2: rval = ram32[ofs >>> 2]; break;
                case 4: rval = ram[ofs]; break;
                case 5: rval = ram16[ofs >>> 1]; break;
                default: trap = 2 + 1;
              }
            }
            break;
          }
          case 0x23: { // Store
            const rs1 = regs[(ir >>> 15) & 0x1f];
            const rs2 = regs[(ir >>> 20) & 0x1f];
            let addy = ((ir >>> 7) & 0x1f) | ((ir & 0xfe000000) >>> 20);
            if (addy & 0x800) addy |= 0xfffff000;
            addy = u32(i32(addy) + i32(rs1) - ramBase);
            rdid = 0;
            if (u32(addy) >= ramSize - 3) {
              addy = u32(i32(addy) + ramBase);
              if (addy >= 0x10000000 && addy < 0x12000000) {
                mmio_store(addy, rs2);
              } else {
                trap = 7 + 1;
                rval = addy;
              }
            } else {
              switch ((ir >>> 12) & 7) {
                case 0: ram[addy] = rs2 & 0xff; break;
                case 1: ram16[addy >>> 1] = rs2 & 0xffff; break;
                case 2: ram32[addy >>> 2] = rs2; break;
                default: trap = 2 + 1;
              }
            }
            break;
          }
          case 0x13: // OP-IMM
          case 0x33: { // OP
            let imm = ir >>> 20;
            imm = imm | ((imm & 0x800) ? 0xfffff000 : 0);
            const rs1 = u32(regs[(ir >>> 15) & 0x1f]);
            const is_reg = !!(ir & 0x20);
            const rs2 = is_reg ? u32(regs[imm & 0x1f]) : u32(imm);
            if (is_reg && (ir & 0x02000000)) {
              // RV32M
              switch ((ir >>> 12) & 7) {
                case 0: rval = u32(Math.imul(i32(rs1), i32(rs2))); break;
                case 1: rval = u32(Number(BigInt(i32(rs1)) * BigInt(i32(rs2)) >> 32n)); break;
                case 2: rval = u32(Number(BigInt(i32(rs1)) * BigInt(u32(rs2)) >> 32n)); break;
                case 3: rval = u32(Number(BigInt(u32(rs1)) * BigInt(u32(rs2)) >> 32n)); break;
                case 4:
                  if (rs2 === 0) rval = 0xffffffff;
                  else if (i32(rs1) === (-2147483648 | 0) && i32(rs2) === -1) rval = rs1;
                  else rval = u32(i32(rs1) / i32(rs2) | 0);
                  break;
                case 5:
                  if (rs2 === 0) rval = 0xffffffff;
                  else rval = u32(u32(rs1) / u32(rs2));
                  break;
                case 6:
                  if (rs2 === 0) rval = rs1;
                  else if (i32(rs1) === (-2147483648 | 0) && i32(rs2) === -1) rval = 0;
                  else rval = u32(i32(rs1) % i32(rs2));
                  break;
                case 7:
                  if (rs2 === 0) rval = rs1;
                  else rval = u32(u32(rs1) % u32(rs2));
                  break;
              }
            } else {
              switch ((ir >>> 12) & 7) {
                case 0: rval = (is_reg && (ir & 0x40000000)) ? u32(rs1 - rs2) : u32(rs1 + rs2); break;
                case 1: rval = u32(rs1 << (rs2 & 0x1f)); break;
                case 2: rval = (i32(rs1) < i32(rs2)) ? 1 : 0; break;
                case 3: rval = (u32(rs1) < u32(rs2)) ? 1 : 0; break;
                case 4: rval = u32(rs1 ^ rs2); break;
                case 5: rval = (ir & 0x40000000) ? u32(i32(rs1) >> (rs2 & 0x1f)) : u32(rs1 >>> (rs2 & 0x1f)); break;
                case 6: rval = u32(rs1 | rs2); break;
                case 7: rval = u32(rs1 & rs2); break;
              }
            }
            break;
          }
          case 0x0f: // FENCE
            rdid = 0;
            break;
          case 0x73: { // SYSTEM
            const csrno = ir >>> 20;
            const microop = (ir >>> 12) & 7;
            if (microop & 3) {
              // Zicsr
              const rs1imm = (ir >>> 15) & 0x1f;
              const rs1 = regs[rs1imm];
              let writeval = rs1;
              switch (csrno) {
                case 0x340: rval = mscratch; break;
                case 0x305: rval = mtvec; break;
                case 0x304: rval = mie; break;
                case 0xC00: rval = cycle; break;
                case 0x344: rval = mip; break;
                case 0x341: rval = mepc; break;
                case 0x300: rval = mstatus; break;
                case 0x342: rval = mcause; break;
                case 0x343: rval = mtval; break;
                case 0xf11: rval = 0xff0ff0ff; break;
                case 0x301: rval = 0x40401101; break;
                case 0xf14: rval = 0; break;
                case 0xC01: rval = timerl; break;
                case 0xC80: rval = cycleh; break;
                case 0xC81: rval = timerh; break;
                default: rval = 0; break;
              }
              switch (microop) {
                case 1: writeval = rs1; break;
                case 2: writeval = rval | rs1; break;
                case 3: writeval = rval & ~rs1; break;
                case 5: writeval = rs1imm; break;
                case 6: writeval = rval | rs1imm; break;
                case 7: writeval = rval & ~rs1imm; break;
              }
              switch (csrno) {
                case 0x340: mscratch = writeval; break;
                case 0x305: mtvec = writeval; break;
                case 0x304: mie = writeval; break;
                case 0x344: mip = writeval; break;
                case 0x341: mepc = writeval; break;
                case 0x300: mstatus = writeval; break;
                case 0x342: mcause = writeval; break;
                case 0x343: mtval = writeval; break;
                default: break;
              }
            } else if (microop === 0) {
              rdid = 0;
              if ((csrno & 0xff) === 0x02) {
                // MRET
                const startmstatus = mstatus;
                const startextraflags = extraflags;
                mstatus = ((startmstatus & 0x80) >>> 4) | ((startextraflags & 3) << 11) | 0x80;
                extraflags = (startextraflags & ~3) | ((startmstatus >>> 11) & 3);
                pc = u32(mepc - 4);
              } else {
                switch (csrno) {
                  case 0:
                    trap = (extraflags & 3) ? (11 + 1) : (8 + 1);
                    break;
                  case 1:
                    trap = 3 + 1;
                    break;
                  case 0x105: // WFI
                    mstatus |= 8;
                    extraflags |= 4;
                    if (u32(cyclel) > u32(cycle)) cycleh = u32(cycleh + 1);
                    cyclel = cycle;
                    pc = u32(pc + 4);
                    return 1;
                  default:
                    trap = 2 + 1;
                    break;
                }
              }
            } else {
              trap = 2 + 1;
            }
            break;
          }
          case 0x2f: { // RV32A
            let rs1 = u32(regs[(ir >>> 15) & 0x1f]);
            let rs2 = u32(regs[(ir >>> 20) & 0x1f]);
            const irmid = (ir >>> 27) & 0x1f;
            rs1 = u32(rs1 - ramBase);
            if (rs1 >= ramSize - 3) {
              trap = 7 + 1;
              rval = u32(rs1 + ramBase);
            } else {
              rval = ram32[rs1 >>> 2];
              let dowrite = 1;
              switch (irmid) {
                case 2: dowrite = 0; extraflags = (extraflags & 0x07) | (rs1 << 3); break;
                case 3: rval = ((extraflags >>> 3) !== (rs1 & 0x1fffffff)) ? 1 : 0; dowrite = rval ? 0 : 1; break;
                case 1: break;
                case 0: rs2 = u32(rs2 + rval); break;
                case 4: rs2 = u32(rs2 ^ rval); break;
                case 12: rs2 = u32(rs2 & rval); break;
                case 8: rs2 = u32(rs2 | rval); break;
                case 16: rs2 = (i32(rs2) < i32(rval)) ? rs2 : rval; break;
                case 20: rs2 = (i32(rs2) > i32(rval)) ? rs2 : rval; break;
                case 24: rs2 = (u32(rs2) < u32(rval)) ? rs2 : rval; break;
                case 28: rs2 = (u32(rs2) > u32(rval)) ? rs2 : rval; break;
                default: trap = 2 + 1; dowrite = 0; break;
              }
              if (dowrite) ram32[rs1 >>> 2] = rs2;
            }
            break;
          }
          default:
            trap = 2 + 1;
        }

        if (trap) {
          // no writeback
        } else {
          if (rdid) regs[rdid] = i32(rval);
          pc = u32(pc + 4);
        }
      }
    }

    // Handle trap
    if (trap) {
      if (trap & 0x80000000) {
        mcause = trap;
        mtval = 0;
        pc = u32(pc + 4);
      } else {
        mcause = trap - 1;
        mtval = (trap > 5 && trap <= 8) ? rval : pc;
      }
      mepc = pc;
      mstatus = ((mstatus & 0x08) << 4) | ((extraflags & 3) << 11);
      pc = u32(mtvec - 4);
      extraflags |= 3;
      pc = u32(pc + 4);
    }

    if (u32(cyclel) > u32(cycle)) cycleh = u32(cycleh + 1);
    cyclel = cycle;
    regs[0] = 0;
    return 0;
  }

  return {
    step, loadImage, loadDTB, init,
    ram, ram32, regs,
    get pc() { return pc; }, set pc(v) { pc = v; },
    get mstatus() { return mstatus; }, set mstatus(v) { mstatus = v; },
    get mcause() { return mcause; }, get mepc() { return mepc; },
    get mtval() { return mtval; }, get mtvec() { return mtvec; },
    get mie() { return mie; }, get mip() { return mip; },
    get mscratch() { return mscratch; },
    get extraflags() { return extraflags; }, set extraflags(v) { extraflags = v; },
    get cyclel() { return cyclel; }, get cycleh() { return cycleh; },
    get timerl() { return timerl; }, get timerh() { return timerh; },
    get timermatchl() { return timermatchl; }, get timermatchh() { return timermatchh; },
    set timermatchl(v) { timermatchl = v; }, set timermatchh(v) { timermatchh = v; },
  };
}
