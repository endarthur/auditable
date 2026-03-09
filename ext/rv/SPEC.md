# rv — RISC-V System Emulator

A RISC-V RV32IMA system emulator: atra CPU core compiling to WebAssembly,
JS host for devices and boot orchestration. Boots NOMMU Linux + Busybox to
an interactive shell in a browser. Zero dependencies, single HTML file.

**Status:** Spec
**Reference:** [cnlohr/mini-rv32ima](https://github.com/cnlohr/mini-rv32ima) (~400 lines of C, boots Linux)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│               Browser / Node                 │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │           JS Host (~300 lines)         │  │
│  │                                        │  │
│  │  ┌────────┐ ┌──────┐ ┌────────────┐   │  │
│  │  │  ELF   │ │ UART │ │   CLINT    │   │  │
│  │  │ Loader │ │ 16550│ │   Timer    │   │  │
│  │  └────────┘ └──────┘ └────────────┘   │  │
│  │  ┌────────┐ ┌──────┐ ┌────────────┐   │  │
│  │  │  DTB   │ │SYSCON│ │  Run Loop  │   │  │
│  │  │Builder │ │      │ │ + Console  │   │  │
│  │  └────────┘ └──────┘ └────────────┘   │  │
│  └───────────────┬────────────────────────┘  │
│                  │ imports                    │
│  ┌───────────────▼────────────────────────┐  │
│  │       atra CPU Core (~470 lines)       │  │
│  │                                        │  │
│  │  ┌────────┐ ┌───────┐ ┌────────────┐  │  │
│  │  │ Decode │ │Execute│ │    CSR     │  │  │
│  │  │RV32IMA │ │       │ │ Registers  │  │  │
│  │  └────────┘ └───────┘ └────────────┘  │  │
│  │                                        │  │
│  │         WebAssembly.Memory             │  │
│  │  ┌─────────────────────────────────┐   │  │
│  │  │  RAM (64 MB)  │ Regs (128 B)   │   │  │
│  │  │  offset 0     │ offset 64M     │   │  │
│  │  └─────────────────────────────────┘   │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

---

## Memory Model

### Guest Physical Address Space

Following the `virt` machine convention (compatible with mini-rv32ima and Linux):

| Guest address           | Size   | Description          |
|-------------------------|--------|----------------------|
| `0x02000000–0x020000FF` | 256 B  | CLINT (timer)        |
| `0x10000000–0x100000FF` | 256 B  | UART 16550           |
| `0x11100000–0x11100003` | 4 B    | SYSCON (poweroff)    |
| `0x80000000–0x83FFFFFF` | 64 MB  | RAM                  |

### Wasm Linear Memory Layout

Wasm memory holds 64 MB of RAM plus a small region for registers.
Guest physical addresses are translated: `wasm_offset = guest_addr - 0x80000000`.

| Wasm offset              | Size   | Contents             |
|--------------------------|--------|----------------------|
| `0x00000000–0x03FFFFFF`  | 64 MB  | RAM                  |
| `0x04000000–0x0400007F`  | 128 B  | Register file (x0–x31) |

Total: 1025 Wasm pages (64 MB + 4 KB).

MMIO regions (CLINT, UART, SYSCON) are not mapped in Wasm memory. They are
intercepted by address-range checks in the atra core and dispatched to JS
via imported functions. The RAM fast path never leaves Wasm.

### Address Translation and MMIO Dispatch

Every load/store in the emulated CPU goes through this logic (in atra):

```
subroutine mem_store_w(addr: i32, val: i32)
begin
  if (addr >= 0x80000000 and addr < 0x84000000) then
    ! RAM — direct Wasm memory access, hot path
    ram[(addr - 0x80000000) >> 2] := val
  else
    ! MMIO — cross to JS
    call mmio_write(addr, val)
  end if
end
```

The RAM branch is almost always taken. Wasm engines predict this well. The
subtraction and shift compile to a single `i32.sub` + `i32.store` — two
instructions on the hot path.

### Register File

32 × i32 registers stored as an array at offset 0x04000000 in linear memory.
Registers must be in memory (not Wasm locals) because `rd` is a runtime
value — you need `regs[rd] := value`, which requires array indexing. A 32-way
`case` dispatch to select a local would add more overhead than memory access.

`x0` is hardwired to zero: `regs[0] := 0` after every instruction. One extra
store, simpler than guarding every write.

Additional state as atra globals (not in memory):

| Global        | Type | Description                          |
|---------------|------|--------------------------------------|
| `pc`          | i32  | Program counter                      |
| `mstatus`     | i32  | Machine status (MIE, MPIE, MPP)      |
| `mie`         | i32  | Machine interrupt enable             |
| `mip`         | i32  | Machine interrupt pending            |
| `mtvec`       | i32  | Machine trap vector base             |
| `mepc`        | i32  | Machine exception PC                 |
| `mcause`      | i32  | Machine exception cause              |
| `mtval`       | i32  | Machine trap value                   |
| `mscratch`    | i32  | Machine scratch register             |
| `cycle_lo`    | i32  | Cycle counter low word               |
| `cycle_hi`    | i32  | Cycle counter high word              |
| `mtime_lo`    | i32  | Timer low word                       |
| `mtime_hi`    | i32  | Timer high word                      |
| `mtimecmp_lo` | i32  | Timer compare low word               |
| `mtimecmp_hi` | i32  | Timer compare high word              |
| `reservation` | i32  | LR/SC reservation address            |
| `res_valid`   | i32  | LR/SC reservation valid flag         |

64-bit values (`cycle`, `mtime`, `mtimecmp`) are stored as pairs of i32
globals rather than i64. This simplifies the JS↔Wasm interface — the JS host
calls exported `set_mtime(lo, hi)` between batches, and CSR reads compose
the halves.

---

## Execution Model

### Batch Execution

The atra core exports `step_batch(n: i32): i32` which runs up to `n`
instructions inside Wasm. Returns a status code:

| Code | Meaning             | JS action                        |
|------|---------------------|----------------------------------|
| 0    | Batch complete      | Update timer, schedule next batch |
| 1    | WFI (wait for int)  | Advance timer, check I/O, yield  |
| 2    | SYSCON halt         | Stop emulation                   |

The JS run loop never calls a per-instruction function. All decode/execute
stays in Wasm. JS is only involved between batches (timer, I/O) and on MMIO
(called from within the batch via imports).

```js
const BATCH = 8192;

function tick() {
  const rc = cpu.step_batch(BATCH);
  updateMtime();
  flushUart();
  if (rc === 2) return;                    // halt
  if (rc === 1) setTimeout(tick, 1);       // WFI — yield then resume
  else requestAnimationFrame(tick);        // batch done — continue
}
```

### MMIO Interface

The atra module imports these JS functions:

```
import mmio_read(addr: i32): i32
import mmio_write(addr: i32, val: i32)
```

The JS host dispatches on address ranges:

| Address range | Device | Read                   | Write                  |
|---------------|--------|------------------------|------------------------|
| `0x02000000+` | CLINT  | mtime/mtimecmp words   | mtimecmp words         |
| `0x10000000+` | UART   | RX char / LSR status   | TX char to terminal    |
| `0x11100000`  | SYSCON | 0                      | 0x5555=halt, 0x7777=reboot |

### Interrupt Checking

At the top of each instruction in `step_batch`, the core checks:

```
if (mstatus_MIE and mie_MTIE and timer_pending) then
  call trap(0x80000007)  ! machine timer interrupt
end if
```

Where `timer_pending` is `mtime >= mtimecmp` (compare the i32 pairs).
This is one branch per instruction — almost always not-taken, well-predicted.

---

## ISA Implementation

### RV32I Base (~250 lines)

40 instructions across 9 major opcodes. All 32-bit fixed-width.

**Immediate extraction:**

| Type | Used by              | Extraction                                              |
|------|----------------------|---------------------------------------------------------|
| R    | OP                   | No immediate (register-register)                        |
| I    | OP-IMM, LOAD, JALR   | `inst >> 20` (arithmetic shift = sign-extended)         |
| S    | STORE                | `{inst[31:25], inst[11:7]}`, sign-extended              |
| B    | BRANCH               | `{inst[31], inst[7], inst[30:25], inst[11:8], 0}`, sign-extended |
| U    | LUI, AUIPC           | `inst & 0xFFFFF000`                                    |
| J    | JAL                  | `{inst[31], inst[19:12], inst[20], inst[30:21], 0}`, sign-extended |

**Opcode dispatch** (bits 6:2, since bits 1:0 = `11` for all 32-bit insns):

```
case (op) of
  0x00: ! LOAD      (0x03) — lb, lh, lw, lbu, lhu
  0x04: ! OP-IMM    (0x13) — addi, slti, sltiu, xori, ori, andi, slli, srli, srai
  0x05: ! AUIPC     (0x17)
  0x08: ! STORE     (0x23) — sb, sh, sw
  0x0C: ! OP        (0x33) — add/sub, sll, slt, sltu, xor, srl/sra, or, and
  0x0D: ! LUI       (0x37)
  0x18: ! BRANCH    (0x63) — beq, bne, blt, bge, bltu, bgeu
  0x19: ! JALR      (0x67)
  0x1B: ! JAL       (0x6F)
  0x03: ! FENCE     (0x0F) — nop (single core)
  0x1C: ! SYSTEM    (0x73) — ecall, ebreak, csr*, mret, wfi
else
  call trap_illegal(inst)
end case
```

**Implementation notes:**

- **Sign extension:** `inst >> 20` is arithmetic shift in atra (i32), which
  is correct for I-type immediates. For other types, extract bits then
  conditionally OR the sign mask.
- **Unsigned comparisons:** `sltu`, `bltu`, `bgeu` use `wasm.lt_u` /
  `wasm.ge_u` since atra's `<` and `>=` are signed.
- **Sub-word loads:** `lb` uses `wasm.extend8_s`, `lh` uses
  `wasm.extend16_s`. `lbu`/`lhu` mask with `& 0xFF` / `& 0xFFFF`.
- **Sub-word stores:** read-modify-write the containing word. Shift, mask,
  OR in the new value.
- **x0 hardwire:** `regs[0] := 0` after every instruction.

### M Extension — Multiply/Divide (~40 lines)

8 instructions under opcode 0x33, funct7 = 0x01:

| funct3 | Insn   | Operation                                |
|--------|--------|------------------------------------------|
| 0      | MUL    | rd = (rs1 × rs2)[31:0]                   |
| 1      | MULH   | rd = (signed(rs1) × signed(rs2))[63:32]  |
| 2      | MULHSU | rd = (signed(rs1) × unsigned(rs2))[63:32] |
| 3      | MULHU  | rd = (unsigned(rs1) × unsigned(rs2))[63:32] |
| 4      | DIV    | rd = signed(rs1) / signed(rs2)           |
| 5      | DIVU   | rd = unsigned(rs1) / unsigned(rs2)       |
| 6      | REM    | rd = signed(rs1) % signed(rs2)           |
| 7      | REMU   | rd = unsigned(rs1) % unsigned(rs2)       |

**Implementation notes:**

- **MUL:** `regs[rd] := regs[rs1] * regs[rs2]` — i32 multiply, low 32 bits
  is automatic.
- **MULH:** Widen both operands to i64 via `i64(x)` (signed extend), multiply,
  shift right 32, truncate to i32.
- **MULHU:** Widen both operands unsigned via `wasm.extend_i32_u(x)`,
  multiply as i64, shift right 32, truncate. (Requires adding
  `wasm.extend_i32_u` to the atra escape hatch — one line in codegen.js.)
- **MULHSU:** Mixed: `i64(rs1)` for signed, `wasm.extend_i32_u(rs2)` for
  unsigned. Multiply, shift, truncate.
- **DIV/REM:** Check division by zero (return -1 / dividend per spec) and
  signed overflow (-2^31 / -1 → return -2^31 / 0 per spec).
- **DIVU/REMU:** `wasm.div_u` / `wasm.rem_u`.

### A Extension — Atomics (~20 lines)

Single-core, so atomics are trivially correct.

- **LR.W:** Load value, record reservation address.
  `reservation := addr; res_valid := 1; regs[rd] := mem[addr]`
- **SC.W:** If `res_valid` and `reservation == addr`, store and set `rd = 0`
  (success). Otherwise `rd = 1` (failure). Clear reservation.
- **AMO*:** Load, operate, store. amoswap, amoadd, amoand, amoor, amoxor,
  amomin, amomax, amominu, amomaxu.

All under opcode 0x2F, funct3 = 0x02, dispatched by funct7[6:2].

### Zicsr — CSR Access (~50 lines)

6 instructions under opcode 0x73:

| funct3 | Insn    | Operation                    |
|--------|---------|------------------------------|
| 1      | CSRRW   | rd = csr; csr = rs1          |
| 2      | CSRRS   | rd = csr; csr |= rs1         |
| 3      | CSRRC   | rd = csr; csr &= ~rs1        |
| 5      | CSRRWI  | rd = csr; csr = zimm         |
| 6      | CSRRSI  | rd = csr; csr |= zimm        |
| 7      | CSRRCI  | rd = csr; csr &= ~zimm       |

`zimm` is the zero-extended 5-bit rs1 field (bits 19:15).

CSR dispatch uses a `case` on the 12-bit CSR address (bits 31:20 of the
instruction). Minimal set for NOMMU Linux:

| CSR       | Address | Description                        |
|-----------|---------|------------------------------------|
| mstatus   | 0x300   | Machine status (MIE, MPIE, MPP)    |
| mie       | 0x304   | Machine interrupt enable           |
| mtvec     | 0x305   | Machine trap vector base           |
| mscratch  | 0x340   | Machine scratch register           |
| mepc      | 0x341   | Machine exception PC               |
| mcause    | 0x342   | Machine exception cause            |
| mtval     | 0x343   | Machine trap value                 |
| mip       | 0x344   | Machine interrupt pending          |
| mhartid   | 0xF14   | Hardware thread ID (always 0)      |
| cycle     | 0xC00   | Cycle counter low (read-only)      |
| cycleh    | 0xC80   | Cycle counter high (read-only)     |
| time      | 0xC01   | Timer low (= mtime_lo, read-only)  |
| timeh     | 0xC81   | Timer high (= mtime_hi, read-only) |

Unknown CSRs are silently ignored (read as 0, writes discarded).

### Trap Handling (~80 lines)

**Trap entry** (exception or interrupt):

```
mepc := pc
mcause := cause
mtval := value
mstatus := (mstatus & ~0x88) | ((mstatus & 0x8) << 4)  ! MPIE = MIE, MIE = 0
pc := mtvec
```

**Trap return** (`mret`, opcode 0x73, funct7 = 0x18):

```
pc := mepc
mstatus := (mstatus & ~0x88) | ((mstatus & 0x80) >> 4) | 0x80  ! MIE = MPIE, MPIE = 1
```

**Exception causes:**

| mcause     | Description                    |
|------------|--------------------------------|
| 0          | Instruction address misaligned |
| 1          | Instruction access fault       |
| 2          | Illegal instruction            |
| 3          | Breakpoint (ebreak)            |
| 4          | Load address misaligned        |
| 6          | Store address misaligned       |
| 8          | Environment call (ecall)       |
| 0x80000007 | Machine timer interrupt        |

### NOMMU Support (~30 lines)

- **WFI:** Return status 1 to JS, which yields and advances the timer.
- **FENCE.I:** Nop (no instruction cache).
- **SFENCE.VMA:** Nop (no MMU).
- **ECALL:** Trap with cause 8 — kernel's trap vector handles syscalls.
- **MRET:** Return from trap (see above).

---

## JS Host Components

### ELF Loader (~30 lines)

Reads a RISC-V ELF32 binary. Parses the 52-byte header, iterates PT_LOAD
program headers, copies segments into Wasm linear memory with address
translation:

```js
function loadElf(buffer, mem) {
  const v = new DataView(buffer);
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const phsize = v.getUint16(42, true);
  const phnum = v.getUint16(44, true);
  const RAM_BASE = 0x80000000;
  const u8 = new Uint8Array(mem.buffer);
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phsize;
    if (v.getUint32(off, true) !== 1) continue; // PT_LOAD
    const foff  = v.getUint32(off + 4, true);
    const vaddr = v.getUint32(off + 8, true);
    const filesz = v.getUint32(off + 16, true);
    u8.set(new Uint8Array(buffer, foff, filesz), vaddr - RAM_BASE);
  }
  return entry;
}
```

### DTB Builder (~70 lines)

Generates a Flattened Device Tree blob at runtime describing the virtual
hardware. The FDT format is:

```
┌──────────────┐
│ fdt_header   │ 40 bytes — magic, sizes, offsets
├──────────────┤
│ struct block  │ BEGIN_NODE / END_NODE / PROP tokens
├──────────────┤
│ strings block │ property name strings, null-terminated
└──────────────┘
```

Built in JS using a small writer that tracks structure tokens and a string
table:

```js
function buildDtb({ ramBase, ramSize, bootArgs }) {
  const dt = new DtbWriter();
  dt.beginNode('');                          // root
  dt.prop('#address-cells', u32(2));
  dt.prop('#size-cells', u32(2));
  dt.prop('compatible', str('riscv-virtio'));

  dt.beginNode('cpus');                      // /cpus
  dt.prop('#address-cells', u32(1));
  dt.prop('#size-cells', u32(0));
  dt.prop('timebase-frequency', u32(10000000));
  dt.beginNode('cpu@0');
  dt.prop('device_type', str('cpu'));
  dt.prop('reg', u32(0));
  dt.prop('compatible', str('riscv'));
  dt.prop('riscv,isa', str('rv32ima'));
  dt.prop('mmu-type', str('riscv,none'));    // NOMMU
  dt.prop('clock-frequency', u32(1000000000));
  dt.endNode();                              // cpu@0
  dt.endNode();                              // cpus

  dt.beginNode('memory@80000000');
  dt.prop('device_type', str('memory'));
  dt.prop('reg', u64(ramBase, ramSize));
  dt.endNode();

  dt.beginNode('soc');
  dt.prop('compatible', str('simple-bus'));
  dt.prop('#address-cells', u32(2));
  dt.prop('#size-cells', u32(2));
  dt.prop('ranges', []);
  // CLINT, UART, SYSCON nodes...
  dt.endNode();

  dt.beginNode('chosen');
  dt.prop('bootargs', str(bootArgs));
  dt.endNode();

  dt.endNode();                              // root
  return dt.finish();
}
```

Parameters like RAM size, boot arguments, and ISA string are configurable —
changing `ramSize` or `bootArgs` regenerates the DTB without touching a blob.

### UART 16550 (~50 lines)

Memory-mapped at 0x10000000. Minimal subset:

| Offset | Read              | Write              |
|--------|-------------------|--------------------|
| 0x00   | RX: next char or 0 | TX: char to terminal |
| 0x05   | LSR: bit 0 = data ready, bit 5 = TX empty (always 1) | — |

JS pushes TX characters to the terminal element. RX comes from a keyboard
input queue.

### SYSCON (~10 lines)

Memory-mapped at 0x11100000. Write 0x5555 → halt, 0x7777 → reboot.

### Console UI (~80 lines)

M1 ships a minimal terminal: `<pre>` element with character-at-a-time
output, fixed-width font, GCU dark theme. Keyboard input via `keydown`
listener, buffered into a queue that UART reads drain.

No xterm.js dependency. Enough for a shell, `vi`, and `tcc`. A proper
terminal emulator (xterm.js or canvas-based) is a future upgrade.

---

## Build & Packaging

### File Structure

```
ext/rv/
  SPEC.md               — this document
  src/
    cpu.atra             — RV32IMA interpreter (~470 lines)
  build.js              — compile cpu.atra, bundle with JS host
  js/
    host.js             — run loop, MMIO dispatch, timer
    elf.js              — ELF32 loader
    dtb.js              — FDT builder
    uart.js             — UART 16550 emulation
    console.js          — terminal UI
tools/rv/
  index.html            — BUILD OUTPUT (standalone emulator)
  template.html         — HTML shell (terminal + status bar)
  style.css             — GCU dark theme
  manifest.json         — PWA manifest
  sw.js                 — service worker
```

Build: `node build.js --target=rv` produces `tools/rv/index.html` — a
self-contained HTML file with the atra CPU core (compiled to Wasm via the
embedded atra compiler), JS host, and a pre-loaded Linux image.

### Standalone Tool

`tools/rv/` follows the calque pattern: a standalone PWA for development
and testing, independent of the main auditable build. This lets us iterate
on the emulator (boot loops, ISA debugging, MMIO timing) without loading a
full notebook. The standalone page has its own `manifest.json` and `sw.js`
for offline use.

Later, the emulator integrates into auditable as `await load("@rv")` or
similar — the engine under `ext/rv/` is a reusable library, the standalone
tool is just a convenience shell around it.

### Image Bundling

The kernel + rootfs image is gzip-compressed and embedded as base64 in the
HTML, same as auditable's `installBinary()` pattern. On load, decompress
via `DecompressionStream`, load ELF into Wasm memory, generate DTB, boot.

Alternatively, images can be loaded at runtime via file input or URL fetch.

---

## atra Compiler Prerequisites

One addition needed before writing the CPU core:

### `wasm.extend_i32_u` escape hatch

`i64(x)` in atra emits `i64.extend_i32_s` (signed extension). MULHU and
MULHSU need unsigned widening. Add `wasm.extend_i32_u` to the `emitWasmBuiltin`
function in codegen.js — one line, emits `OP_I64_EXTEND_I32_U` (0xAD).

Usage in the CPU core:

```
! MULHU: unsigned(rs1) * unsigned(rs2), take high 32 bits
a64 := wasm.extend_i32_u(regs[rs1])
b64 := wasm.extend_i32_u(regs[rs2])
regs[rd] := i32((a64 * b64) >> 32)
```

---

## Testing Strategy

### Phase 1: Instruction Validation

Hand-encoded bare-metal test programs as hex arrays in JS:

```js
const tests = {
  addi: {
    code: [0x00500093, 0x00300113, 0x002081B3],
    // addi x1, x0, 5; addi x2, x0, 3; add x3, x1, x2
    check: (regs) => regs[3] === 8
  },
};
```

Then graduate to the official `riscv-tests` suite (rv32ui-p-*, rv32um-p-*,
rv32ua-p-* — bare-metal, no OS, signal pass/fail via tohost write).

### Phase 2: Linux Boot

Pre-built NOMMU images from cnlohr/mini-rv32ima or custom Buildroot.
Success: kernel messages on UART, Busybox shell prompt, basic commands work.

### Phase 3: Benchmarks

CoreMark compiled for RV32IMA bare-metal. Target: 100–300 CoreMark in
browser, 200–400 in Node.

---

## Performance Notes

| Metric                    | Estimate      | Basis                       |
|---------------------------|---------------|-----------------------------|
| MIPS (browser)            | 100–300       | JSLinux x86 ≈ 100 MIPS     |
| MIPS (Node)               | 200–500       | mini-rv32ima native ≈ 600   |
| Linux boot (browser)      | 2–5 s         | JSLinux ≈ 3 s               |
| Shell command latency     | < 100 ms      | Perceptually instant        |

Key to performance: batch execution keeps the hot loop in Wasm, MMIO checks
are a single well-predicted branch, register access is direct memory
load/store.

---

## NOMMU Linux Limitations

No virtual memory. Practical consequences:

| Feature             | Status      | Impact                              |
|---------------------|-------------|-------------------------------------|
| `fork()`            | Unavailable | Use `vfork()` + `exec()`           |
| `mmap()` (anon)     | Limited     | Contiguous physical pages only      |
| Memory protection   | None        | Any process can crash any other     |
| Shared libraries    | Very limited | Static linking preferred           |
| Process isolation   | None        | Single-user embedded operation      |

**Runs:** Busybox, tcc, Lua, MicroPython, Forth, CoreMark, shell scripts,
classic Unix tools (grep, sed, awk, sort, vi).

**Doesn't run:** Node.js, CPython, Go, Java, Docker — all need MMU.

---

## Future Phases

| Phase | Addition                | Lines    | Unlocks                          |
|-------|-------------------------|----------|----------------------------------|
| A     | Sv32 MMU                | +150 atra | fork(), mmap, full Linux        |
| B     | RV64 widening           | +200 atra | Debian, Alpine, Fedora          |
| C     | F/D floating point      | +300 atra | RV64GC software ecosystem       |
| D     | C compressed insns      | +200 atra | Smaller binaries, better perf   |
| E     | Basic block JIT         | +650 JS  | 5–20× speedup on hot loops      |
| F     | Multi-VM + networking   | +500 JS  | Web Workers, VirtIO, Tailscale  |

---

## Line Count Estimates

| Component                 | Language | Lines |
|---------------------------|----------|-------|
| RV32I interpreter         | atra     | ~250  |
| M extension               | atra     | ~40   |
| A extension               | atra     | ~20   |
| Zicsr instructions        | atra     | ~50   |
| Trap handling + interrupt  | atra     | ~80   |
| NOMMU support             | atra     | ~30   |
| **atra CPU total**        | **atra** | **~470** |
| ELF loader                | JS       | ~30   |
| DTB builder               | JS       | ~70   |
| UART 16550                | JS       | ~50   |
| SYSCON                    | JS       | ~10   |
| Run loop + timer          | JS       | ~80   |
| Console UI                | JS       | ~80   |
| **JS host total**         | **JS**   | **~320** |
| **Grand total**           |          | **~790** |

---

## References

- [RISC-V Unprivileged ISA Spec](https://riscv.org/specifications/)
- [RISC-V Privileged ISA Spec](https://riscv.org/specifications/privileged-isa/)
- [cnlohr/mini-rv32ima](https://github.com/cnlohr/mini-rv32ima) — ~400 lines of C, boots Linux
- [Bellard/TinyEMU](https://bellard.org/tinyemu/) — reference system emulator
- [riscv-software-src/riscv-tests](https://github.com/riscv-software-src/riscv-tests)
