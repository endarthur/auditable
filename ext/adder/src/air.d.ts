// Type declarations for @gcu/adder/air.
// Same API shape as @gcu/adder, but transpiles adder → AIR → JS via @gcu/air.
// Requires @gcu/air as a peer dependency.

import type { RunOpts } from './index';

export type { RunOpts } from './index';

/** Execute adder source as a module via AIR transpilation.
 *  Returns an object mapping bound names to values. */
export function run(code: string, opts?: RunOpts): Promise<Record<string, unknown>>;

/** Evaluate a single adder expression via AIR transpilation. */
export function evalExpr(code: string, opts?: RunOpts): Promise<unknown>;

/** Compile once, run many. AIR lowering and JS emission happen once;
 *  subsequent `.run(opts?)` calls reuse the compiled function. */
export function compile(code: string): Promise<{
  /** The AIR intermediate representation — inspect for debugging. */
  air: unknown;
  /** Free names the code expects to find in scope (after JS-intrinsic filtering). */
  imports: string[];
  run(opts?: RunOpts): Promise<Record<string, unknown>>;
}>;

/** Parse-only check — identical semantics to @gcu/adder's isIncomplete. */
export function isIncomplete(code: string): boolean;

export class AdderRuntimeError extends Error {}
