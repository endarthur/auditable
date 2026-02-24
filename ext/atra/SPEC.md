# atra

**Arithmetic TRAnspiler** — wat, but for humans.

A Fortran/Pascal hybrid language that compiles to WebAssembly bytecode. Designed for handwriting numerical kernels — variogram models, kriging solvers, matrix operations — directly in JavaScript via tagged template literals, with zero dependencies.

```js
import { atra } from './atra.js';

const { spherical, ktsol, cova3 } = atra`
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

const gamma = spherical(25.0, 80.0, 1.0, 0.1);
```

The tagged template compiles source to Wasm, instantiates the module, and returns exported functions. No toolchain, no build step, no external compiler. One JS file that turns formulas into bytecode.

---

## Lineage

- **FORTRAN** = FORmula TRANslator (1957)
- **ATRA** = Arithmetic TRAnspiler (2026)

Same idea, different virtual machine, 70 years apart. Fortran translated formulas to IBM 704 machine code. Atra translates formulas to WebAssembly bytecode.

The syntax is an unholy hybrid of Fortran and Pascal, taking the pragmatic best from each:

From **Fortran**: `subroutine` vs `function` distinction, `**` exponentiation, `!` comments, return by assigning to function name.

From **Pascal**: `begin...end` blocks, `:=` assignment (no `=`/`==` ambiguity), `var`/`const` declarations, type-after-name (`x: f64`).

From **neither**: Wasm numeric types directly (`i32`, `i64`, `f32`, `f64`), 0-based indexing, exclusive upper bounds, square brackets for array access, Python-style operator split (words for logic, symbols for bitwise), no implicit anything, no strings, no IO, no GOTO.

---

## Types

Four numeric types, matching WebAssembly's value types:

| Type  | Description              | Bytes |
|-------|--------------------------|-------|
| `i32` | 32-bit integer           | 4     |
| `i64` | 64-bit integer           | 8     |
| `f32` | 32-bit float             | 4     |
| `f64` | 64-bit double precision  | 8     |

No strings. No booleans (use `i32`, where 0 = false, nonzero = true). No structs. No pointers. This is a numerical kernel language.

---

## Declarations

### Constants

```
const nugget: f64 = 0.1;
const sill: f64 = 1.0;
const max_samples: i32 = 64;
```

Constants are immutable Wasm globals. The JIT can inline them directly into the instruction stream.

### Globals

```
var heap_ptr: i32;
var total_pairs: i64;
```

Globals are mutable Wasm globals by default.

### Local variables

Declared in a `var` block before `begin`:

```
function example(x: f64): f64
var
  i, j: i32;
  sum, temp: f64;
begin
  ...
end
```

---

## Functions and subroutines

### Functions

Return a value. Return by assigning to the function name (Fortran convention):

```
function gaussian_inv(p: f64): f64
var
  t, c0, c1, c2, d1, d2, d3: f64;
begin
  c0 := 2.515517;
  c1 := 0.802853;
  c2 := 0.010328;
  d1 := 1.432788;
  d2 := 0.189269;
  d3 := 0.001308;

  if (p < 0.5) then
    t := (-2.0 * ln(p))**0.5
  else
    t := (-2.0 * ln(1.0 - p))**0.5

  gaussian_inv := t - (c0 + c1 * t + c2 * t**2)
                      / (1.0 + d1 * t + d2 * t**2 + d3 * t**3)

  if (p < 0.5) then
    gaussian_inv := -gaussian_inv
end
```

### Subroutines

No return value. Used for operations that write results into arrays:

```
subroutine kriging_weights(gamma_mat, rhs, weights: array f64; n: i32)
var
  i, j: i32;
  sum: f64;
begin
  ! Forward elimination
  for k := 0, n - 1
    for i := k + 1, n
      sum := gamma_mat[i, n, k] / gamma_mat[k, n, k]
      for j := k + 1, n
        gamma_mat[i, n, j] := gamma_mat[i, n, j] - sum * gamma_mat[k, n, j]
      end for
      rhs[i] := rhs[i] - sum * rhs[k]
    end for
  end for

  ! Back substitution
  for i := n - 1, -1, -1
    sum := rhs[i]
    for j := i + 1, n
      sum := sum - gamma_mat[i, n, j] * weights[j]
    end for
    weights[i] := sum / gamma_mat[i, n, i]
  end for
