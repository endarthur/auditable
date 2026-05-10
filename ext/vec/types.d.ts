// Type declarations for @gcu/vec.
//
// All operations on NdArray return new NdArray instances; there are no
// in-place mutations beyond NdArray.set. Slicing, reshape, and transpose
// always copy. dtype is always 'f64' in v1.

export type Shape = number[];

export type DType = 'f64';

/** A contiguous row-major `Float64Array` with shape metadata. */
export class NdArray {
  /** Backing typed array (read access encouraged; mutate at your own risk). */
  readonly data: Float64Array;
  /** Per-axis sizes. */
  readonly shape: Shape;
  /** Per-axis strides (row-major). */
  readonly strides: Shape;
  /** Total element count = product(shape). */
  readonly size: number;
  /** Number of axes. */
  readonly ndim: number;
  /** Element dtype (`'f64'` always in v1). */
  readonly dtype: DType;

  constructor(data: Float64Array, shape: Shape);

  /** Scalar element lookup. Indices must match `ndim`. */
  get(...indices: number[]): number;
  /** In-place set. Pass indices then the value as the last argument. */
  set(...args: number[]): void;
  /** 2D-only: return a 1D copy of row `i`. */
  row(i: number): NdArray;
  /** 2D-only: return a 1D copy of column `j`. */
  col(j: number): NdArray;
  /** Convert to nested JS array (1D → flat, N-D → nested). */
  toArray(): number | number[] | unknown[];
  /** Human-readable representation. */
  toString(): string;
}

export function shapeProduct(shape: Shape): number;
export function computeStrides(shape: Shape): Shape;

// ── Creation ─────────────────────────────────────────────────────────

export function zeros(shape: Shape | number): NdArray;
export function ones(shape: Shape | number): NdArray;
export function full(shape: Shape | number, value: number): NdArray;
/** Python-style range. `range(5)`, `range(2, 7)`, `range(0, 10, 2)`. */
export function range(start: number, end?: number, step?: number): NdArray;
export function linspace(a: number, b: number, n: number): NdArray;
export function eye(n: number): NdArray;
/** From nested array (auto-shape) or flat iterable + explicit shape, or copy NdArray. */
export function from(source: number[] | unknown[] | Iterable<number> | NdArray, shape?: Shape | number): NdArray;

// ── Element-wise binary (broadcasting) ───────────────────────────────

export function add(a: NdArray | number, b: NdArray | number): NdArray;
export function sub(a: NdArray | number, b: NdArray | number): NdArray;
export function mul(a: NdArray | number, b: NdArray | number): NdArray;
export function div(a: NdArray | number, b: NdArray | number): NdArray;
export function pow(a: NdArray | number, b: NdArray | number): NdArray;

// ── Element-wise unary ───────────────────────────────────────────────

export function neg(a: NdArray): NdArray;
export function abs(a: NdArray): NdArray;
export function sqrt(a: NdArray): NdArray;
export function log(a: NdArray): NdArray;
export function exp(a: NdArray): NdArray;
export function sin(a: NdArray): NdArray;
export function cos(a: NdArray): NdArray;
export function tan(a: NdArray): NdArray;

// ── Reductions ───────────────────────────────────────────────────────

export interface AxisOpts { axis?: number; }
export interface VarOpts extends AxisOpts { ddof?: number; }

/** Sum without axis returns scalar; with axis returns NdArray (axis dropped). */
export function sum(a: NdArray, opts?: AxisOpts): number | NdArray;
export function mean(a: NdArray, opts?: AxisOpts): number | NdArray;
export function max(a: NdArray, opts?: AxisOpts): number | NdArray;
export function min(a: NdArray, opts?: AxisOpts): number | NdArray;
export function std(a: NdArray, opts?: VarOpts): number | NdArray;
export function variance(a: NdArray, opts?: VarOpts): number | NdArray;
/** Numpy-flavored alias for `variance`. */
export const var_: typeof variance;
/** L2 norm of the entire flattened array. */
export function norm(a: NdArray): number;
/** Overloaded by ndim: 1D·1D=scalar, 2D·1D=mat-vec, 1D·2D=vec-mat, 2D·2D=matmul. */
export function dot(a: NdArray, b: NdArray): number | NdArray;

// ── Linear algebra: multiplication, transpose, closed-form ───────────

export function matmul(A: NdArray, B: NdArray): NdArray;
export function transpose(A: NdArray): NdArray;

export function det2(A: NdArray): number;
export function det3(A: NdArray): number;
export function det4(A: NdArray): number;
export function inv2(A: NdArray): NdArray;
export function inv3(A: NdArray): NdArray;
export function inv4(A: NdArray): NdArray;

// ── Linear algebra: solve / cholesky / lstsq ─────────────────────────

/** Solve A x = b. b can be 1D (single rhs) or 2D (multi-rhs). LU + partial pivoting. */
export function solve(A: NdArray, b: NdArray): NdArray;
/** Determinant via LU (returns 0 on singular). */
export function det(A: NdArray): number;
/** Inverse via LU + back-solves (throws on singular). */
export function inv(A: NdArray): NdArray;
/** Cholesky factorization of SPD matrix; returns lower-triangular L. */
export function cholesky(A: NdArray): NdArray;
/** Two triangular solves given precomputed L from cholesky. */
export function solveCholesky(L: NdArray, b: NdArray): NdArray;
/** Least squares via normal equations + Cholesky (well-conditioned A only). */
export function lstsq(A: NdArray, b: NdArray): NdArray;

// ── Linear algebra: symmetric eigendecomposition ─────────────────────

export interface EigResult {
  /** 1D NdArray of eigenvalues, sorted descending. */
  values: NdArray;
  /** 2D NdArray with eigenvectors as columns; orthonormal basis. */
  vectors: NdArray;
}

export interface EigOpts { maxSweeps?: number; tol?: number; }

/** Symmetric 3×3 eigendecomposition via Smith/Cardano closed-form. */
export function eigSym3(A: NdArray): EigResult;
/** Symmetric N×N eigendecomposition via Jacobi rotations. */
export function eigSym(A: NdArray, opts?: EigOpts): EigResult;

// ── Shape ops ────────────────────────────────────────────────────────

export interface SliceRange {
  start?: number;
  end?: number;
  step?: number;
}

export function reshape(a: NdArray, newShape: Shape): NdArray;
export function flatten(a: NdArray): NdArray;
export function copy(a: NdArray): NdArray;
/** Per-axis slicing. `null`/`undefined`/missing entries keep the axis in full. */
export function slice(a: NdArray, ranges: (SliceRange | null | undefined)[]): NdArray;

// ── Broadcast helpers (low-level; exposed for advanced use) ──────────

export function broadcastShapes(shapeA: Shape, shapeB: Shape): Shape;
export function broadcastStrides(srcShape: Shape, srcStrides: Shape, targetShape: Shape): Shape;
export function broadcastBinary(a: NdArray, b: NdArray, fn: (x: number, y: number) => number): NdArray;
export function shapesEqual(a: Shape, b: Shape): boolean;
