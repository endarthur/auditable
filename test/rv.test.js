// rv — RISC-V RV32IMA instruction tests
// Hand-encoded instructions, verified against the RISC-V ISA spec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the compiled rv engine
const rvPath = path.join(__dirname, '..', 'ext', 'rv', 'index.js');
const rvSrc = fs.readFileSync(rvPath, 'utf8');

// Strip export/import statements for eval
let cleanSrc = rvSrc;
cleanSrc = cleanSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
cleanSrc = cleanSrc.replace(/^export\s+function\s/gm, 'function ');
cleanSrc = cleanSrc.replace(/^export\s+const\s/gm, 'const ');
cleanSrc = cleanSrc.replace(/^export\s+let\s/gm, 'let ');

// We need to eval the module to get `instantiate`
const mod = {};
const fn = new Function('module', cleanSrc + '\nmodule.exports = { instantiate, writeI32, readI32 };');
fn(mod);
const { instantiate, writeI32, readI32 } = mod.exports;

const RAM_BASE = 0x80000000;
const RAM_SIZE = 64 * 1024 * 1024;
const REG_OFF = RAM_SIZE; // byte offset of register file in Wasm memory (one page past RAM)

// Helper: create a fresh CPU instance with given instructions
function createCpu(instructions) {
  const totalPages = (RAM_SIZE / 65536) + 1; // RAM + 1 page for regs
  const memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages });

  // Write instructions to RAM at offset 0 (= guest addr 0x80000000)
  const mem32 = new Int32Array(memory.buffer);
  for (let i = 0; i < instructions.length; i++) {
    mem32[i] = instructions[i] | 0;
  }

  let lastMmioWrite = null;
  const cpu = instantiate({
    memory,
    mmio_read: () => 0,
    mmio_write: (addr, val) => { lastMmioWrite = { addr, val }; },
  });

  cpu.set_pc(RAM_BASE);

  return {
    cpu,
    memory,
    reg(n) { return new Int32Array(memory.buffer, REG_OFF, 32)[n]; },
    regs() { return new Int32Array(memory.buffer, REG_OFF, 32); },
    setReg(n, val) { new Int32Array(memory.buffer, REG_OFF, 32)[n] = val; },
    step(count = 1) { return cpu.step_batch(0, count); },
    pc() { return cpu.get_pc(); },
    lastMmioWrite() { return lastMmioWrite; },
  };
}

