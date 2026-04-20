// Type declarations for @gcu/adder (main entry).
// See @gcu/adder/air for the AIR-transpilation path (same API, 15-300x faster).

/** A @gcu/vfs-shaped virtual filesystem. Only the interface is typed here;
 *  any object with readFile/writeFile/stat/etc. methods is acceptable. */
export type VFSLike = object;

export interface RunOpts {
  /** Names injected into scope (lowest precedence). */
  globals?: Record<string, unknown>;
  /** Names injected into scope (higher precedence than globals; Python convention). */
  locals?: Record<string, unknown>;
  /** Override for Python's `print()`. Receives raw args the way Python does. */
  print?: (...args: unknown[]) => void;
  /** Where the default `print` writes its formatted output. */
  stdout?: (s: string) => void;
  /** Where runtime error output writes. */
  stderr?: (s: string) => void;
  /** Called when `input()` needs the next line. Return null on EOF. */
  stdin?: () => string | null | Promise<string | null>;
  /** Override for `input()` entirely (skips the stdin indirection). */
  input?: (prompt?: unknown) => string | Promise<string>;
  /** VFS-shaped object exposed to `open()`, `os`, `pathlib`, `pathlib.Path`. */
  vfs?: VFSLike;
}

/** Execute adder source as a module. Returns an object mapping bound names to values. */
export function run(code: string, opts?: RunOpts): Promise<Record<string, unknown>>;

/** Evaluate a single adder expression and return its value. */
export function evalExpr(code: string, opts?: RunOpts): Promise<unknown>;

/** Compile once, run many. The returned module's `.run(opts?)` can be called
 *  repeatedly with different bindings — the AST is reused. */
export function compile(code: string): {
  ast: unknown;
  run(opts?: RunOpts): Promise<Record<string, unknown>>;
};

/** True if adder would want more input to finish parsing (unclosed bracket,
 *  missing block body, etc.). Useful for REPL line-continuation prompts. */
export function isIncomplete(code: string): boolean;

/** Thrown by the built-in `input()` when no stdin is configured, or on EOF. */
export class AdderRuntimeError extends Error {}

// ── language core ──

export function adderTokenize(code: string): unknown[];
export function adderParse(code: string): unknown;
export function adderEval(ast: unknown, scope: AdderScope): Promise<unknown>;

export class AdderScope {
  constructor();
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  vars: Map<string, unknown>;
  parent: AdderScope | null;
  globals: AdderScope | null;
  nonlocals: Set<string>;
}

// ── builtins & runtime ──

export class AdderRange {
  constructor(start: number, stop?: number, step?: number);
  [Symbol.iterator](): Iterator<number>;
}

export class AdderError extends Error {
  name: string;
}

export class Complex {
  constructor(real: number, imag: number);
  real: number;
  imag: number;
}

/** Python's type(x).__name__ equivalent. */
export function pyTypeName(v: unknown): string;
/** Python's bool() — truthiness. */
export function pyBool(v: unknown): boolean;
/** Python's repr(). */
export function pyRepr(v: unknown): string;
/** Python's str(). */
export function pyStr(v: unknown): string;
/** Python-style synchronous iterator factory. */
export function pyIter(obj: unknown): IterableIterator<unknown>;
/** Collect an async iterable into a list. */
export function pyCollect(obj: unknown): Promise<unknown[]>;
/** Python's getattr(obj, name). */
export function adderGetAttr(obj: unknown, attr: string): unknown;
/** Build the Python builtins namespace. The returned object is mutable. */
export function adderBuiltins(printFn: (s: string) => void): Record<string, unknown>;
/** Python's format(value, spec). */
export function pyFormatValue(value: unknown, spec?: string): string;

/** Runtime helpers used by AIR-transpiled code. Exposed for advanced integration;
 *  normal users shouldn't need to touch this. */
export const _py: Record<string, unknown>;

// ── tagged template ──

/** Tagged-template helper that parses + evaluates the enclosed adder code. */
export function adderTag(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
/** Alias for `adderTag`. */
export const mpy: typeof adderTag;