end
```

### Imports and exports

Common math functions are available automatically as builtins — `sin`, `cos`, `sqrt`, `ln`, `exp`, `abs`, `floor`, `ceil`, `pow`. No import declaration needed.

Additional native builtins (single Wasm instructions, zero import cost):

| Builtin | Description |
|---------|-------------|
| `min(a, b)` | Minimum (native f64/f32) |
| `max(a, b)` | Maximum (native f64/f32) |
| `trunc(x)` | Truncate to integer (float→float) |
| `nearest(x)` | Round to nearest even |
| `copysign(x, y)` | Copy sign of y to x |
| `select(a, b, cond)` | Branchless select: a if cond≠0, else b |
| `clz(x)` | Count leading zeros (i32/i64) |
| `ctz(x)` | Count trailing zeros (i32/i64) |
| `popcnt(x)` | Population count (i32/i64) |
| `rotl(x, n)` | Rotate left (i32/i64) |
| `rotr(x, n)` | Rotate right (i32/i64) |
| `memory_size()` | Current memory size in pages |
| `memory_grow(n)` | Grow memory by n pages |
| `memory_copy(dest, src, n)` | Copy n bytes from src to dest (all i32) |
| `memory_fill(dest, val, n)` | Fill n bytes at dest with val (all i32) |

Type conversions use type names as functions: `f64(i)`, `i32(x)`, `f32(x)`, `i64(x)`. No implicit coercion.

The `wasm.*` escape hatch provides raw Wasm ops: `wasm.div_u`, `wasm.rem_u`, `wasm.shr_u`, `wasm.lt_u`/`gt_u`/`le_u`/`ge_u`, `wasm.reinterpret_*`, `wasm.extend8_s`/`extend16_s`, `wasm.trunc_sat_s`/`trunc_sat_u`.

For custom host functions, atra resolves imports in this order:

1. **Defined in atra source** → local function, no import
2. **Builtin** → auto-imported from `Math.*`
3. **Imports object** (if provided) → infer signature from `.length`, assume all `f64`
4. **`globalThis`** → same treatment as imports object
5. **Template interpolation** → explicit, with optional type annotation
6. **Not found** → compile error

The simplest case — builtins just work:

```
function estimate(h, range: f64): f64
begin
  estimate := sqrt(h**2 + range**2)
end
```

Custom functions found on `globalThis` (e.g. from a `<script>` tag) are auto-resolved. Atra infers an all-`f64` signature from `.length`:

```js
function myWeight(h, range) { return h / range; }

const { estimate } = atra`
  function estimate(h, range: f64): f64
  begin
    estimate := myWeight(h, range)   ! found on globalThis, 2 params → (f64, f64): f64
  end
`;
```

For ES modules (where top-level declarations are not on `globalThis`), pass an imports object. Nested objects are flattened to dotted names (see [dotted names](#dotted-names-namespaces-by-convention)):

```js
const { estimate } = atra({ myWeight, myTransform })`
  function estimate(h, range: f64): f64
  begin
    estimate := myTransform(myWeight(h, range))
  end
`;
```

Or use template interpolation for inline import with optional type override:

```js
const { process } = atra`
  import indexLookup(i: i32): i32 = ${indexLookup};

  function process(data: array f64; n: i32): f64
  begin
    ...
  end
`;
```

Explicit `import` declarations with full type signatures are also supported for clarity or when the all-`f64` assumption is wrong:

```
import function sin(x: f64): f64 from 'math';
import function custom(a: i32, b: i32): i32 from 'host';
```

Functions are exported by default when used via the tagged template. Explicit export syntax for standalone compilation:

```
export function spherical(h, range, sill, nugget: f64): f64
  ...
