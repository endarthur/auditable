// Type declarations for @gcu/soft/air.
// Requires @gcu/air as a peer dependency.

import type { RunOpts, RunResult } from './index';

export type { RunOpts, RunResult } from './index';

/** Execute soft source via AIR transpilation. Returns { scope, output }. */
export function run(code: string, opts?: RunOpts): Promise<RunResult>;

/** Evaluate a single soft expression via AIR transpilation. */
export function evalExpr(code: string, opts?: RunOpts): Promise<unknown>;

/** Compile once, run many. */
export function compile(code: string): Promise<{
  air: unknown;
  imports: string[];
  run(opts?: RunOpts): Promise<RunResult>;
}>;

export function isIncomplete(code: string): boolean;
export class SoftRuntimeError extends Error {}
