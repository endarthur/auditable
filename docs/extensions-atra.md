# atra Extension

**Arithmetic TRAnspiler** — a Fortran/Pascal hybrid language that compiles to WebAssembly
bytecode. Designed for writing numerical kernels directly in JavaScript via tagged template
literals, with zero dependencies and no external toolchain.

!!! abstract "Full specification"
    This page is an overview. See
    [`ext/atra/SPEC.md`](https://github.com/endarthur/auditable/blob/main/ext/atra/SPEC.md)
    for the complete language specification.

## Quick Start

The `atra` tagged template compiles source to Wasm, instantiates the module, and returns
exported functions:

```js
const { add } = atra`
  function add(a: f64, b: f64): f64
    return a + b
  end
`
add(1.5, 2.5) // 4.0
```

No build step, no external compiler — one JS file turns formulas into bytecode.

## Types

Four numeric types, matching WebAssembly's value types directly:

| Type | Description | Bytes |
|------|-------------|-------|
| `i32` | 32-bit integer | 4 |
| `i64` | 64-bit integer | 8 |
| `f32` | 32-bit float | 4 |
| `f64` | 64-bit double precision | 8 |

Array types use bracket syntax: `f64[]`, `i32[]`, etc. These are passed as linear memory
pointers.

!!! warning "No strings, no booleans"
    atra is a pure numerical kernel language. Use `i32` for boolean values
    (0 = false, nonzero = true). No strings, no heap allocation, no I/O.

## Syntax Highlights

**From Fortran:** `subroutine` vs `function` distinction, `**` exponentiation, `!` comments,
return by assigning to function name.

**From Pascal:** `begin...end` blocks, `:=` assignment, `var`/`const` declarations,
type-after-name (`x: f64`).

**From neither:** Wasm numeric types directly, 0-based indexing, exclusive upper bounds,
square brackets for arrays, Python-style operator split (words for logic, symbols for
bitwise).

```
function spherical(h, range, sill, nugget: f64): f64
begin
  if (h == 0.0) then
    spherical := 0.0
  else if (h >= range) then
    spherical := nugget + sill
  else
    spherical := nugget + sill * (1.5 * h / range - 0.5 * (h / range)**3)
  end if
end
```

## Imports

Pass an object with a `memory` key to link external memory into the Wasm module.
Functions and other imports are also passed as top-level keys:

```js
const memory = new WebAssembly.Memory({ initial: 1 });

const { compute } = atra({ memory })`
  function compute(n: i32): f64
    var sum: f64 := 0.0
    for i := 0 to n do
      sum := sum + f64(i)
    end for
    return sum
  end
`
```

## Memory Declarations

atra supports multi-memory banks for advanced use cases (Chrome 120+, Firefox 125+):

```
memory data   ! default memory bank
memory scratch ! secondary memory bank

function process(arr: f64[data], tmp: f64[scratch], n: i32): f64
  ! arr reads from 'data' memory, tmp uses 'scratch' memory
  ...
end
```

!!! note "Browser support"
    Multi-memory requires `atra.hasMultiMemory` feature detection. Falls back
    gracefully on browsers without support.

## Libraries

Pre-built atra libraries are available via `@atra/<name>`:

| Library | Description |
|---------|-------------|
| `@atra/alpack` | Linear algebra — matrix ops, decomposition, solvers |
| `@atra/gslib` | Geostatistics — variograms, kriging, simulation |
| `@atra/raster` | Terrain analysis — slope, aspect, curvature, hydrology |

### Loading Libraries

```js
// load a library for use in atra code
const alpack = await load("@atra/alpack");
```

### Source-Level Includes

Use `std.include()` for source-level dependency resolution — this inlines library
functions directly into your atra module:

```js
const lib = await load("@atra/alpack");
const { solve } = atra`
  ${std.include(lib, "luDecomp", "luSolve")}

  subroutine solve(A: f64[], b: f64[], x: f64[], n: i32)
    var ipiv: i32[64]
    call luDecomp(A, ipiv, n)
    call luSolve(A, ipiv, b, x, n)
  end
`
```

## CLI Compiler

atra includes a command-line compiler (`atrac`) for use outside the notebook:

```bash
# compile a .atra file to .wasm
npx atrac input.atra -o output.wasm

# compile and bundle as a self-contained JS module
npx atrac input.atra --bundle -o output.js
```