end
```

### Dotted names (namespaces by convention)

Identifiers can contain dots. The compiler treats `physics.gravity` as a single name — no namespace machinery, just a naming convention:

```
function model.spherical(h, a, c1, c0: f64): f64
begin
  if (h <= 0.0) then
    model.spherical := 0.0
  else if (h >= a) then
    model.spherical := c0 + c1
  else
    model.spherical := c0 + c1 * (1.5 * h / a - 0.5 * (h / a) ** 3)
  end if
end

function model.gaussian(h, a, c1, c0: f64): f64
begin
  if (h <= 0.0) then
    model.gaussian := 0.0
  else
    model.gaussian := c0 + c1 * (1.0 - exp(-3.0 * (h / a) ** 2))
  end if
end
```

On the JS side, dotted exports are nested into objects:

```js
wasm.model.spherical(0.5, 1.0, 1.0, 0.1)  // nested access
wasm['model.spherical'](0.5, 1.0, 1.0, 0.1) // flat access also works
```

Multi-level nesting works: `a.b.c` becomes `wasm.a.b.c`. Local variables can also use dots (`var cfg.scale: f64`). Names starting with `wasm.`, `v128.`, or a SIMD type prefix (`f64x2.`, etc.) are reserved for builtins.

#### Imports and composability

Nested JS objects passed as imports are flattened to dotted names. The JS object structure mirrors the atra namespace:

```js
// nested object → atra sees math.lerp
const wasm = atra({ math: { lerp: (a, b, t) => a + (b - a) * t } })`
  function smooth(a, b, t: f64): f64
  begin
    smooth := math.lerp(a, b, t)
  end
`;
```

This makes atra modules composable — the output of one compilation feeds directly as input to another:

```js
// compile a library with namespaced functions
const linalg = atra`
  function linalg.dot(a, b: f64): f64
  begin
    linalg.dot := a * b
  end

  function linalg.scale(x, s: f64): f64
  begin
    linalg.scale := x * s
  end
`;

// linalg.linalg.dot() works on the JS side (nested exports)
// pass the whole thing as imports to another atra compilation
const app = atra({ ...linalg })`
  function compute(a, b, s: f64): f64
  begin
    compute := linalg.scale(linalg.dot(a, b), s)
  end
`;

app.compute(3.0, 4.0, 2.0)  // → 24.0
```

The convention is symmetric: atra outputs nested objects (`wasm.linalg.dot`), and atra accepts nested objects (`{ linalg: { dot: fn } }`). Flat dotted keys also work as imports (`{ 'linalg.dot': fn }`).

### Function references and indirect calls

Functions can be passed by reference and called indirectly via `call_indirect`. The `@` operator returns a function's table index:

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

function gaussian(h, range, sill, nugget: f64): f64
begin
  gaussian := nugget + sill * (1.0 - exp(-3.0 * (h / range)**2))
end

function exponential(h, range, sill, nugget: f64): f64
begin
  if (h == 0.0) then
    exponential := 0.0
  else
    exponential := nugget + sill * (1.0 - exp(-3.0 * h / range))
  end if
end

function eval_model(model: function(h, range, sill, nugget: f64): f64,
                    h, range, sill, nugget: f64): f64
begin
  eval_model := model(h, range, sill, nugget)
end
```

The `function(params): retType` syntax declares a function-typed parameter. At the Wasm level, these are `i32` table indices. Calling a function-typed variable emits `call_indirect`.

```js
const { eval_model } = atra`...`;
eval_model(0, 25.0, 80.0, 1.0, 0.1);  // spherical
eval_model(1, 25.0, 80.0, 1.0, 0.1);  // gaussian
eval_model(2, 25.0, 80.0, 1.0, 0.1);  // exponential
```

Table indices are assigned in declaration order (imports first, then local functions, sorted by their position in the source).

Function-typed variables also work as locals:

```
function fit(model_id: i32, h, range, sill, nugget: f64): f64
var model: function(h, range, sill, nugget: f64): f64
begin
  if (model_id == 0) then
    model := @spherical
  else if (model_id == 1) then
    model := @gaussian
  else
    model := @exponential
  end if
  fit := model(h, range, sill, nugget)
end
```