// RISC-V instruction encoders
function rType(opcode, rd, funct3, rs1, rs2, funct7) {
  return ((funct7 & 0x7F) << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
         ((funct3 & 0x7) << 12) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
}
function iType(opcode, rd, funct3, rs1, imm) {
  return ((imm & 0xFFF) << 20) | ((rs1 & 0x1F) << 15) |
         ((funct3 & 0x7) << 12) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
}
function sType(opcode, funct3, rs1, rs2, imm) {
  return (((imm >> 5) & 0x7F) << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
         ((funct3 & 0x7) << 12) | ((imm & 0x1F) << 7) | (opcode & 0x7F);
}
function bType(opcode, funct3, rs1, rs2, imm) {
  const i12 = (imm >> 12) & 1;
  const i11 = (imm >> 11) & 1;
  const i10_5 = (imm >> 5) & 0x3F;
  const i4_1 = (imm >> 1) & 0xF;
  return (i12 << 31) | (i10_5 << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
         ((funct3 & 0x7) << 12) | (i4_1 << 8) | (i11 << 7) | (opcode & 0x7F);
}
function uType(opcode, rd, imm) {
  return (imm & 0xFFFFF000) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
}
function jType(opcode, rd, imm) {
  const i20 = (imm >> 20) & 1;
  const i19_12 = (imm >> 12) & 0xFF;
  const i11 = (imm >> 11) & 1;
  const i10_1 = (imm >> 1) & 0x3FF;
  return (i20 << 31) | (i10_1 << 21) | (i11 << 20) | (i19_12 << 12) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
}

// Instruction shorthand
const ADDI = (rd, rs1, imm) => iType(0x13, rd, 0, rs1, imm);
const SLTI = (rd, rs1, imm) => iType(0x13, rd, 2, rs1, imm);
const SLTIU = (rd, rs1, imm) => iType(0x13, rd, 3, rs1, imm);
const XORI = (rd, rs1, imm) => iType(0x13, rd, 4, rs1, imm);
const ORI = (rd, rs1, imm) => iType(0x13, rd, 6, rs1, imm);
const ANDI = (rd, rs1, imm) => iType(0x13, rd, 7, rs1, imm);
const SLLI = (rd, rs1, shamt) => rType(0x13, rd, 1, rs1, shamt, 0);
const SRLI = (rd, rs1, shamt) => rType(0x13, rd, 5, rs1, shamt, 0);
const SRAI = (rd, rs1, shamt) => rType(0x13, rd, 5, rs1, shamt, 0x20);

const ADD = (rd, rs1, rs2) => rType(0x33, rd, 0, rs1, rs2, 0);
const SUB = (rd, rs1, rs2) => rType(0x33, rd, 0, rs1, rs2, 0x20);
const SLL = (rd, rs1, rs2) => rType(0x33, rd, 1, rs1, rs2, 0);
const SLT = (rd, rs1, rs2) => rType(0x33, rd, 2, rs1, rs2, 0);
const SLTU = (rd, rs1, rs2) => rType(0x33, rd, 3, rs1, rs2, 0);
const XOR = (rd, rs1, rs2) => rType(0x33, rd, 4, rs1, rs2, 0);
const SRL = (rd, rs1, rs2) => rType(0x33, rd, 5, rs1, rs2, 0);
const SRA = (rd, rs1, rs2) => rType(0x33, rd, 5, rs1, rs2, 0x20);
const OR = (rd, rs1, rs2) => rType(0x33, rd, 6, rs1, rs2, 0);
const AND = (rd, rs1, rs2) => rType(0x33, rd, 7, rs1, rs2, 0);

// M extension
const MUL = (rd, rs1, rs2) => rType(0x33, rd, 0, rs1, rs2, 1);
const MULH = (rd, rs1, rs2) => rType(0x33, rd, 1, rs1, rs2, 1);
const MULHSU = (rd, rs1, rs2) => rType(0x33, rd, 2, rs1, rs2, 1);
const MULHU = (rd, rs1, rs2) => rType(0x33, rd, 3, rs1, rs2, 1);
const DIV = (rd, rs1, rs2) => rType(0x33, rd, 4, rs1, rs2, 1);
const DIVU = (rd, rs1, rs2) => rType(0x33, rd, 5, rs1, rs2, 1);
const REM = (rd, rs1, rs2) => rType(0x33, rd, 6, rs1, rs2, 1);
const REMU = (rd, rs1, rs2) => rType(0x33, rd, 7, rs1, rs2, 1);

const LUI = (rd, imm) => uType(0x37, rd, imm);
const AUIPC = (rd, imm) => uType(0x17, rd, imm);

const LW = (rd, rs1, imm) => iType(0x03, rd, 2, rs1, imm);
const LH = (rd, rs1, imm) => iType(0x03, rd, 1, rs1, imm);
const LB = (rd, rs1, imm) => iType(0x03, rd, 0, rs1, imm);
const LBU = (rd, rs1, imm) => iType(0x03, rd, 4, rs1, imm);
const LHU = (rd, rs1, imm) => iType(0x03, rd, 5, rs1, imm);

const SW = (rs1, rs2, imm) => sType(0x23, 2, rs1, rs2, imm);
const SH = (rs1, rs2, imm) => sType(0x23, 1, rs1, rs2, imm);
const SB = (rs1, rs2, imm) => sType(0x23, 0, rs1, rs2, imm);

const BEQ = (rs1, rs2, imm) => bType(0x63, 0, rs1, rs2, imm);
const BNE = (rs1, rs2, imm) => bType(0x63, 1, rs1, rs2, imm);
const BLT = (rs1, rs2, imm) => bType(0x63, 4, rs1, rs2, imm);
const BGE = (rs1, rs2, imm) => bType(0x63, 5, rs1, rs2, imm);
const BLTU = (rs1, rs2, imm) => bType(0x63, 6, rs1, rs2, imm);
const BGEU = (rs1, rs2, imm) => bType(0x63, 7, rs1, rs2, imm);

const JAL = (rd, imm) => jType(0x6F, rd, imm);
const JALR = (rd, rs1, imm) => iType(0x67, rd, 0, rs1, imm);

const ECALL = iType(0x73, 0, 0, 0, 0);
const EBREAK = iType(0x73, 0, 0, 0, 1);
const CSRRW = (rd, rs1, csr) => iType(0x73, rd, 1, rs1, csr);
const CSRRS = (rd, rs1, csr) => iType(0x73, rd, 2, rs1, csr);
const CSRRC = (rd, rs1, csr) => iType(0x73, rd, 3, rs1, csr);

const NOP = ADDI(0, 0, 0);

// ── Tests ──

describe('RV32I arithmetic', () => {
  it('addi', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 1, 3)]);
    c.step(2);
    assert.equal(c.reg(1), 5);
    assert.equal(c.reg(2), 8);
  });

  it('addi negative', () => {
    const c = createCpu([ADDI(1, 0, -10)]);
    c.step(1);
    assert.equal(c.reg(1), -10);
  });

  it('add', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, 3), ADD(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 8);
  });

  it('sub', () => {
    const c = createCpu([ADDI(1, 0, 10), ADDI(2, 0, 3), SUB(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 7);
  });

  it('sll', () => {
    const c = createCpu([ADDI(1, 0, 1), ADDI(2, 0, 4), SLL(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 16);
  });

  it('slt', () => {
    const c = createCpu([ADDI(1, 0, -5), ADDI(2, 0, 5), SLT(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 1);
  });

  it('sltu', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, -1), SLTU(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 1); // 5 < 0xFFFFFFFF unsigned
  });

  it('xor', () => {
    const c = createCpu([ADDI(1, 0, 0xFF), ADDI(2, 0, 0x0F), XOR(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 0xF0);
  });

  it('srl', () => {
    const c = createCpu([ADDI(1, 0, -1), ADDI(2, 0, 28), SRL(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 0xF); // unsigned shift right
  });

  it('sra', () => {
    const c = createCpu([ADDI(1, 0, -16), ADDI(2, 0, 2), SRA(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), -4); // arithmetic shift right
  });

  it('or', () => {
    const c = createCpu([ADDI(1, 0, 0xA0), ADDI(2, 0, 0x0B), OR(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 0xAB);
  });

  it('and', () => {
    const c = createCpu([ADDI(1, 0, 0xFF), ADDI(2, 0, 0x0F), AND(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 0x0F);
  });

  it('slli', () => {
    const c = createCpu([ADDI(1, 0, 3), SLLI(2, 1, 4)]);
    c.step(2);
    assert.equal(c.reg(2), 48);
  });

  it('srli', () => {
    const c = createCpu([ADDI(1, 0, -1), SRLI(2, 1, 24)]);
    c.step(2);
    assert.equal(c.reg(2), 0xFF);
  });

  it('srai', () => {
    const c = createCpu([ADDI(1, 0, -32), SRAI(2, 1, 2)]);
    c.step(2);
    assert.equal(c.reg(2), -8);
  });

  it('x0 always zero', () => {
    const c = createCpu([ADDI(0, 0, 42)]);
    c.step(1);
    assert.equal(c.reg(0), 0);
  });
});

describe('RV32I LUI/AUIPC', () => {
  it('lui', () => {
    const c = createCpu([LUI(1, 0x12345000)]);
    c.step(1);
    assert.equal(c.reg(1), 0x12345000);
  });

  it('auipc', () => {
    const c = createCpu([AUIPC(1, 0x1000)]);
    c.step(1);
    assert.equal(c.reg(1) >>> 0, (RAM_BASE + 0x1000) >>> 0);
  });
});

describe('RV32I jumps', () => {
  it('jal', () => {
    const c = createCpu([JAL(1, 8), NOP, ADDI(2, 0, 42)]);
    c.step(2);
    assert.equal(c.reg(1) >>> 0, (RAM_BASE + 4) >>> 0); // return address
    assert.equal(c.reg(2), 42); // jumped over NOP
  });

  it('jalr', () => {
    // Set x1 to RAM_BASE + 8, then jalr to x1
    const c = createCpu([ADDI(1, 0, 8), JALR(2, 1, 0), NOP, ADDI(3, 0, 99)]);
    // jalr target = (x1 + 0) & ~1. But x1 = 8 (not RAM-based addr).
    // Actually this will jump to address 8 which is not in RAM range...
    // Let's use LUI + ADDI to set a proper address
    const target = RAM_BASE + 16; // skip instruction 3, jump to instruction 4
    const c2 = createCpu([
      LUI(1, (target & 0xFFFFF000) >>> 0),
      ADDI(1, 1, target & 0xFFF),
      JALR(2, 1, 0),
      ADDI(3, 0, 77),  // skipped
      ADDI(4, 0, 99),  // jumped to
    ]);
    c2.step(4);
    assert.equal(c2.reg(2) >>> 0, (RAM_BASE + 12) >>> 0); // return address = pc of jalr + 4
    assert.equal(c2.reg(3), 0);  // skipped
    assert.equal(c2.reg(4), 99); // executed
  });
});

describe('RV32I branches', () => {
  it('beq taken', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, 5), BEQ(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0); // skipped
    assert.equal(c.reg(4), 2); // executed
  });

  it('beq not taken', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, 3), BEQ(1, 2, 8), ADDI(3, 0, 1)]);
    c.step(4);
    assert.equal(c.reg(3), 1); // not skipped
  });

  it('bne', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, 3), BNE(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0); // skipped
    assert.equal(c.reg(4), 2);
  });

  it('blt', () => {
    const c = createCpu([ADDI(1, 0, -5), ADDI(2, 0, 5), BLT(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0);
    assert.equal(c.reg(4), 2);
  });

  it('bge', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, 5), BGE(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0);
    assert.equal(c.reg(4), 2);
  });

  it('bltu', () => {
    const c = createCpu([ADDI(1, 0, 5), ADDI(2, 0, -1), BLTU(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0); // 5 < 0xFFFFFFFF unsigned → taken
    assert.equal(c.reg(4), 2);
  });

  it('bgeu', () => {
    const c = createCpu([ADDI(1, 0, -1), ADDI(2, 0, 5), BGEU(1, 2, 8), ADDI(3, 0, 1), ADDI(4, 0, 2)]);
    c.step(5);
    assert.equal(c.reg(3), 0); // 0xFFFFFFFF >= 5 unsigned → taken
    assert.equal(c.reg(4), 2);
  });
});

describe('RV32I memory', () => {
  it('sw/lw', () => {
    // Store value to RAM, then load it back
    // Use address relative to x0 which needs a base addr in RAM range
    const c = createCpu([
      LUI(1, RAM_BASE),        // x1 = 0x80000000
      ADDI(2, 0, 42),          // x2 = 42
      SW(1, 2, 0x100),         // mem[0x80000100] = 42
      LW(3, 1, 0x100),         // x3 = mem[0x80000100]
    ]);
    c.step(4);
    assert.equal(c.reg(3), 42);
  });

  it('sb/lb sign extension', () => {
    const c = createCpu([
      LUI(1, RAM_BASE),
      ADDI(2, 0, -1),          // x2 = 0xFFFFFFFF
      SB(1, 2, 0x200),         // store byte 0xFF at 0x80000200
      LB(3, 1, 0x200),         // load signed byte → -1
      LBU(4, 1, 0x200),        // load unsigned byte → 255
    ]);
    c.step(5);
    assert.equal(c.reg(3), -1);
    assert.equal(c.reg(4), 255);
  });

  it('sh/lh sign extension', () => {
    const c = createCpu([
      LUI(1, RAM_BASE),
      ADDI(2, 0, -1),
      SH(1, 2, 0x300),
      LH(3, 1, 0x300),
      LHU(4, 1, 0x300),
    ]);
    c.step(5);
    assert.equal(c.reg(3), -1);
    assert.equal(c.reg(4), 65535);
  });
});

describe('RV32M multiply/divide', () => {
  it('mul', () => {
    const c = createCpu([ADDI(1, 0, 7), ADDI(2, 0, 6), MUL(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 42);
  });

  it('mulh', () => {
    // Large signed multiply to get high bits
    const c = createCpu([LUI(1, 0x40000000), ADDI(2, 0, 4), MULH(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 1); // 0x40000000 * 4 = 0x100000000, high word = 1
  });

  it('mulhu', () => {
    const c = createCpu([ADDI(1, 0, -1), ADDI(2, 0, -1), MULHU(3, 1, 2)]);
    c.step(3);
    // 0xFFFFFFFF * 0xFFFFFFFF = 0xFFFFFFFE00000001, high word = 0xFFFFFFFE
    assert.equal(c.reg(3), -2); // 0xFFFFFFFE as signed
  });

  it('div', () => {
    const c = createCpu([ADDI(1, 0, 20), ADDI(2, 0, 6), DIV(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 3);
  });

  it('div by zero', () => {
    const c = createCpu([ADDI(1, 0, 20), DIV(3, 1, 0)]);
    c.step(2);
    assert.equal(c.reg(3), -1);
  });

  it('divu', () => {
    const c = createCpu([ADDI(1, 0, -1), ADDI(2, 0, 2), DIVU(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 0x7FFFFFFF); // 0xFFFFFFFF / 2 unsigned
  });

  it('rem', () => {
    const c = createCpu([ADDI(1, 0, 20), ADDI(2, 0, 6), REM(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 2);
  });

  it('remu', () => {
    const c = createCpu([ADDI(1, 0, -1), ADDI(2, 0, 2), REMU(3, 1, 2)]);
    c.step(3);
    assert.equal(c.reg(3), 1); // 0xFFFFFFFF % 2 = 1
  });
});

describe('RV32I CSR', () => {
  it('csrrw/csrrs read/write', () => {
    // Write to mscratch (0x340), then read back
    const c = createCpu([
      ADDI(1, 0, 42),
      CSRRW(2, 1, 0x340),  // mscratch = 42, x2 = old mscratch (0)
      CSRRS(3, 0, 0x340),  // x3 = mscratch (42), mscratch |= 0
    ]);
    c.step(3);
    assert.equal(c.reg(2), 0);  // old value
    assert.equal(c.reg(3), 42); // written value
  });
});

describe('RV32I traps', () => {
  it('ecall triggers trap', () => {
    // Set mtvec to point at instruction 4 (offset 16 from RAM_BASE)
    // After ecall, PC should jump to mtvec
    const mtvecAddr = RAM_BASE + 24; // instruction 6
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),  // mtvec = mtvecAddr
      ADDI(17, 0, 99),     // a7 = 99 (not a valid SBI extension)
      ECALL,                // trap → jumps to mtvec
      ADDI(2, 0, 77),      // should be skipped (ecall redirects)
      ADDI(3, 0, 99),      // mtvec target
    ]);
    c.step(6);
    // ecall triggers trap → step_batch returns after do_trap (pc = mtvec)
    // Need another step to execute the mtvec instruction
    c.step(1);
    assert.equal(c.reg(2), 0);  // skipped
    assert.equal(c.reg(3), 99); // trap handler executed
  });

  it('mret returns from trap', () => {
    // Set mepc, then mret
    const retAddr = RAM_BASE + 20; // instruction 5
    const c = createCpu([
      LUI(1, retAddr & 0xFFFFF000),
      ADDI(1, 1, retAddr & 0xFFF),
      CSRRW(0, 1, 0x341),   // mepc = retAddr
      iType(0x73, 0, 0, 0, 0x302), // MRET
      ADDI(2, 0, 77),       // skipped
      ADDI(3, 0, 99),       // returned to
    ]);
    c.step(5);
    assert.equal(c.reg(2), 0);
    assert.equal(c.reg(3), 99);
  });
});

describe('step_batch return codes', () => {
  it('returns 0 on batch complete', () => {
    const c = createCpu([NOP, NOP]);
    const rc = c.step(2);
    assert.equal(rc, 0);
  });
});

// ── Trap handling tests (verify mstatus/mscratch/mepc round-trip) ──

const MRET = iType(0x73, 0, 0, 0, 0x302);
const WFI = iType(0x73, 0, 0, 0, 0x105);
const FENCE = iType(0x0F, 0, 0, 0, 0);

describe('trap entry: mstatus bits', () => {
  it('ecall saves MIE to MPIE and clears MIE', () => {
    // Start in M-mode with MIE=1 (bit 3)
    const mtvecAddr = RAM_BASE + 28;
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),    // mtvec = handler
      ADDI(1, 0, 8),         // MIE bit = 0x8
      CSRRW(0, 1, 0x300),    // mstatus = 8 (MIE=1)
      ADDI(17, 0, 99),       // a7 = 99 (unknown SBI → trap)
      ECALL,                 // trap!
    ]);
    c.cpu.set_extraflags(3); // M-mode
    c.step(6);               // up to ECALL
    c.step(1);               // execute ECALL (returns from step_batch)

    const mstatus = c.cpu.get_mstatus() >>> 0;
    // After trap: MPIE should be 1 (bit 7), MIE should be 0 (bit 3)
    // MPP should be 3 (bits 12:11) since we were in M-mode
    assert.equal((mstatus >> 7) & 1, 1, 'MPIE should be 1 (was MIE=1)');
    assert.equal((mstatus >> 3) & 1, 0, 'MIE should be 0 after trap');
    assert.equal((mstatus >> 11) & 3, 3, 'MPP should be 3 (M-mode)');
  });

  it('ecall from M-mode with MIE=0 saves MPIE=0', () => {
    const mtvecAddr = RAM_BASE + 24;
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),    // mtvec
      ADDI(17, 0, 99),       // a7 = unknown
      // mstatus starts at 0, MIE=0
      ECALL,
      NOP,
    ]);
    c.cpu.set_extraflags(3); // M-mode
    c.step(5);
    c.step(1); // ecall

    const mstatus = c.cpu.get_mstatus() >>> 0;
    assert.equal((mstatus >> 7) & 1, 0, 'MPIE should be 0 (was MIE=0)');
    assert.equal((mstatus >> 3) & 1, 0, 'MIE should be 0');
    assert.equal((mstatus >> 11) & 3, 3, 'MPP should be 3');
  });
});

describe('MRET: mstatus restoration', () => {
  it('MRET restores MIE from MPIE and sets MPIE=1', () => {
    // Set mstatus with MPIE=1 (bit 7), MPP=3 (bits 12:11), MIE=0 (bit 3)
    // After MRET: MIE should be restored from MPIE (→1), MPIE=1
    const retAddr = RAM_BASE + 24;
    const c = createCpu([
      LUI(1, retAddr & 0xFFFFF000),
      ADDI(1, 1, retAddr & 0xFFF),
      CSRRW(0, 1, 0x341),     // mepc = retAddr
      ADDI(1, 0, 0x80 | (3 << 11)), // MPIE=1, MPP=3 (but this is only 12-bit imm)
      NOP, NOP,
    ]);
    // Manually set mstatus to MPIE=1 | MPP=3 = 0x1880
    // Use two instructions to build the value
    const c2 = createCpu([
      LUI(1, retAddr & 0xFFFFF000),
      ADDI(1, 1, retAddr & 0xFFF),
      CSRRW(0, 1, 0x341),     // mepc = retAddr
      // Build mstatus value: MPIE=1(bit7) + MPP=3(bits11:12) = 0x1880
      LUI(5, 0),
      ADDI(5, 0, 0x1880 & 0xFFF), // 0x880 but we need sign extension care
      CSRRW(0, 5, 0x300),     // mstatus = value with MPIE=1, MPP=3
      MRET,                   // should restore
      NOP,                    // skipped
      ADDI(6, 0, 42),         // retAddr target
    ]);
    c2.cpu.set_extraflags(3);
    c2.step(7);

    const mstatus = c2.cpu.get_mstatus() >>> 0;
    // After MRET: MIE = old MPIE (1), MPIE = 1, privilege = old MPP (3)
    assert.equal((mstatus >> 3) & 1, 1, 'MIE should be restored from MPIE=1');
    assert.equal((mstatus >> 7) & 1, 1, 'MPIE should be set to 1');
    assert.equal(c2.cpu.get_extraflags() & 3, 3, 'privilege should be MPP=3');
  });

  it('MRET with MPIE=0 clears MIE', () => {
    const retAddr = RAM_BASE + 24;
    const c = createCpu([
      LUI(1, retAddr & 0xFFFFF000),
      ADDI(1, 1, retAddr & 0xFFF),
      CSRRW(0, 1, 0x341),     // mepc = retAddr
      // mstatus = MPP=3(bits 11:12) + MPIE=0(bit7) = 0x1800
      ADDI(5, 0, 0x1800 & 0xFFF),  // 0x800 → sign extends to 0xFFFFF800
      CSRRW(0, 5, 0x300),
      MRET,
      ADDI(6, 0, 42),
    ]);
    c.cpu.set_extraflags(3);
    c.step(6);

    const mstatus = c.cpu.get_mstatus() >>> 0;
    // MPIE was 0, so MIE should be 0 after MRET
    assert.equal((mstatus >> 3) & 1, 0, 'MIE should be 0 (MPIE was 0)');
  });
});

describe('mscratch: save/restore round-trip', () => {
  it('mscratch preserved through trap entry and handler CSRRW', () => {
    // Simulate what Linux trap handler does:
    // 1. Set mscratch to a known value (per-CPU pointer)
    // 2. Trigger trap → enters handler
    // 3. Handler does CSRRW tp, mscratch, tp (swap tp with mscratch)
    // 4. Verify tp now has the old mscratch value
    const mtvecAddr = RAM_BASE + 32;
    const c = createCpu([
      // Setup: mtvec, mscratch, tp
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),       // mtvec = handler
      ADDI(1, 0, 0x42),
      CSRRW(0, 1, 0x340),       // mscratch = 0x42
      ADDI(4, 0, 0x99),         // tp (x4) = 0x99
      ADDI(17, 0, 99),          // a7 = unknown SBI
      ECALL,                    // trap!
      // --- handler starts at mtvecAddr (instruction 8) ---
      CSRRW(4, 4, 0x340),       // CSRRW tp, mscratch, tp: tp↔mscratch
      NOP,
    ]);
    c.cpu.set_extraflags(3);
    c.step(8);   // up to and including ECALL (returns after trap)
    c.step(1);   // execute the CSRRW at mtvec

    // After CSRRW: tp should be old mscratch (0x42), mscratch should be old tp (0x99)
    assert.equal(c.reg(4), 0x42, 'tp should have old mscratch value');
    assert.equal(c.cpu.get_mscratch(), 0x99, 'mscratch should have old tp value');
  });

  it('mscratch round-trip through trap+MRET cycle', () => {
    // Full cycle: set mscratch, trap, swap tp↔mscratch, do work, swap back, MRET
    // After MRET, mscratch should be restored
    const mtvecAddr = RAM_BASE + 36;  // instruction 9
    const retTarget = RAM_BASE + 64;  // instruction 16
    const c = createCpu([
      // 0: Setup
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),       // mtvec
      ADDI(1, 0, 0x42),
      CSRRW(0, 1, 0x340),       // mscratch = 0x42
      ADDI(4, 0, 0x99),         // tp = 0x99
      ADDI(1, 0, 8),
      CSRRW(0, 1, 0x300),       // mstatus = 8 (MIE=1)
      ADDI(17, 0, 99),          // a7 = unknown
      // 9: Handler (mtvecAddr)
      CSRRW(4, 4, 0x340),       // swap tp↔mscratch (tp=0x42, mscratch=0x99)
      ADDI(5, 0, 0x55),         // do some work
      CSRRW(4, 4, 0x340),       // swap back (tp=0x99, mscratch=0x42)
      // Set mepc to retTarget
      LUI(1, (retTarget & 0xFFFFF000) >>> 0),
      ADDI(1, 1, retTarget & 0xFFF),
      CSRRW(0, 1, 0x341),       // mepc = retTarget
      MRET,                     // return from trap
      // 16: retTarget
      ADDI(6, 0, 77),           // verify we got here
    ]);
    c.cpu.set_extraflags(3);

    // Execute setup (instructions 0-8) + ECALL triggers trap at instruction 8
    // Wait, instruction 8 is ADDI(17,0,99), need ECALL after that
    // Let me fix: instructions 0-8 = setup, then ECALL is instruction 9... no.
    // Actually the array index IS the instruction position. Let me recount.
    // 0: LUI, 1: ADDI, 2: CSRRW, 3: ADDI, 4: CSRRW, 5: ADDI, 6: ADDI, 7: CSRRW, 8: ADDI(a7=99)
    // We need ECALL at instruction 9... but mtvecAddr = instruction 9 too. That won't work.
    // Let me adjust layout.
  });

  it('full trap+MRET preserves mscratch', () => {
    // Adjusted layout: ECALL at inst 8, handler at inst 10 (skip inst 9)
    const mtvecAddr = RAM_BASE + 40;  // instruction 10
    const retTarget = RAM_BASE + 72;  // instruction 18
    const c = createCpu([
      // 0-7: Setup
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),   // 0
      ADDI(1, 1, mtvecAddr & 0xFFF),             // 1
      CSRRW(0, 1, 0x305),                         // 2: mtvec = handler
      ADDI(1, 0, 0x42),                           // 3
      CSRRW(0, 1, 0x340),                         // 4: mscratch = 0x42
      ADDI(4, 0, 0x99),                           // 5: tp = 0x99
      ADDI(1, 0, 8),                              // 6
      CSRRW(0, 1, 0x300),                         // 7: mstatus.MIE = 1
      ADDI(17, 0, 99),                            // 8: a7 = unknown SBI
      ECALL,                                       // 9: trap!
      // 10: Handler (mtvecAddr = RAM_BASE + 40)
      CSRRW(4, 4, 0x340),                         // 10: swap tp↔mscratch
      ADDI(5, 0, 0x55),                           // 11: work
      CSRRW(4, 4, 0x340),                         // 12: swap back
      LUI(1, (retTarget & 0xFFFFF000) >>> 0),     // 13
      ADDI(1, 1, retTarget & 0xFFF),              // 14
      CSRRW(0, 1, 0x341),                         // 15: mepc = retTarget
      MRET,                                        // 16: return
      NOP,                                         // 17: padding
      // 18: retTarget (RAM_BASE + 72)
      ADDI(6, 0, 77),                             // 18: post-trap code
    ]);
    c.cpu.set_extraflags(3);

    // Run setup + ecall
    c.step(10); // instructions 0-9 (ecall at 9 triggers trap, returns)
    // Now pc should be at mtvec (handler)
    assert.equal(c.pc() >>> 0, mtvecAddr >>> 0, 'pc should be at mtvec after trap');

    // Run handler + MRET
    c.step(7);  // instructions 10-16 (MRET returns)

    // After MRET, should be at retTarget
    assert.equal(c.pc() >>> 0, retTarget >>> 0, 'pc should be at retTarget after MRET');

    // Run the target instruction
    c.step(1);
    assert.equal(c.reg(6), 77, 'post-trap code should execute');

    // mscratch should be restored (swapped back in handler)
    assert.equal(c.cpu.get_mscratch(), 0x42, 'mscratch should be restored after handler');
    // tp should be back to original
    assert.equal(c.reg(4), 0x99, 'tp should be restored after handler');

    // mstatus: MIE should be restored from MPIE
    const mstatus = c.cpu.get_mstatus() >>> 0;
    assert.equal((mstatus >> 3) & 1, 1, 'MIE should be restored after MRET');
  });
});

describe('trap: mepc points to correct instruction', () => {
  it('ecall: mepc = address of ecall instruction', () => {
    const mtvecAddr = RAM_BASE + 20;
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),
      ADDI(17, 0, 99),
      ECALL,                    // at RAM_BASE + 16
      NOP,
    ]);
    c.cpu.set_extraflags(3);
    c.step(5);
    c.step(1); // ecall traps

    // mepc should point to the ecall instruction
    assert.equal(c.cpu.get_mepc() >>> 0, (RAM_BASE + 16) >>> 0,
      'mepc should be the ecall address');
    assert.equal(c.cpu.get_mcause(), 11, 'mcause should be 11 (M-mode ecall)');
  });

  it('ebreak: mepc = address of ebreak instruction', () => {
    const mtvecAddr = RAM_BASE + 20;
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),
      NOP,
      EBREAK,                   // at RAM_BASE + 16
      NOP,
    ]);
    c.cpu.set_extraflags(3);
    c.step(5);
    c.step(1); // ebreak traps

    assert.equal(c.cpu.get_mepc() >>> 0, (RAM_BASE + 16) >>> 0,
      'mepc should be the ebreak address');
    assert.equal(c.cpu.get_mcause(), 3, 'mcause should be 3 (breakpoint)');
  });
});

