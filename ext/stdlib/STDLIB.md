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