Bare function names inside a function body refer to the return accumulator (Fortran convention), so `@` is needed to get the table index. Outside a function body or for names that aren't the current function, bare names resolve normally through locals/globals.

Indirect calls as statements use `call`:

```
subroutine apply_model(model: function(h, range, sill, nugget: f64): f64,
                       gamma, dist: array f64; n: i32,
                       range, sill, nugget: f64)
begin
  for i := 0, n
    gamma[i] := model(dist[i], range, sill, nugget)
  end for
end
```

---

## Control flow

### If / else

```
if (h == 0.0) then
  spherical := 0.0
else if (h >= range) then
  spherical := nugget + sill
else
  spherical := nugget + sill * (1.5 * h / range - 0.5 * (h / range)**3)
end if
```

### If-expression (ternary)

`if` can be used as an expression. Lazy evaluation — only the taken branch executes. Returns a value:

```
x := if (cond > 0.0) then a else b
```

Compiles to Wasm `if (result T)` — branchless at the Wasm level. Can be nested:

```
classify := if (x < 0.0) then -1 else if (x == 0.0) then 0 else 1
```

### For loop

0-based, exclusive upper bound. Always.

```
! iterate i = 0, 1, 2, ..., n-1
for i := 0, n
  weights[i] := weights[i] / sum
end for
```

With step:

```
! iterate i = n-1, n-2, ..., 0
for i := n - 1, -1, -1
  ...
end for
```

### While loop

Condition checked before each iteration:

```
while (h < range)
  h := h + lag
end while
```

### Do...while

Body executes at least once, condition checked after:

```
do
  call search(xloc, yloc, zloc, ...)
  nclose := nclose + 1
while (nclose < min_samples)
```

### Break

Exit the innermost loop:

```
while (true)
  call try_solve(a, r, n, ising)
  if (ising == 0) then break
  n := n - 1
end while
```

### Early return

`call return(expr)` exits the current function immediately, returning `expr`. In subroutines, use `call return()` with no arguments. Compiles to Wasm `return` (0x0F).

```
function safediv(a, b: f64): f64
begin
  if (b == 0.0) then
    call return(0.0)
  end if
  safediv := a / b
end
```

Guard clause pattern — flat instead of nested:

```
function classify(x: f64): i32
begin
  if (x < 0.0) then
    call return(0 - 1)
  end if
  if (x == 0.0) then
    call return(0)
  end if
  classify := 1
end
```

Subroutine early return:

```
subroutine safe_write(arr: array i32; i, n, val: i32)
begin
  if (i >= n) then
    call return()
  end if
  arr[i] := val
end
```

### Tail calls

`tailcall f(args)` reuses the current stack frame instead of pushing a new one. Enables unbounded recursion in constant stack space. Compiles to Wasm `return_call` (0x12) / `return_call_indirect` (0x13).

```
function factorial(n, acc: i32): i32
begin
  if (n <= 1) then
    factorial := acc
  else
    tailcall factorial(n - 1, acc * n)
  end if
end
```

The callee's return type must match the current function's return type. Subroutines can only tailcall other subroutines. Functions returning `f64` can only tailcall functions returning `f64`, etc.

Works with indirect calls via function-typed variables:

```
function apply(f: function(x: f64): f64, x: f64): f64
begin
  tailcall f(x)
end
```

---

## Operators

### Arithmetic

| Operator | Description      |
|----------|------------------|
| `+`      | Addition         |
| `-`      | Subtraction      |
| `*`      | Multiplication   |
| `/`      | Division         |
| `**`     | Exponentiation   |
| `mod`    | Modulo (integer) |

### Compound assignment

| Operator | Equivalent       |
|----------|------------------|
| `+=`     | `x := x + e`    |
| `-=`     | `x := x - e`    |
| `*=`     | `x := x * e`    |
| `/=`     | `x := x / e`    |

Works on scalars and arrays. `a[i] += 1.0` desugars to `a[i] := a[i] + 1.0`.