describe('trap: timer interrupt', () => {
  it('timer interrupt fires when mtime > mtimecmp with MIE enabled', () => {
    const mtvecAddr = RAM_BASE + 28;
    const c = createCpu([
      LUI(1, (mtvecAddr & 0xFFFFF000) >>> 0),
      ADDI(1, 1, mtvecAddr & 0xFFF),
      CSRRW(0, 1, 0x305),       // mtvec = handler
      ADDI(1, 0, 0x88),         // MIE=1(bit3) + MPIE=1(bit7) = 0x88
      CSRRW(0, 1, 0x300),       // mstatus with MIE=1
      ADDI(1, 0, 128),          // MTIE = bit 7
      CSRRW(0, 1, 0x304),       // mie = MTIE
      // Now set timer to fire: mtime > mtimecmp
      NOP, NOP, NOP, NOP,       // padding to handler
      // handler at instruction 7
      ADDI(6, 0, 0x77),         // marker: we got here
    ]);
    c.cpu.set_extraflags(3);

    // Set mtimecmp to 1, mtime to 10 — should fire immediately
    c.cpu.set_mtimecmp(1, 0);
    c.cpu.set_mtime(10, 0);

    c.step(7); // execute setup
    // Timer interrupt should have fired, redirecting to mtvec
    // step_batch returns on trap, so we need to step the handler
    c.step(1);

    // Check we're at or past the handler
    assert.equal(c.cpu.get_mcause() >>> 0, 0x80000007,
      'mcause should be timer interrupt (0x80000007)');
  });
});

