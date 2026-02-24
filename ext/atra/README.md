# atra

**Arithmetic TRAnspiler** — wat, but for humans.

C was famously described as "portable assembly" — a thin layer over the PDP-11's instruction set that happened to compile everywhere. That was 1972. The machine had 56KB of memory, 16-bit words, and a register file you could count on one hand. Dennis Ritchie didn't design a language; he gave the hardware a syntax.

Fifty years later, there's a new virtual machine: WebAssembly. Stack-based, 4 numeric types (`i32`, `i64`, `f32`, `f64`), linear memory, no strings, no IO, no garbage collector. It runs inside every browser on earth. And its "assembly language" — WAT — looks like this:

```wat
(func $add (param $a f64) (param $b f64) (result f64)
  local.get $a
  local.get $b
  f64.add)
```

So: what would "C for WebAssembly" look like? Not C compiled *to* Wasm (that's Emscripten), but a language designed *for* Wasm the way C was designed for the PDP-11 — one that maps cleanly onto the virtual machine's actual semantics, doesn't try to be more than it is, and compiles in microseconds?

That exploration led here. The result turned out closer to Fortran than to C. Wasm's type system (four numbers, nothing else) and execution model (structured control flow, no goto) are a better fit for formula translation than for systems programming. The syntax ended up a Fortran/Pascal hybrid: `begin...end` blocks, `:=` assignment, `function`/`subroutine` distinction, return by assigning to the function name, `!` comments, `**` exponentiation. The lineage is literal:

- **FORTRAN** = FORmula TRANslator (1957, IBM 704 machine code)
- **ATRA** = Arithmetic TRAnspiler (2025, WebAssembly bytecode)

Same idea, different virtual machine, ~70 years apart.

```js
import { atra } from './atra.js';

const { spherical } = atra`
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
`;

spherical(25.0, 80.0, 1.0, 0.1)
```

The tagged template compiles source to Wasm bytecode, instantiates the module, and returns exported functions. No toolchain, no build step, no external compiler, no dependencies. One JS file that turns formulas into native-speed bytecode at runtime.

---

## The language

Four numeric types matching Wasm's value types: `i32`, `i64`, `f32`, `f64`. No strings, no booleans (use `i32`, 0 = false), no structs, no pointers. This is a numerical kernel language — it does arithmetic and nothing else.

### Functions and subroutines

Functions return a value. The return mechanism is the Fortran convention — assign to the function's own name:

```
function distance(x1, y1, x2, y2: f64): f64
var
  dx, dy: f64;
begin
  dx := x2 - x1
  dy := y2 - y1
  distance := sqrt(dx**2 + dy**2)
end
```

Subroutines have no return value. Use them for operations that write results into memory:

```
subroutine normalize(arr: array f64; n: i32)
var
  i: i32;
  sum: f64;
begin
  sum := 0.0
  for i := 0, n
    sum := sum + arr[i]
  end for
  for i := 0, n
    arr[i] := arr[i] / sum
  end for
end
```

### Control flow

All structured — no goto, because Wasm doesn't have goto.

```
! if/else
if (x > 0.0) then
  result := x
else
  result := 0.0 - x
end if

! if-expression (ternary) — compiles to Wasm's if (result T)
sign := if (x < 0.0) then -1 else 1

! for loop (0-based, exclusive upper bound, always)
for i := 0, n
  arr[i] := arr[i] * scale
end for

! for with step (countdown)
for i := n - 1, -1, -1
  ...
end for

! while
while (error > tolerance)
  ...
end while

! do...while (body executes at least once)
do
  count += 1
while (count < limit)

! early return (guard clause)
if (b == 0.0) then
  call return(0.0)
end if

! tail call (constant stack space recursion)
tailcall factorial(n - 1, acc * n)
```

### Builtins

Common math functions work without any import declaration — the compiler auto-imports them from `Math.*`: `sin`, `cos`, `sqrt`, `ln`, `exp`, `abs`, `floor`, `ceil`, `pow`, `min`, `max`, `atan2`.

Native Wasm operations (single instruction, zero call overhead): `trunc`, `nearest`, `copysign`, `select`, `clz`, `ctz`, `popcnt`, `rotl`, `rotr`, `memory_size`, `memory_grow`, `memory_copy`, `memory_fill`.

Type conversions use type names as functions: `f64(i)`, `i32(x)`. No implicit coercion — atra is explicit about everything.

### Dotted names

Identifiers can contain dots. The compiler treats `physics.gravity` as a single flat name — no namespace machinery, just a naming convention that the JS side respects by nesting into objects:

```
function model.spherical(h, a, c1, c0: f64): f64
begin
  ...
end

function model.gaussian(h, a, c1, c0: f64): f64
begin
  ...
end
```

```js
wasm.model.spherical(0.5, 1.0, 1.0, 0.1)  // nested access
wasm['model.spherical'](...)                // flat access also works
```

### Function references

Functions can be passed by reference via `call_indirect`. A bare function name (without parens) evaluates to its table index:

```
function double(x: f64): f64
begin
  double := x * 2.0
end

function triple(x: f64): f64
begin
  triple := x * 3.0
end

function apply(f: function(x: f64): f64, x: f64): f64
begin
  apply := f(x)
end
```

```js
const wasm = atra`...`;
wasm.apply(wasm.__table.double, 5.0)  // 10
wasm.apply(wasm.__table.triple, 5.0)  // 15
```

When any function is used as a reference, the exports include a `__table` mapping function names to their table indices.

### SIMD

Vector types `f64x2`, `f32x4`, `i32x4`, `i16x8`, `i8x16` with lane operations. Arithmetic operators (`+`, `-`, `*`, `/`) are overloaded for vector types:

```
function test(a, b: f64): f64
var
  va, vb, vc: f64x2
begin
  va := f64x2.splat(a)
  vb := f64x2.splat(b)
  vc := va + vb
  test := f64x2.extract_lane(vc, 0)
end
```

---

## API

Six entry points, from high-level to low-level.

### `` atra`...` `` — tagged template

Full pipeline: parse, compile, instantiate, nest dotted exports, attach `__table`. This is the primary interface.

```js
const { add, mul } = atra`
  function add(a, b: f64): f64
  begin
    add := a + b
  end

  function mul(a, b: f64): f64
  begin
    mul := a * b
  end
`;
```

Template interpolation inlines JS values as constants:

```js
const SIZE = 256;
const { getSize } = atra`
  function getSize(): f64
  begin
    getSize := ${SIZE}.0
  end
`;
```

### `` atra({ imports })`...` `` — curried form

Pass JS functions (or other atra modules) as WebAssembly imports. Atra infers an all-`f64` signature from `.length`:

```js
const { compute } = atra({ lerp: (a, b, t) => a + (b - a) * t })`
  function compute(a, b, t: f64): f64
  begin
    compute := lerp(a, b, t)
  end
`;
```

Nested objects are flattened to dotted names — `{ math: { lerp: fn } }` becomes `math.lerp` in atra source.

### `atra.run(source, imports?)` — string API

Same full pipeline as the tagged template, but takes a plain string. Use when source comes from a file, is generated dynamically, or doesn't need template interpolation:

```js
const src = await fetch('kernels.atra').then(r => r.text());
const { spherical, gaussian } = atra.run(src);
```

With imports:

```js
const { compute } = atra.run(`
  function compute(x: f64): f64
  begin
    compute := scale(x)
  end
`, { scale: (x) => x * 2 });
```

### `atra.compile(source)` → `Uint8Array`

Raw WebAssembly bytes. No instantiation, no export nesting, no `__table`. Use when you need the binary for manual instantiation, caching, or sending to a worker.

### `atra.parse(source)` → AST

Returns the abstract syntax tree. Useful for tooling, analysis, or custom code generation.

### `atra.dump(source)` → hex string

WebAssembly bytes as a space-separated hex string. For when you want to stare at the bytecode.

---

## Composability

atra output is a plain object of exported functions. Spread it as imports to another atra compilation:

```js
const lib = atra`
  function linalg.dot(a, b: f64): f64
  begin
    linalg.dot := a * b
  end

  function linalg.scale(x, s: f64): f64
  begin
    linalg.scale := x * s
  end
`;

const app = atra({ ...lib })`
  function compute(a, b, s: f64): f64
  begin
    compute := linalg.scale(linalg.dot(a, b), s)
  end
`;

app.compute(3.0, 4.0, 2.0)  // → 24.0
```

This works because the convention is symmetric: atra outputs nested objects (`lib.linalg.dot`) and accepts nested objects as imports (`{ linalg: { dot: fn } }`). Flat dotted keys (`{ 'linalg.dot': fn }`) also work. Same with `atra.run`:

```js
const lib = atra.run(libSource);
const app = atra.run(appSource, { ...lib });
```

---

## Shared memory

Pass a `WebAssembly.Memory` to enable array parameters. Arrays are typed views into linear memory — `array f64` is a base pointer into a `Float64Array`:

```js
const memory = new WebAssembly.Memory({ initial: 1 }); // 64KB

const { dotProduct } = atra({ memory })`
  function dotProduct(a, b: array f64; n: i32): f64
  var
    i: i32;
    sum: f64;
  begin
    sum := 0.0
    for i := 0, n
      sum := sum + a[i] * b[i]
    end for
    dotProduct := sum
  end
`;

const f64 = new Float64Array(memory.buffer);
f64.set([1, 2, 3], 0);     // a at byte offset 0
f64.set([4, 5, 6], 100);   // b at byte offset 800
dotProduct(0, 800, 3)       // → 32 (1*4 + 2*5 + 3*6)
```

Array parameters are `i32` byte offsets at the Wasm level. 2D indexing uses row-major layout: `arr[i, cols, j]` computes `arr[i * cols + j]`.

---

## Language reference

See **[SPEC.md](SPEC.md)** for the full language specification — types, operators, control flow, arrays, SIMD, function references, the `wasm.*` escape hatch, and everything else.