### Comparison

| Operator | Description      |
|----------|------------------|
| `==`     | Equal            |
| `/=`     | Not equal        |
| `<`      | Less than        |
| `>`      | Greater than     |
| `<=`     | Less or equal    |
| `>=`     | Greater or equal |

### Logical

| Operator | Description |
|----------|-------------|
| `and`    | Logical and |
| `or`     | Logical or  |
| `not`    | Logical not |

### Bitwise (integer types only)

| Operator | Description      |
|----------|------------------|
| `&`      | Bitwise and      |
| `\|`     | Bitwise or       |
| `^`      | Bitwise xor      |
| `~`      | Bitwise not      |
| `<<`     | Shift left       |
| `>>`     | Shift right      |

Python-style split: words for logical, symbols for bitwise. No ambiguity.

### Precedence (high to low)

1. `**` (right associative)
2. Unary `-`, `not`, `~`
3. `*`, `/`, `mod`
4. `+`, `-`
5. `<<`, `>>`
6. `&`
7. `^`
8. `|`
9. `==`, `/=`, `<`, `>`, `<=`, `>=`
10. `and`
11. `or`

---

## Arrays

Arrays are regions in Wasm linear memory. They are not managed by atra — the host (JS) allocates them and passes base pointers as `i32` parameters. Square bracket syntax is sugar over `load`/`store` with offset calculation. This also eliminates the Fortran ambiguity between array access and function calls — `f[i]` is always an array, `f(x)` is always a call.

### 1D arrays

```
subroutine normalize(a: array f64; n: i32)
var
  i: i32;
  sum: f64;
begin
  sum := 0.0
  for i := 0, n
    sum := sum + a[i]
  end for
  for i := 0, n
    a[i] := a[i] / sum
  end for
end
```

`a[i]` desugars to `f64.load(a + i * 8)`.

### 2D arrays

Pass the stride explicitly. `a[i, stride, j]` desugars to `f64.load(a + (i * stride + j) * 8)`:

```
function trace(a: array f64; n: i32): f64
var
  i: i32;
begin
  trace := 0.0
  for i := 0, n
    trace := trace + a[i, n, i]
  end for
end
```

### Declared dimensions (alternative syntax)

```
function trace(a: array(n, n) f64; n: i32): f64
var
  i: i32;
begin
  trace := 0.0
  for i := 0, n
    trace := trace + a[i, i]
  end for
end
```

Where `array(n, n)` tells the compiler the shape, and `a[i, j]` desugars to `f64.load(a + (i * n + j) * 8)` automatically. The dimensions are parameters used only for offset calculation.

---

## Memory model

Wasm linear memory is a flat `ArrayBuffer` shared between JS and atra. Both sides see the same bytes.

### JS host allocates and orchestrates

```js
const memory = new WebAssembly.Memory({ initial: 256 }); // 16MB

const { spherical } = atra`...`;

// Write input data into memory
const coords = new Float64Array(memory.buffer, 0, 3000);   // xyz for 1000 samples
coords.set(myData);

// Call atra function — it reads/writes the same memory
instance.exports.estimate(0, 8000, 16000, 1000);

// Read results back
const output = new Float64Array(memory.buffer, 16000, 500);
```

No copying. JS writes in, atra computes, JS reads out. Same bytes.

### Memory layout convention

```
[0 ............. input_end]  — input data, written by JS
[input_end ... scratch_end]  — scratch space, bump allocator
[scratch_end .. output_end]  — output buffers, read by JS
```

### Bump allocator (optional)

For scratch space within atra:

```
var heap_ptr: i32;

function alloc(bytes: i32): i32
var
  ptr: i32;
begin
  ptr := heap_ptr;
  heap_ptr := heap_ptr + bytes;
  alloc := ptr
end

subroutine reset_heap(base: i32)
begin
  heap_ptr := base
end
```

No `free`. JS resets `heap_ptr` between invocations. Arena-style allocation — allocate scratch, compute, throw it all away.

### Limits

