# Roadmap: rv32ima to rv64gc

A phased plan to evolve the RISC-V emulator from the current M-mode RV32IMA
NOMMU system to a full RV64GC machine with MMU, capable of booting Alpine Linux.

Each phase is self-contained: it adds a testable capability, the emulator
remains functional between phases, and earlier images keep working.

**Current state:** RV32IMA, M-mode only, NOMMU Linux + Busybox, 125 MIPS
browser / 357 MIPS Node.

---

## Phase 0: Infrastructure (before anything else)

**Goal:** Fix the pain points from rv32ima development so every subsequent
phase is faster to implement and debug.

### 0a. Immediate extraction helpers (cpu.atra)

Current code uses magic constants for bit extraction (2145386496, 1048576).
Extract into named functions:

```
function extract_i_imm(ir: i32): i32   ! bits [31:20] sign-extended
function extract_s_imm(ir: i32): i32   ! bits [31:25] + [11:7]
function extract_b_imm(ir: i32): i32   ! B-type immediate
function extract_u_imm(ir: i32): i32   ! bits [31:12] << 12
function extract_j_imm(ir: i32): i32   ! J-type immediate
```

This prevents bugs when widening to 64-bit (shift amounts change from
5-bit to 6-bit for 64-bit ops). ~20 lines, replaces scattered inline
extraction.

### 0b. CSR bit-field helpers (cpu.atra)

Current mstatus manipulation is cryptic:
```
mstatus := ((mstatus & 8) << 4) | ((extraflags & 3) << 11)
```

Replace with named constants and accessor functions:
```
const MIE  = 0x08
const MPIE = 0x80
const SPP  = 0x100
const MPP_MASK = 0x1800
```

Makes Phase 1 (privilege modes) dramatically cleaner. ~15 lines.

### 0c. Device registry (worker.js)

Replace hardcoded MMIO if-ladder with a device table:

```js
const DEVICES = [
  { name: 'uart',   base: 0x10000000, size: 0x100,   handler: uart },
  { name: 'clint',  base: 0x11000000, size: 0x10000, handler: clint },
  { name: 'syscon', base: 0x11100000, size: 0x1000,  handler: syscon },
];

function mmio_read(addr) {
  addr = addr >>> 0;
  for (const dev of DEVICES) {
    if (addr >= dev.base && addr < dev.base + dev.size)
      return dev.handler.read(addr - dev.base);
  }
  return 0;
}
```

Adding virtio (Phase 9) becomes one array entry instead of nested
conditionals. ~20 lines replaces ~30.

### 0d. Instruction tracing (test infrastructure)

When a test fails today, you get a register mismatch and no clue which
instruction caused it. Add optional trace mode:

```js
function createCpu(instructions, { trace = false } = {}) {
  // ... on each step, if trace:
  // traceBuffer.push({ pc, insn, regs: [...] })
}
```

Plus a minimal disassembler (~40 lines) that turns hex into readable
instructions. When a test fails, `c.dumpTrace()` shows exactly where
state diverged.

### 0e. riscv-tests suite integration