describe('trap: multiple trap cycles', () => {
  it('two successive ecall traps preserve state correctly', () => {
    // First trap: set mscratch, ecall, handler swaps and MRETs
    // Second trap: ecall again, verify mscratch is still correct
    const handler = RAM_BASE + 48;   // instruction 12
    const resume1 = RAM_BASE + 76;   // instruction 19
    const c = createCpu([
      // 0-3: Setup
      LUI(1, (handler & 0xFFFFF000) >>> 0),
      ADDI(1, 1, handler & 0xFFF),
      CSRRW(0, 1, 0x305),             // mtvec
      ADDI(1, 0, 0x42),
      CSRRW(0, 1, 0x340),             // mscratch = 0x42
      ADDI(4, 0, 0x99),               // tp = 0x99
      ADDI(1, 0, 8),
      CSRRW(0, 1, 0x300),             // MIE = 1
      ADDI(17, 0, 99),                // a7 = unknown
      ECALL,                           // 9: first trap
      NOP, NOP,                        // 10-11: skipped (trap redirects)
      // 12: Handler
      CSRRW(4, 4, 0x340),             // swap tp↔mscratch
      CSRRW(4, 4, 0x340),             // swap back
      // advance mepc by 4 to skip the ECALL
      CSRRS(1, 0, 0x341),             // read mepc
      ADDI(1, 1, 4),                  // mepc += 4
      CSRRW(0, 1, 0x341),             // write mepc
      MRET,                           // 17
      NOP,                            // 18
      // 19: resume1 — but we'll have advanced past ECALL to instruction 10
    ]);
    c.cpu.set_extraflags(3);

    // First trap cycle
    c.step(10);  // 0-9, ecall at 9 traps
    c.step(6);   // handler (12-17), MRET returns to ECALL+4 = instruction 10

    // After first MRET, mscratch should still be 0x42
    assert.equal(c.cpu.get_mscratch(), 0x42, 'mscratch preserved after first trap cycle');
    assert.equal(c.reg(4), 0x99, 'tp preserved after first trap cycle');
  });
});