Wasm memory is addressed by `i32`: maximum 4GB. Browsers cap it at ~2-4GB in practice. For numerical kernels (variogram evaluation, kriging solves, single simulation realizations) this is more than enough. Multi-realization workflows use Web Workers, each with their own memory.

---

## JS integration

### Tagged template (primary API)

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

spherical(25.0, 80.0, 1.0, 0.1);
```

### With imports object

`atra({...})` returns a tagged template function with the imports closed over. Signatures are inferred from `.length`, assuming all `f64`:

```js
import { atra } from './atra.js';
import { myWeight, myTransform } from './utils.js';

const { estimate } = atra({ myWeight, myTransform })`
  function estimate(h, range, sill: f64): f64
  begin
    estimate := myTransform(myWeight(h, range), sill)
  end
`;
```

### Template interpolation

JS values become compile-time constants:

```js
const BLOCK_SIZE = 1000;
const MAX_NEIGHBORS = 64;

const { estimate } = atra`
  const block_size: i32 = ${BLOCK_SIZE};
  const max_neighbors: i32 = ${MAX_NEIGHBORS};

  function estimate(...): f64
  begin
    ...
  end
`;
```

**Strings** are spliced directly into the source — this is atra's source inclusion mechanism:

```js
const alpack = await load('./ext/atra/lib/alpack.src.js');

const { solve } = atra({ memory: mem })`
  ${std.include(alpack, 'alpack.dgetrf', 'alpack.dgetrs')}

  subroutine solve(A: array f64; n: i32; ...)
  begin
    call alpack.dgetrf(A, n, ipiv, info)
    call alpack.dgetrs(A, ipiv, b, n, 1)
  end
`;
```

`std.include(lib, ...names)` resolves transitive dependencies from the library's `deps` map and returns the concatenated source. Library modules export `{ sources, deps }` for this purpose. Individual routines are also available as named exports for manual inclusion: `${alpack.alpack_dgetrf}`.

**Functions** can also be interpolated as imports with optional type annotation:

```js
const { process } = atra`
  import callback = ${myCallback};                     ! infer (f64): f64 from .length
  import lookup(i: i32): i32 = ${indexLookup};         ! explicit types

  function process(data: array f64; n: i32): f64
  begin
    ...
  end
`;
```

### Direct compiler access

```js
import { atra } from './atra.js';

const source = `function add(a, b: f64): f64 ...`;

const bytes = atra.compile(source);    // Uint8Array of Wasm binary
const ast   = atra.parse(source);      // AST for inspection
const hex   = atra.dump(source);       // hex dump for debugging
```

---

## Compilation target

Atra compiles to standard WebAssembly binary format (`.wasm`). The compiler is a single JS file (~400-500 lines) containing:

- **Tokenizer** (~60 lines): keywords, identifiers, numbers, operators.
- **Parser** (~150 lines): recursive descent, LL(1), Pratt parser for expressions.
- **Code generator** (~150 lines): LEB128 encoding, section builders, opcode emission.
- **Symbol table** (~20 lines): tracks functions, locals, arrays.

No parser generators. No LLVM. No external dependencies. Fully auditable.

### Wasm mapping

| Atra                       | Wasm                                    |
|----------------------------|-----------------------------------------|
| `function`                 | `func` with result type                 |
| `subroutine`               | `func` without result                   |
| `var` locals               | `local` declarations                    |
| `const` globals            | `global` (immutable)                    |
| `var` globals              | `global` (mutable)                      |
| `:=` assignment            | `local.set` / `global.set` / `*.store`  |
| `if...then...else...end if`| `if...else...end`                       |
| `for`                      | `block { loop { br_if ... br } }`       |
| `while`                    | `block { loop { br_if ... br } }`       |
| `do...while`               | `loop { ... br_if }`                    |
| `break`                    | `br` to enclosing block                 |
| `call return(expr)`        | `return`                                |
| `tailcall f(args)`         | `return_call` / `return_call_indirect`  |
| `a[i]` (array access)      | `f64.load / f64.store` with offset math |
| `**`                       | repeated multiplication or `pow` import |
| `+`, `-`, `*`, `/`         | `f64.add`, `f64.sub`, `f64.mul`, `f64.div` |
| `&`, `\|`, `^`, `~`       | `i32.and`, `i32.or`, `i32.xor`, `i32.xor`+const |
| `<<`, `>>`                 | `i32.shl`, `i32.shr_s` / `i32.shr_u`   |

Expressions compile to stack operations in postfix order. `a + b * c` becomes:

```wat
local.get $a
local.get $b
local.get $c
f64.mul
f64.add
```

Wasm is a stack machine. Atra is infix sugar over postfix bytecode.

---

## Design rationale

### Why not just write WAT?

WAT (WebAssembly Text Format, whose full name abbreviates regrettably) uses S-expressions:

```wat
(func $spherical (param $h f64) (param $range f64) (param $sill f64) (param $nugget f64) (result f64)
  (if (result f64) (f64.eq (local.get $h) (f64.const 0.0))
    (then (f64.const 0.0))
    (else ...)))
