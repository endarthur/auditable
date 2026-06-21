# atra standard library

Minimal standard library for atra programs. Enables GSLIB-style command-line programs to run on WASI-compatible runtimes (Wasmtime, Wasmer) without a JavaScript host.

Design source: `spec_inbox/PROPOSAL-stdlib.md`

## Principles

1. **Bytes, not strings.** No string type. Text is `(ptr, len)` pairs.
2. **Minimal language changes.** Two additions: character literals and data segments.
3. **Kernels stay pure.** Numerical code is unchanged and host-agnostic. Only the I/O harness imports WASI.

## Architecture

```
Application          (e.g. gslib_gamv.atra)
├── gslib_io.atra    GSLIB format reader/writer (first consumer, not stdlib)
├── stdio.atra       Buffered I/O, number parsing/formatting
├── wasi.atra        Raw WASI Preview 1 syscall wrappers
└── Language          Character literals, data segments
```

Math kernels (gamv, cova3, etc.) are shared between browser and WASI targets unchanged.

## Math builtins: the libm gap (roadmap)

Principle 3 ("kernels stay pure, host-agnostic") holds for *arithmetic* but **not for
transcendentals**. atra's `sin`, `cos`, `ln`, `exp`, `pow`, `atan2` are **imported from
the JS host's `Math`** (codegen `MATH_BUILTINS` → the bundle's `_math = {sin: Math.sin,
…}`). Only `sqrt`/`abs`/`floor`/`ceil`/`trunc`/`min`/`max`/… map to native wasm opcodes.

So any kernel that touches a transcendental — `setrot` (sin/cos rotations), `cova3`
(gaussian/exponential variograms via `exp`), `gamv`, etc. — silently depends on a JS
host. A **non-JS host has no `Math.*` to import** and those kernels won't instantiate:

- WASI runtimes (Wasmtime / Wasmer) — the very target this stdlib is *for*.
- Standalone wasm, a `@gcu/wasm4` cart in a non-JS engine, `wat+rw` output.
- **vindo**'s static → pure-wasm target. (vindo's *comptime* `sin` table-baking is
  host-eval at compile time, fine; runtime trig on a pure-wasm target hits this gap.)

**Fix: a DIY libm in atra** — accurate `sin`/`cos`/`ln`/`exp`/`pow`/`atan2` (fdlibm-grade
/ correctly-rounded), behind the same builtin names, selected when targeting a non-JS
host; the browser keeps importing JS `Math` by default (fast, accurate). The choice is
**accurate-and-consistent on the wasm side**, never degrading a JS caller to match a worse
wasm approximation.

Bit-identity payoff: a single shared atra libm makes the JS-host and WASI-host paths
produce identical numbers (today only the JS-host path exists), and keeps **`@gcu/gsjs`'s
CPU-JS path bit-identical to its wasm kriging path** — that path already matches because
atra's JS-host import *is* `Math` and gsjs ports gslib's exact π literal (`3.141592654`);
a DIY libm must preserve that bit-identity (it's a validation requirement, not just a
port). See `spec_inbox/SPEC-vindo.md` and the gsjs neighbourhood (`ext/gsjs/src/neigh.js`).

## Implementation status

### Phase 1: Language additions (do now)

Changes to the atra compiler, not library code.

**Character literals** — `'A'` compiles to `i32.const 65`. Escape sequences: `'\n'`, `'\r'`, `'\t'`, `'\0'`, `'\\'`, `'\''`. ~10-15 lines of compiler code in the lexer.

**Data segments** — `data ptr, len = "hello"` places UTF-8 bytes in the wasm data section, binds two i32 constants (pointer and length). Supports multi-memory bank qualifier: `data p, n = io "text"`. Escape sequences: `\n`, `\r`, `\t`, `\0`, `\\`, `\"`. ~30-40 lines of compiler code.

### Phase 2: WASI bindings (deferred)

`wasi.atra` — raw imports from `wasi_snapshot_preview1`:
- `proc_exit`, `args_sizes_get`, `args_get`
- `fd_read`, `fd_write`, `fd_seek`, `fd_close`
- `path_open`

Plus convenience wrappers (`io_write`, `io_read`, `print`, `println`, `open_read`, `open_write`, `argc`).

Requires:
- I/O memory bank layout convention (iovec scratch, path buffer, line buffer, format buffer)
- New compilation target: `{ wasi: true }` (emit `_start` export, WASI imports)
- `include` mechanism or build-script concatenation for multi-file programs
- Selective export (only `_start`, not every function)

### Phase 3: Buffered I/O (deferred)

`stdio.atra` — all written in atra, depends on wasi.atra:
- Character classification: `is_whitespace`, `is_digit`, `is_alpha`, `to_lower`
- Line reader (needs proper buffered block reads, not byte-at-a-time)
- Number parsing: `parse_i32`, `parse_f64`
- Number formatting: `fmt_i32`, `fmt_f64`, `fmt_f64_field`
- Byte buffer ops: `bytes_eq`, `bytes_eq_ci`, `bytes_copy`, `bytes_fill`

### Phase 4: GSLIB format I/O (deferred)

`gslib_io.atra` — GSLIB file format reader/writer. First real consumer of the stdlib. Not part of stdlib itself, lives in ext/gslib/ or a separate project.

## Open questions

1. **Include mechanism** — source-level textual include vs build-script concatenation. Needed for multi-file atra programs.
2. **Export convention** — WASI expects `_start` only. Current atra exports everything. Need selective export or `export` keyword semantics.
3. **Error handling** — stderr messages via data segments + `proc_exit(1)`.
4. **Parameter file parser** — GSLIB .par format reader. Application-specific, probably not stdlib.