The official [riscv-tests](https://github.com/riscv-software-src/riscv-tests)
suite provides bare-metal ELF binaries for every instruction variant:
`rv32ui-p-add`, `rv32um-p-mul`, `rv64ui-p-addw`, etc. Each test writes
pass/fail to a `tohost` memory location.

Pre-compiled binaries are available from
[tenstorrent/riscv_arch_tests](https://github.com/tenstorrent/riscv_arch_tests).
Integration requires a ~50 line test harness that loads each ELF, runs it,
and checks `tohost`. This replaces hundreds of lines of hand-encoded tests
and automatically covers every ISA phase.

**Reference tracing:** For hard bugs, capture an instruction trace from
**Spike** (the golden reference RISC-V ISA simulator):
```
spike -l --log-commits <binary> 2> trace.log
```
Spike logs `PC instruction_hex register_written=value` per instruction.
Diff against our emulator's trace to find the exact divergence point.

### 0f. Performance benchmark in tests

Add a simple MIPS measurement to catch regressions:
```js
it('perf: 100k instructions under budget', () => {
  const c = createCpu(loopProgram);
  const start = performance.now();
  c.step(100000);
  const mips = (100000 / (performance.now() - start)) / 1000;
  assert(mips > 50, `Regression: ${mips.toFixed(0)} MIPS`);
});
```

### Estimate: ~150 lines across atra + JS + tests

---

## Phase 1: Privilege Modes (S-mode + U-mode)

**Goal:** Support supervisor and user privilege levels with trap delegation.

Currently the CPU runs everything in M-mode. Linux with MMU needs at least
M + S modes (U-mode for userspace). This means:

### New CSRs

| CSR        | Address | Description                         |
|------------|---------|-------------------------------------|
| sstatus    | 0x100   | Supervisor status (subset of mstatus) |
| sie        | 0x104   | Supervisor interrupt enable         |
| stvec      | 0x105   | Supervisor trap vector              |
| sscratch   | 0x140   | Supervisor scratch register         |
| sepc       | 0x141   | Supervisor exception PC             |
| scause     | 0x142   | Supervisor exception cause          |
| stval      | 0x143   | Supervisor trap value               |
| sip        | 0x144   | Supervisor interrupt pending        |
| satp       | 0x180   | Supervisor address translation (Phase 2) |
| medeleg    | 0x302   | Machine exception delegation        |
| mideleg    | 0x303   | Machine interrupt delegation        |

### Privilege tracking

New global `priv` (0=U, 1=S, 3=M). Trap entry/return updates `priv` based
on `mstatus.MPP` / `sstatus.SPP`. `mret` restores to MPP, `sret` restores
to SPP.

### Trap delegation

When an exception/interrupt occurs:
1. Check `medeleg`/`mideleg` — if the corresponding bit is set and current
   privilege <= S, trap to S-mode (use stvec/sepc/scause/stval).
2. Otherwise trap to M-mode as before.

### mstatus layout changes

For RV32 with S+U modes, mstatus gains:
- SPP (bit 8): previous privilege for S-mode traps
- SIE (bit 1): S-mode interrupt enable
- SPIE (bit 5): previous SIE
- MXR (bit 19): make executable readable (for page table walks)
- SUM (bit 18): supervisor user memory access
- TVM (bit 20): trap virtual memory ops

`sstatus` is a restricted view of `mstatus` — reads/writes go through
a mask.

### CSR access restrictions

S-mode cannot read/write M-mode CSRs (0x300-0x3FF range). U-mode cannot
read/write S-mode or M-mode CSRs. Violation triggers an illegal instruction
trap. Current code has no access checks — any mode can touch any CSR.

### Tests

- Trap from U-mode -> S-mode via ecall
- Trap delegation: set medeleg bit, verify ecall goes to stvec not mtvec
- `sret` restores to correct privilege and PC
- `mret` from M-mode to S-mode
- CSR access restrictions: S-mode read of mstatus -> illegal instruction trap
- CSR access restrictions: U-mode read of sstatus -> illegal instruction trap
- Interrupt delegation: timer interrupt to S-mode when mideleg bit set
- sstatus as mstatus mask: write sstatus, read mstatus, verify shared bits
- riscv-tests: `rv32si-p-*` (supervisor-mode instruction tests)

### Estimate: ~80 lines atra

---

## Phase 2: Sv32 MMU

**Goal:** Virtual memory via two-level page tables. Boot full (MMU) RV32 Linux.

**Boot target:** [xv6-riscv](https://github.com/mit-pdos/xv6-riscv) (rv32
variant) — simple OS that exercises MMU, traps, and U/S mode transitions.
Much easier to debug than Linux. Graduate to full Linux after xv6 boots.

### Page table format (Sv32)

- 32-bit virtual address: 10-bit VPN[1] + 10-bit VPN[0] + 12-bit offset
- Two-level walk: root table (1024 entries) -> leaf table (1024 entries)
- PTE format (32 bits): PPN[1] (12 bits) + PPN[0] (10 bits) + RSW (2) + DAGUXWRV (8)
- Page size: 4 KB (superpage: 4 MB)

### satp CSR

`satp` (0x180): MODE (bit 31, 0=bare/1=Sv32) + ASID (bits 30:22) + PPN (bits 21:0).
When MODE=0, no translation (current behavior). When MODE=1, all S-mode and
U-mode memory accesses go through the page table.

### CRITICAL: Design the walker as N-level from the start

The translation function must be parameterized by walk depth so that Phase 4
(Sv39, 3-level) is a config change, not a rewrite. Include ASID tags in the
TLB structure even if not used until Phase 4.

```
function translate(vaddr, access_type, levels, vpn_bits, pte_size):
  if priv == M or satp.MODE == 0: return vaddr
  pte_addr = satp.PPN * 4096
  for level = levels-1 downto 0:
    vpn = (vaddr >> (12 + level * vpn_bits)) & ((1 << vpn_bits) - 1)
    pte_addr = pte_addr + vpn * pte_size
    pte = mem[pte_addr]
    if pte is leaf: check permissions, return physical address
  page fault
```

For Sv32: `levels=2, vpn_bits=10, pte_size=4`.
For Sv39: `levels=3, vpn_bits=9, pte_size=8`.

### Permission checks

- U-mode: PTE.U must be set
- S-mode: PTE.U must be clear (unless mstatus.SUM is set)
- Read: PTE.R (or PTE.X if mstatus.MXR)
- Write: PTE.W and PTE.D
- Execute: PTE.X

Failure -> page fault exception (cause 12/13/15 for inst/load/store).

### Common MMU bugs to avoid

These are the most frequent bugs in hobby RISC-V emulators:

1. **Misaligned superpages:** at level 1, if PPN[0] != 0, it's misaligned —
   must raise page fault. Frequently missed.
2. **W=1 R=0 is reserved:** PTE with write but no read must fault.
3. **A/D bit handling:** if A=0 on access or D=0 on store, raise page fault
   and let the OS set the bits. This is what Linux expects (hardware A/D
   setting is optional; page-fault-based is simpler and correct).
4. **Three distinct page fault causes:** instruction (12), load (13),
   store/AMO (15). Don't use the same cause for all three.
5. **Page walk uses physical addresses:** the walk itself must NOT go through
   your own virtual-to-physical translator. Recursive translation = infinite
   loop.
6. **MPRV bit in mstatus:** when set, loads/stores in M-mode use the
   translation mode from mstatus.MPP. Forgetting this breaks M-mode access
   to user memory.
7. **SFENCE.VMA must flush TLB:** if you cache PTEs and forget to invalidate
   on sfence.vma, stale translations cause silent corruption.

### Integration with memory helpers

`mem_load_w`, `mem_store_w`, etc. gain a translation step before the
address check:

```
addr = translate(guest_vaddr, LOAD)
if addr >= 0x80000000: ram access
else: mmio
```

This is the hot path change. Performance impact depends on TLB hit rate.
A small direct-mapped TLB (16-64 entries) should cover most access patterns.

### Tests

- Identity mapping: PTE maps vaddr = paddr, verify load/store works
- Two-level walk: construct page tables in RAM, verify translation
- Superpage: single first-level PTE maps 4 MB region
- Misaligned superpage: PPN[0] != 0 -> page fault
- W=1 R=0 PTE -> page fault
- Permission faults: write to read-only page -> store page fault (cause 15)
- U/S mode access: U-mode accessing S-mode page -> fault
- A/D bit updates: verify page fault raised when A=0 or D=0
- SFENCE.VMA: change mapping, fence, verify new mapping takes effect
- MPRV: M-mode load with MPRV set uses S-mode translation
- riscv-tests: `rv32si-p-*` supervisor tests that exercise page tables
- Boot test: xv6-riscv (simpler than Linux, exercises all MMU paths)
- Boot test: full MMU Linux kernel with initramfs

### Estimate: ~160 lines atra

### Milestone: full RV32IMA Linux with MMU boots (fork, mmap, shared libs)

---

## Phase 3: RV32 -> RV64I

**Goal:** 64-bit base integer ISA.

### Register widening

- All 32 general-purpose registers become i64 (stored in Wasm memory as
  i64, register file grows from 128 B to 256 B)
- PC becomes i64
- All CSRs become 64-bit (mstatus gains more fields)
- Immediates are sign-extended to 64 bits

### Register file stride change

Current code stores registers as i32 array at `reg_base`. Changing to i64
means the stride doubles (8 bytes per register instead of 4). This is
subtle — `reg_base := bytes >> 2` becomes `reg_base := bytes >> 3`, and
the array type changes. Consider declaring a separate properly-typed `regs`
array or using an atra `layout` to avoid stride bugs.

### New instructions (RV64I additions)

| Insn   | Description                              |
|--------|------------------------------------------|
| LWU    | Load word unsigned (zero-extend to 64)   |
| LD     | Load doubleword                          |
| SD     | Store doubleword                         |
| ADDIW  | Add immediate, 32-bit result sign-extended |
| SLLIW  | Shift left logical immediate, 32-bit     |
| SRLIW  | Shift right logical immediate, 32-bit    |
| SRAIW  | Shift right arithmetic immediate, 32-bit |
| ADDW   | Add, 32-bit result sign-extended         |
| SUBW   | Subtract, 32-bit                         |
| SLLW   | Shift left logical, 32-bit              |
| SRLW   | Shift right logical, 32-bit             |
| SRAW   | Shift right arithmetic, 32-bit          |

The W-suffix instructions operate on the lower 32 bits and sign-extend
the result to 64 bits. This is the main new pattern.

### Shift amount changes

- RV32: shift amount is bits [4:0] (5 bits)
- RV64: shift amount is bits [5:0] (6 bits) for 64-bit ops
- W-suffix: shift amount is bits [4:0] (5 bits, 32-bit result)

### atra considerations

All register loads/stores become i64. atra has native i64 support, so
`regs[rd]` changes from i32 to i64 array access. ALU operations use i64
arithmetic. W-suffix ops: compute as i64, truncate to 32, sign-extend
back to 64 via `wasm.extend_i32_s(i32(result))`.

**Prerequisite:** verify that atra supports `wasm.extend_i32_s` in the
wasm escape hatch. If not, add it before starting Phase 3.

### CSR changes

- mstatus: XLEN-dependent fields (SXL, UXL for controlling sub-XLEN modes)
- cycle, time: now single 64-bit CSRs (cycleh/timeh become illegal in RV64)
- All other CSRs widen to 64 bits

### Tests

- 64-bit arithmetic: ADDI with large values, ADD overflow behavior
- LWU vs LW: unsigned vs signed extension (load -1 as word: LW gives
  0xFFFFFFFF_FFFFFFFF, LWU gives 0x00000000_FFFFFFFF)
- LD/SD: 64-bit load/store roundtrip
- ADDIW: verify sign extension of 32-bit result
- SLLW/SRLW/SRAW: 32-bit shift semantics
- CSR width: write 64-bit value, read back
- Upper 32 bits: for every RV32 instruction, verify upper 32 bits of
  result are correctly sign-extended (not garbage). This is a common
  source of bugs in rv32->rv64 transitions.
- riscv-tests: `rv64ui-p-*` (all base integer tests for rv64)

### Estimate: ~200 lines atra (mostly widening existing code)

---

## Phase 4: Sv39 MMU

**Goal:** Replace Sv32 with Sv39 for 64-bit virtual addresses.

### Page table format (Sv39)

- 39-bit virtual address: 9-bit VPN[2] + 9-bit VPN[1] + 9-bit VPN[0] + 12-bit offset
- Three-level walk (512-entry tables, 8 bytes per PTE)
- PTE format (64 bits): reserved + PPN[2] + PPN[1] + PPN[0] + RSW + DAGUXWRV
- Page sizes: 4 KB, 2 MB (megapage), 1 GB (gigapage)

### satp CSR (RV64)

64-bit: MODE (bits 63:60, 0=bare/8=Sv39/9=Sv48) + ASID (bits 59:44) + PPN (bits 43:0).

### Changes from Sv32

If Phase 2's walker was designed as N-level (as recommended), this is a
parameter change:

```
! Sv32: translate(vaddr, access, levels=2, vpn_bits=10, pte_size=4)
! Sv39: translate(vaddr, access, levels=3, vpn_bits=9,  pte_size=8)
```

- PTEs are 64-bit instead of 32-bit
- VPN fields are 9 bits instead of 10 bits
- Three superpage sizes instead of one
- Reserved PTE bits 60:54 must be zero (else page fault)

### Tests

- Three-level walk: construct Sv39 tables, verify translation
- Megapage (2 MB) and gigapage (1 GB) mappings
- Misaligned megapage/gigapage -> page fault
- Reserved bits 60:54 nonzero -> page fault
- Permission checks (same as Sv32 but with 64-bit PTEs)
- ASID-based TLB invalidation (if ASID support added in Phase 2)
- Boot: xv6-riscv (rv64, Sv39)
- Boot: RV64 Linux kernel with Sv39

### Estimate: ~20 lines atra (modify existing Sv32 walker parameters)

### Milestone: RV64IMA + Sv39, can boot RV64 Linux

---

## Phase 5: C Extension (Compressed)

**Goal:** 16-bit compressed instruction support. Required for standard
toolchain output.

**Moved earlier than F/D** because standard compilers emit compressed
instructions by default. Having C support means you can test with real
compiler output from Phase 4 onward, rather than needing special
`-mno-compressed` builds.

### Instruction fetch changes

Currently all instructions are 32 bits (bits [1:0] = 11). With C:
- If bits [1:0] != 11: 16-bit compressed instruction
- If bits [1:0] == 11: 32-bit instruction as before
- PC advances by 2 or 4 accordingly

### Compressed instruction quadrants

| Quadrant | bits [1:0] | Category                |
|----------|------------|-------------------------|
| C0       | 00         | Loads, stores (stack-relative and register) |
| C1       | 01         | ALU, branches, jumps, LUI, ADDI |
| C2       | 10         | Loads, stores (SP-relative), JR, JALR, ADD |

Each 16-bit instruction maps to exactly one 32-bit instruction. The
implementation can either:
1. **Expand then execute:** decode the 16-bit instruction into its 32-bit
   equivalent, then run the existing decoder. Simpler, slight overhead.
2. **Direct decode:** handle C instructions in a separate decode path.
   Faster, more code.

Option 1 is recommended for initial implementation. A `expand_compressed`
function (~80 lines) returns the equivalent 32-bit instruction.

### Register encoding

C instructions use 3-bit register fields addressing x8-x15 only (the
callee-saved and argument registers). The expand function maps these to
5-bit register numbers.

### Tests

- Each C instruction: encode compressed, verify same result as 32-bit equiv
- Mixed streams: alternating 16-bit and 32-bit instructions
- Branch targets at 2-byte boundaries
- C.ADDIW (RV64 only, replaces C.JAL from RV32)
- riscv-tests: `rv64uc-p-*` (compressed instruction tests)

### Estimate: ~120 lines atra

### Milestone: RV64IMAC — standard toolchain output works

---

## Phase 6: M Extension for RV64

**Goal:** 64-bit multiply/divide.

### New instructions

| Insn   | Description                                     |
|--------|-------------------------------------------------|
| MULW   | 32-bit multiply, sign-extend result to 64       |
| DIVW   | 32-bit signed divide, sign-extend               |
| DIVUW  | 32-bit unsigned divide, sign-extend              |
| REMW   | 32-bit signed remainder, sign-extend             |
| REMUW  | 32-bit unsigned remainder, sign-extend           |

Existing MUL/MULH/MULHU/MULHSU/DIV/DIVU/REM/REMU now operate on 64-bit
values. MULH variants need 128-bit intermediate — Wasm doesn't have i128,
so this requires multi-step computation (split into 32-bit halves, cross-
multiply, accumulate).

### 128-bit multiply for MULH

```
MULH(a, b):  // signed 64 x 64 -> upper 64
  Split a into ah:al (signed high, unsigned low)
  Split b into bh:bl
  Compute partial products, accumulate with carry
  Return upper 64 bits
```

This is the trickiest part of the M extension at 64-bit. About 20 lines
of careful atra. The pattern already exists in Phase 0 (32-bit MULH uses
i64 intermediate) but must be extended to 128-bit.

### Tests

- MULW: 32-bit multiply with sign extension
- MUL: 64-bit multiply low bits
- MULH: 64-bit signed x signed high bits (edge cases: max x max, min x min,
  0x7FFFFFFFFFFFFFFF x 0x7FFFFFFFFFFFFFFF, 0x8000000000000000 x -1)
- MULHU: unsigned 64 x 64 high bits
- MULHSU: signed x unsigned high bits
- DIV/REM: 64-bit division, divide-by-zero (returns -1 / dividend per spec),
  overflow (-2^63 / -1 -> returns -2^63 / 0 per spec)
- W variants: verify 32-bit semantics with sign extension
- riscv-tests: `rv64um-p-*` (M extension tests)

### Estimate: ~60 lines atra

---

## Phase 7: A Extension for RV64

**Goal:** 64-bit atomics.

### New instructions

All existing RV32A instructions gain 64-bit variants (same opcodes, funct3
changes from 010 to 011):

LR.D, SC.D, AMOSWAP.D, AMOADD.D, AMOAND.D, AMOOR.D, AMOXOR.D,
AMOMIN.D, AMOMAX.D, AMOMINU.D, AMOMAXU.D

Single-core, so implementation is identical to RV32A but with i64
load/store. Trivially correct.

### Tests

- LR.D / SC.D: 64-bit reservation
- AMOADD.D: 64-bit atomic add
- All AMO variants with 64-bit values, including negative/overflow
- riscv-tests: `rv64ua-p-*` (A extension tests)

### Estimate: ~20 lines atra

### Milestone: RV64IMA complete — can attempt Alpine with soft-float

---

## Phase 8: F+D Extensions (Floating Point)

**Goal:** Single and double precision floating point. Completes the G in
rv64gc (G = IMAFD).

This is the most complex phase. Budget extra time for IEEE 754 corner cases.

### atra prerequisites

Before starting, add these to atra's wasm escape hatch:
- `wasm.reinterpret_f64_i64(x)` — bit-level reinterpret f64 as i64
- `wasm.reinterpret_i64_f64(x)` — bit-level reinterpret i64 as f64
- `wasm.reinterpret_f32_i32(x)` — bit-level reinterpret f32 as i32
- `wasm.reinterpret_i32_f32(x)` — bit-level reinterpret i32 as f32

These are essential for NaN boxing and FCLASS.

### FP register file

32 x f64 registers (f0-f31). Stored in Wasm memory after the integer
register file. When only F is enabled, each register holds an f32
NaN-boxed in f64 (upper 32 bits = all 1s).

### New CSR

| CSR    | Address | Description                    |
|--------|---------|--------------------------------|
| fflags | 0x001   | FP exception flags (5 bits)    |
| frm    | 0x002   | FP rounding mode (3 bits)      |
| fcsr   | 0x003   | FP control/status (frm + fflags) |

### Rounding modes

| frm | Mode                |
|-----|---------------------|
| 0   | Round to nearest, ties to even (RNE) |
| 1   | Round towards zero (RTZ) |
| 2   | Round down (RDN) |
| 3   | Round up (RUP) |
| 4   | Round to nearest, ties to max magnitude (RMM) |
| 7   | Dynamic (use frm CSR) |

Wasm f32/f64 ops use IEEE 754 "round to nearest even" only. Other rounding
modes require software emulation — rare in practice (most code uses RNE or
dynamic-defaulting-to-RNE), but must be correct for compliance.

### F extension instructions (~25 instructions)

Arithmetic: FADD.S, FSUB.S, FMUL.S, FDIV.S, FSQRT.S
Fused: FMADD.S, FMSUB.S, FNMADD.S, FNMSUB.S
Compare: FEQ.S, FLT.S, FLE.S (write integer register)
Convert: FCVT.W.S, FCVT.WU.S, FCVT.S.W, FCVT.S.WU
         FCVT.L.S, FCVT.LU.S, FCVT.S.L, FCVT.S.LU (RV64)
Move: FMV.X.W, FMV.W.X (bit transfer between int/FP regs)
Sign: FSGNJ.S, FSGNJN.S, FSGNJX.S
Min/max: FMIN.S, FMAX.S
Classify: FCLASS.S (returns bit pattern classifying the value)
Load/store: FLW, FSW

### D extension instructions (~25 more)

Same as F but for f64. Plus conversion between S and D:
FCVT.S.D, FCVT.D.S

### NaN boxing

When F and D are both enabled, f32 values stored in f64 registers must be
NaN-boxed: upper 32 bits set to all 1s. Reading a non-NaN-boxed value as
f32 returns canonical NaN. This is the fiddliest part of the implementation.

Requires `wasm.reinterpret_f64_i64` to inspect/set the upper bits.

### Implementation strategy

Most F/D ops map directly to Wasm f32/f64 ops:
- FADD.S -> f32.add, FMUL.D -> f64.mul, FSQRT.S -> f32.sqrt, etc.
- FEQ/FLT/FLE -> f32.eq/f32.lt/f32.le
- FMIN/FMAX: careful — RISC-V and Wasm differ on NaN handling

Problematic cases:
- **FMIN/FMAX with NaN:** RISC-V returns the non-NaN argument; Wasm
  returns NaN. Needs explicit NaN check.
- **FMADD/FMSUB:** atra has no fused multiply-add intrinsic. Must use
  `a * b + c` which double-rounds. For correct single-rounding, may need
  a JS-imported FMA function or accept the (rare) rounding difference.
- **Rounding modes other than RNE:** software path needed.
- **FCLASS:** no Wasm equivalent, must inspect bit pattern via reinterpret.
- **Exception flags:** Wasm doesn't expose IEEE flags. Must infer from
  results: NaN output from non-NaN inputs -> invalid, infinity from finite
  inputs -> overflow, etc. This is fragile — defer signaling NaN (sNaN)
  handling to a later polish pass.

### Tests

This phase needs 100+ test cases — more than all other phases combined.

- Basic arithmetic: add, sub, mul, div, sqrt with known results
- Fused multiply-add: verify single rounding (not double rounding)
- Conversions: int<->float, float<->float, edge cases (overflow, NaN, +/-0)
- NaN boxing: write f32, read as f64, verify NaN-box; write non-NaN-boxed
  value, read as f32, verify canonical NaN returned
- FCLASS: test all 10 classes (neg inf, neg normal, neg subnormal, -0,
  +0, pos subnormal, pos normal, pos inf, sNaN, qNaN)
- Exception flags: verify fflags after operations that should set them
  (invalid, divzero, overflow, underflow, inexact)
- Rounding modes: at minimum verify RNE and RTZ produce different results
  for a known case
- Subnormal handling: subnormal arithmetic roundtrip
- riscv-tests: `rv64uf-p-*` and `rv64ud-p-*` (F and D extension tests)
- Consider property-based testing: random operands, compare against a
  reference FP library

### Estimate: ~320-350 lines atra

### Milestone: RV64GC complete

---

## Phase 9: Virtio Block Device

**Goal:** Persistent storage for a real root filesystem.

### Virtio MMIO

Virtio-over-MMIO (not PCI). Memory-mapped at a new address (e.g.,
0x10001000). Implements the virtio-mmio transport:

- Magic value, version, device ID, vendor ID
- Device features / driver features negotiation
- Virtqueue setup (descriptor table, available ring, used ring)
- Queue notify (doorbell write triggers I/O)

With Phase 0's device registry, adding this is one entry in the DEVICES
array plus a handler object.

### Block device

Device ID = 2 (block). Features: VIRTIO_BLK_F_SIZE_MAX.

Operations: read and write sectors (512 bytes). The backing store is
either an ArrayBuffer in memory or an IndexedDB-backed virtual disk.

### DTB changes

Add a virtio-mmio node:
```
virtio_mmio@10001000 {
  compatible = "virtio,mmio";
  reg = <0x0 0x10001000 0x0 0x1000>;
  interrupts-extended = <&clint 1>;
};
```

### Pre-built boot images

No need to run buildroot. Pre-built rv64gc Linux images exist:
- **Debian DQIB:** pre-built Debian riscv64 images (kernel + initrd + rootfs)
  from the [Debian RISC-V wiki](https://wiki.debian.org/RISC-V)
- **rv64gc-emu-software:** minimal OpenSBI + Linux + Busybox build scripts
  from [bane9/rv64gc-emu-software](https://github.com/bane9/rv64gc-emu-software)

### Tests

- Feature negotiation handshake
- Descriptor ring: submit read request, verify data returned
- Write + read back: verify persistence
- Boot from virtio-blk: kernel with root=... pointing to virtio disk

### Estimate: ~200 lines JS

### Milestone: can mount a root filesystem, boot Alpine to package manager

---

## Phase Summary

| Phase | Addition              | Est. lines | Cumulative ISA  | Boots                  |
|-------|-----------------------|-----------|-----------------|------------------------|
| 0     | Infrastructure        | ~150 mixed | (tooling)      | (same)                 |
| 1     | Privilege modes       | +80 atra  | + S/U modes     | (same, prep for MMU)   |
| 2     | Sv32 MMU              | +160 atra | + Sv32          | xv6, full RV32 Linux   |
| 3     | RV64I base            | +200 atra | RV64IA          | RV64 NOMMU Linux       |
| 4     | Sv39 MMU              | +20 atra  | + Sv39          | xv6 (rv64), RV64 Linux |
| 5     | C compressed          | +120 atra | RV64IMAC        | Standard toolchain      |
| 6     | M extension (64-bit)  | +60 atra  | + M64           | (perf, not new boot)   |
| 7     | A extension (64-bit)  | +20 atra  | RV64IMA complete | (correctness)          |
| 8     | F+D floating point    | +320 atra | RV64GC          | Full software ecosystem |
| 9     | Virtio block          | +200 JS   | (I/O)           | Alpine Linux            |

**Total new code: ~1180 lines atra + ~350 lines JS/tests**

### Recommended order

Phases 1-4 are sequential (each depends on the previous). After Phase 4
you have a bootable RV64 system with MMU.

Phase 5 (C extension) comes next because standard compilers emit compressed
instructions — this unblocks testing with real toolchain output.

Phases 6-7 (M64, A64) are mechanical widening of existing code.

Phase 8 (F+D) is the largest and most complex — tackle last among ISA work.

Phase 9 (Virtio) is independent of F/D and can be done in parallel with
Phase 8, or at any point after Phase 4.

---

## Boot targets per phase

| Phase | Primary test target | Why |
|-------|-------------------|-----|
| 0     | Existing NOMMU Linux | Verify nothing regressed |
| 1     | riscv-tests `rv32si-p-*` | Supervisor instruction tests |
| 2     | xv6-riscv (rv32) | Simple OS, exercises all MMU paths |
| 2+    | Full RV32 MMU Linux | Integration test |
| 3     | riscv-tests `rv64ui-p-*` | All rv64 base integer tests |
| 4     | xv6-riscv (rv64) | Sv39 + privilege mode exercise |
| 4+    | RV64 Linux | Full integration |
| 5     | riscv-tests `rv64uc-p-*` | Compressed instruction tests |
| 6-7   | riscv-tests `rv64um-p-*`, `rv64ua-p-*` | M and A extension tests |
| 8     | riscv-tests `rv64uf-p-*`, `rv64ud-p-*` | F and D extension tests |
| 9     | Debian DQIB rv64 image | Pre-built, no buildroot needed |

---

## References

### Specifications
- [RISC-V Privileged Specification](https://riscv.org/specifications/privileged-isa/) — CSRs, privilege modes, Sv32/Sv39
- [RISC-V Unprivileged Specification](https://riscv.org/specifications/) — base ISA, M/A/F/D/C extensions
- [Virtio Specification](https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html) — virtio-mmio transport, block device

### Test suites
- [riscv-tests](https://github.com/riscv-software-src/riscv-tests) — official ISA test suite (bare-metal ELFs)
- [riscv-arch-test](https://github.com/riscv-non-isa/riscv-arch-test) — newer compliance suite (signature-based)
- [tenstorrent/riscv_arch_tests](https://github.com/tenstorrent/riscv_arch_tests) — pre-compiled test binaries

### Reference implementations
- [Spike](https://github.com/riscv-software-src/riscv-isa-sim) — golden reference ISA simulator, use for trace comparison
- [TinyEMU](https://bellard.org/tinyemu/) — Bellard's reference, full RV64GC + virtio
- [xv6-riscv](https://github.com/mit-pdos/xv6-riscv) — clean RV64 OS, ideal for MMU testing
- [d0iasm/rvemu](https://github.com/d0iasm/rvemu) — Rust, step-by-step RV64GC with [book](https://book.rvemu.app/)
- [bane9/rv64gc-emu](https://github.com/bane9/rv64gc-emu) — C++, RV64GC, boots Linux
- [franzflasch/riscv_em](https://github.com/franzflasch/riscv_em) — C, both RV32IMA and RV64IMA

### MMU debugging resources
- [Sv39 page table walk reference](https://gist.github.com/diodesign/6a398b9acc49454d0a21adc75bd51a86)
- [Page faults in emuriscv](http://jborza.com/post/2021-06-13-riscv-pagefaults/) — common MMU bugs
- [SiFive MMU in Linux kernel](https://www.sifive.com/blog/all-aboard-part-9-paging-and-mmu-in-risc-v-linux-kernel)
- [RISC-V OS in Rust — MMU chapter](https://osblog.stephenmarz.com/ch3.2.html)

### Pre-built images
- [Debian RISC-V images (DQIB)](https://wiki.debian.org/RISC-V) — pre-built rv64gc Debian
- [rv64gc-emu-software](https://github.com/bane9/rv64gc-emu-software) — minimal Linux build scripts