```

Atra says the same thing in a syntax that humans can read and that geostatisticians already know.

### Why not compile C/Fortran with Emscripten?

Emscripten compiles your code plus an entire C runtime — allocator, string library, libc — into megabytes of Wasm. Atra compiles your math into kilobytes of Wasm. No runtime, no overhead, no hidden complexity.

### Why not just use JavaScript?

For most things, you should. Atra is for hot numerical loops where the V8 JIT's speculative optimization isn't enough, or where you want deterministic performance without warmup. The Wasm JIT (Liftoff + TurboFan) compiles ahead-of-time with no deoptimization surprises.

### Why the Fortran/Pascal hybrid?

Every choice is the pragmatic one:

- `:=` because `=` is ambiguous (is it assignment or comparison?)
- `begin...end` because it's clearer than matching `end do` / `end if` / `end function`
- `**` because writing `(h / range) * (h / range) * (h / range)` is criminal
- `subroutine` because the void/non-void distinction matters
- `var`/`const` because explicit is better than implicit
- `[i]` for arrays, `(x)` for calls — zero ambiguity, no symbol table needed to parse
- `and`/`or`/`not` for logic, `&`/`|`/`^`/`~` for bitwise — Python's split, cleanest of all worlds
- Wasm types because pretending `f64` is called `Real` helps nobody
- 0-based because the host is JavaScript and the target is Wasm

Neither Fortran nor Pascal. Both Fortran and Pascal. An arithmetic transpiler that doesn't owe allegiance to either lineage.

---

## Use cases

### GSLIB transcription

The core numerical subroutines of GSLIB — `cova3`, `ktsol`, `srchsupr`, `gauinv`, `sortem` — are self-contained math on arrays. They transcribe to atra almost line-for-line, with the JS host handling file IO, parameter parsing, and grid orchestration.

### Auditable notebooks

Atra source in a tagged template literal inside a JS cell. The compiled Wasm function is immediately available to subsequent code. Tweak a variogram parameter, recompute, see the result. No installation, no server, no build step.

### Educational tools

Students see the algorithm in a readable syntax, see the generated Wasm bytecode in a hex dump panel, see the results in a plot. The entire stack — source, compiler, runtime — is inspectable in the browser.

---

## What atra is not

- **Not a general-purpose language.** No strings, no IO, no dynamic allocation, no objects.
- **Not a Fortran compiler.** It won't compile existing Fortran source. Transcription is manual but mechanical.
- **Not a replacement for WebGPU.** For massively parallel numerical work, GPU compute shaders are the right tool. Atra is for sequential numerical kernels.
- **Not trying to be clever.** It's a formula translator. Arithmetic in, bytecode out.

---

## SIMD (v128)

WebAssembly SIMD processes multiple values per instruction using 128-bit vectors. Atra exposes this directly with four vector types:

| Type    | Lanes      | Scalar | Bytes |
|---------|------------|--------|-------|
| `f64x2` | 2 x f64   | `f64`  | 16    |
| `f32x4` | 4 x f32   | `f32`  | 16    |
| `i32x4` | 4 x i32   | `i32`  | 16    |
| `i64x2` | 2 x i64   | `i64`  | 16    |

All four map to Wasm's single `v128` type (0x7b). Atra tracks the semantic type at compile time and emits the correct SIMD opcodes.

### Arithmetic operators

Standard arithmetic operators work on vector types. Both operands must be the same vector type:

```
var a, b, c: f64x2

