// Type declarations for @gcu/soft (main entry).
// See @gcu/soft/air for the AIR-transpilation path (same API, faster execution).

export interface RunOpts {
  /** Names injected into scope (lowest precedence). */
  globals?: Record<string, unknown>;
  /** Names injected into scope (higher precedence than globals). */
  locals?: Record<string, unknown>;
  /** Override for `say` — receives the raw value (unformatted). */
  say?: (value: unknown) => void;
  /** Where the default `say` writes its formatted output. */
  stdout?: (s: string) => void;
  /** Where runtime error output writes. */
  stderr?: (s: string) => void;
  /** Reserved for future stdin support. */
  stdin?: () => string | null | Promise<string | null>;
  /** Optional host object for cell-handler integrations. */
  host?: Record<string, unknown>;
}

export interface RunResult {
  /** Scope mapping bound names to values after execution. */
  scope: Record<string, unknown>;
  /** Every value emitted by `say`, in order (also delivered via the `say` callback as each fires). */
  output: unknown[];
}

/** Execute soft source. Returns { scope, output }. */
export function run(code: string, opts?: RunOpts): RunResult;

/** Evaluate a single soft expression — returns `it` (soft's implicit result). */
export function evalExpr(code: string, opts?: RunOpts): unknown;

/** Compile once, run many. */
export function compile(code: string): {
  ast: unknown;
  run(opts?: RunOpts): RunResult;
};

/** True if soft would want more input to finish parsing. */
export function isIncomplete(code: string): boolean;

export class SoftRuntimeError extends Error {}

// ── language core ──

export function softTokenize(code: string): unknown[];
export function softParse(code: string): unknown;
/** Low-level evaluator. Most callers should use run() instead. */
export function softEval(code: string | unknown, options?: {
  globals?: Record<string, unknown>;
  scopeInit?: Record<string, unknown>;
  host?: Record<string, unknown>;
  onSay?: (value: unknown) => void;
  maxSteps?: number;
  maxCallDepth?: number;
}): RunResult;

/** Parsed locale definition — the shape of the JSON files under `locales/`. */
export interface SoftLocale {
  locale: string;
  keywords: Record<string, string[]>;
  noise?: string[];
}

/** Install an active soft locale. Pass a parsed locale object (as exported
 *  from the JSON files under `locales/`), or `null` to reset to English. */
export function softSetLocale(locale: SoftLocale | null): void;

/** Get the active locale lookup table (word → canonical English keyword), or null. */
export function softGetLocale(): Record<string, string> | null;
/** Render a value to its display string (soft's display convention). */
export function softString(value: unknown): string;

/** Runtime helpers used by AIR-transpiled code. */
export const _soft: Record<string, unknown>;

/** Tagged-template helper. */
export function softTag(strings: TemplateStringsArray, ...values: unknown[]): RunResult;
