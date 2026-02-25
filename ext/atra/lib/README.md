# ALAS / ALPACK

Dense linear algebra for [atra](https://github.com/endarthur/auditable) (Wasm).

**ALAS** (Auditable Linear Algebra Subprograms) -- vector/matrix primitives (BLAS equivalent).
**ALPACK** (Auditable Linear Algebra PACKage) -- factorizations & solvers (LAPACK equivalent).

Written in atra, compiled to WebAssembly. Runs in any browser or Wasm runtime.

## Implemented routines

### ALAS Level 1 -- vector-vector

| Routine | Signature | Description |
|---------|-----------|-------------|
| `dscal` | `(x, n, alpha)` | `x := alpha * x` |
| `dcopy` | `(x, y, n)` | `y := x` |
| `daxpy` | `(x, y, n, alpha)` | `y := alpha * x + y` (SIMD) |
| `ddot` | `(x, y, n) : f64` | dot product `x^T y` (SIMD) |
| `dnrm2` | `(x, n) : f64` | Euclidean norm `||x||_2` (SIMD) |
| `dswap` | `(x, y, n)` | swap `x` and `y` |
| `dasum` | `(x, n) : f64` | sum of `|x_i|` |
| `drot` | `(x, y, n, c, s)` | apply Givens rotation |
| `drotg` | `(a, b, cs) : f64` | generate Givens rotation `(c, s, r)` |
| `idamax` | `(x, n) : i32` | index of max `|x_i|` |

### ALAS Level 2 -- matrix-vector

| Routine | Signature | Description |
|---------|-----------|-------------|
| `dgemv` | `(a, x, y, m, n, alpha, beta)` | `y := alpha * A * x + beta * y` |
| `dtrsv` | `(a, x, n, uplo, trans)` | triangular solve `A * x = b` |
| `dger` | `(a, x, y, m, n, alpha)` | rank-1 update `A += alpha * x * y^T` |
| `dsymv` | `(a, x, y, n, alpha, beta)` | symmetric `y := alpha * A * x + beta * y` |
| `dsyr` | `(a, x, n, alpha)` | symmetric rank-1 `A += alpha * x * x^T` |
| `dsyr2` | `(a, x, y, n, alpha)` | symmetric rank-2 `A += alpha * (x*y^T + y*x^T)` |
| `dtrmv` | `(a, x, n, uplo, trans, diag)` | triangular multiply `x := A * x` |

### ALAS Level 3 -- matrix-matrix

| Routine | Signature | Description |
|---------|-----------|-------------|
| `dgemm` | `(a, b, c, m, n, k, alpha, beta)` | `C := alpha * A * B + beta * C` |

### ALPACK -- factorizations & solvers

| Routine | Signature | Description |
|---------|-----------|-------------|
| `dpotrf` | `(a, n, info)` | Cholesky: `A = L * L^T` |
| `dpotrs` | `(l, b, n, nrhs)` | solve via Cholesky factor |
| `dgetrf` | `(a, n, ipiv, info)` | LU with partial pivoting: `A = P * L * U` |
| `dgetrs` | `(lu, ipiv, b, n, nrhs)` | solve via LU factors |
| `dgesv` | `(a, b, n, nrhs, ipiv, info)` | solve `A * X = B` (LU convenience) |
| `dtrtri` | `(a, n, info)` | invert lower triangular matrix |
| `dsyev3` | `(a, w)` | 3x3 symmetric eigenvalues (Cardano) |
| `dsyev` | `(a, w, n, info)` | symmetric eigenvalues (Jacobi) |

## Memory model

- All matrices are **row-major**, flat in linear memory.
- 2D indexing: `a[i, n, j]` where `n` is the number of columns (stride). This computes `base + (i * n + j) * 8` bytes.
- Caller allocates and provides all buffers. No internal allocation.
- `info[0] = 0` on success; positive values indicate errors (e.g., non-positive-definite matrix, singular pivot).
- Array parameters are byte offsets into Wasm linear memory.

## SIMD

`daxpy`, `ddot`, and `dnrm2` use `f64x2` SIMD (128-bit, 2 doubles per lane) with scalar tails for odd lengths.

The atra compiler supports `f64x2.relaxed_madd` (fused multiply-add: `a*b+c` with single rounding), available in all major browsers. This enables future SIMD-optimized inner loops for `dgemv`/`dgemm`.

## Design constraints

ALPACK targets small to medium dense problems (n = 3--200). Wasm limitations shape the design:

- **i32 addressing**: matrix element indices are `i * n + j` in i32 arithmetic. Overflow at ~16K rows/columns for contiguous matrices.
- **4 GB memory cap**: Wasm linear memory is 32-bit addressed. A 16K x 16K f64 matrix is 2 GB.
- **No threads**: no parallel BLAS. Single-threaded only.
- **No cache blocking**: Wasm doesn't expose cache hierarchy. Simple loop nesting is fine for the target problem sizes.

ALPACK does not compete with optimized native BLAS (OpenBLAS, MKL) for large problems. It fills the gap where you need dense linear algebra in the browser without shipping a 5 MB Emscripten build.

## Usage

### Source distribution (`std.include`)

Cherry-pick routines. Dependencies resolve automatically. Everything compiles into one Wasm module.

```js
const alas = await load("@atra/alpack.src")

// include specific routines (transitive deps auto-resolved)
const src = std.include(alas, 'alas.dgemv', 'alpack.dgesv')

const solver = atra`
${src}
subroutine solve(a: array f64; b: array f64; n: i32;
                 ipiv: array i32; info: array i32)
begin
  call alpack.dgesv(a, b, n, 1, ipiv, info)
end
`
```

### Binary distribution (`load`)

Pre-compiled Wasm with all routines. No atra dependency needed.

```js
const alpack = await load("@atra/alpack")
const lib = alpack.instantiate()
// lib.alas.ddot(xPtr, yPtr, n), lib.alpack.dgesv(...), etc.
```

## Roadmap

### High priority

- **`dtrsm`** -- triangular solve with multiple RHS (Level 3). Required for blocked Cholesky/LU.
- **`dsyrk` / `dsyr2k`** -- symmetric rank-k updates (Level 3). Building blocks for Cholesky on larger systems.

### Medium priority

- **`dgeqrf` + `dormqr`** -- QR factorization via Householder reflections. Foundation for least squares.
- **`dgels`** -- least squares solve via QR. The main user-facing routine for overdetermined systems.

### Low priority

- **`dgesvd`** -- singular value decomposition. Complex implementation (bidiagonal reduction + QR iteration).
- **`dgeev`** -- non-symmetric eigenvalues. Requires Hessenberg reduction + QR algorithm.
- **Banded solvers** (`dgbtrf`/`dgbtrs`) -- for sparse-banded systems (FEM, finite differences).

### Won't do

- Thread-parallel BLAS (Wasm has no shared memory in this context)
- Cache blocking / tiling (not beneficial at target problem sizes)
- Complex arithmetic (`zgemm` etc.)
- Packed/band storage formats (marginal benefit for small n)