c := a + b    ! f64x2.add
c := a - b    ! f64x2.sub
c := a * b    ! f64x2.mul
c := a / b    ! f64x2.div (float vectors only)
c := -a       ! f64x2.neg
```

Division is supported for `f64x2` and `f32x4` only (no integer vector division in Wasm SIMD).

### Constructors

Build vectors from scalar values:

```
var v: f64x2
v := f64x2(3.14, 2.71)     ! v128.const when both args are constants
v := f64x2(x, y)           ! splat(x) + replace_lane(1, y) for runtime values

var w: f32x4
w := f32x4(1.0, 2.0, 3.0, 4.0)

var u: i32x4
u := i32x4(10, 20, 30, 40)
```

Constant constructors emit `v128.const` (16 inline bytes). Non-constant constructors use `splat` + `replace_lane`.

### Lane access

```
! Splat: broadcast scalar to all lanes
v := f64x2.splat(x)          ! [x, x]

! Extract a single lane as scalar
x := f64x2.extract_lane(v, 0)

! Replace one lane, keep others
v := f64x2.replace_lane(v, 1, y)
```

Lane indices must be compile-time constants. Valid ranges: 0-1 for `f64x2`/`i64x2`, 0-3 for `f32x4`/`i32x4`.

### Unary operations

```
v := sqrt(a)    ! f64x2.sqrt (float vectors only)
v := abs(a)     ! f64x2.abs  (float vectors only)
v := -a         ! f64x2.neg  (all vector types)
```

Also available as namespaced calls: `f64x2.sqrt(a)`, `f64x2.abs(a)`, `f64x2.neg(a)`.

### Min / Max

```
v := min(a, b)    ! f64x2.min (float vectors only)
v := max(a, b)    ! f64x2.max (float vectors only)
```

### Comparisons

Vector comparisons return a v128 bitmask — each lane is all-1s (true) or all-0s (false). They do not return i32:

```
mask := f64x2.eq(a, b)     ! per-lane equality → v128 bitmask
mask := f64x2.lt(a, b)     ! per-lane less-than
```

Operators also work: `a == b`, `a < b`, etc. on vector operands emit SIMD compares.

Available comparisons: `eq`, `ne`, `lt`, `gt`, `le`, `ge`. Integer variants use signed comparison (`lt_s`, `gt_s`, etc.).

### Bitwise operations on v128

Combine comparison masks or manipulate vector bits:

```
result := v128.and(a, mask)
result := v128.or(mask1, mask2)
result := v128.xor(a, b)
result := v128.not(mask)
```

### Memory operations

Load/store 16 bytes at once. Address = `base + index * 16`:

```
v := v128.load(arr, i)        ! load 16 bytes from arr + i*16
call v128.store(arr, i, v)    ! store 16 bytes to arr + i*16
```

Array subscript syntax (`arr[i]`) also works with vector-typed arrays — the element size is 16 bytes.

### Example: vectorized array sum

```js
const memory = new WebAssembly.Memory({ initial: 1 });
const { vsum } = atra({ memory })`
  function vsum(arr: array f64; n: i32): f64
  var
    i, n2: i32
    acc, v: f64x2
  begin
    acc := f64x2(0.0, 0.0)
    n2 := n / 2
    for i := 0, n2
      v := v128.load(arr, i)
      acc := acc + v
    end for
    vsum := f64x2.extract_lane(acc, 0) + f64x2.extract_lane(acc, 1)
  end
`;
```

No auto-vectorization. Users explicitly declare vector-typed variables and write vector code. The compiler maps it 1:1 to Wasm SIMD instructions.
