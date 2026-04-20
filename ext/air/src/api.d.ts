// Type declarations for @gcu/air (main entry).

/** An acorn-like Parser instance. The only method we call is `parse(code, opts)`. */
export interface Parser {
  parse(code: string, opts: {
    ecmaVersion: string | number;
    sourceType: string;
    locations: boolean;
  }): unknown;
}

/** AIR module representation — opaque to consumers, inspect for debugging. */
export type AirModule = {
  ops: unknown[];
  symbol_table: unknown;
  exports: Map<string, { type: AirType }>;
  imports: Set<string>;
  defines: Set<string>;
  side_effects: unknown;
};

export type AirType = {
  kind: string;
  [key: string]: unknown;
};

export interface AnalysisResult {
  defines: Set<string>;
  uses: Set<string>;
  air: AirModule;
}

/** Parse JS/TS source, lower to AIR, run passes, and extract defines/uses.
 *  Returns null if parse or lowering fails (the caller should fall back).
 *
 *  @param code - module source code
 *  @param parser - an acorn-compatible Parser (extend with acorn-typescript for TS)
 *  @param allDefined - optional set of names defined in sibling modules.
 *    When provided, `uses` is restricted to names in this set; when absent,
 *    every free non-JS-global name becomes a use.
 */
export function analyzeModule(code: string, parser: Parser, allDefined?: Set<string>): AnalysisResult | null;

/** Back-compat alias for analyzeModule.
 *  @deprecated since 0.2.0 — use analyzeModule */
export const analyzeCell: typeof analyzeModule;

/** Extract only defined names from a source module. Lighter than analyzeModule. */
export function extractDefines(code: string, parser: Parser): Set<string> | null;

/** Extract a name→type map from an AIR module's exports. */
export function extractExportTypes(module: AirModule | null): Map<string, AirType> | null;

// ── lowering ──

export function lowerJS(ast: unknown, code: string): AirModule;
export function lowerAdder(ast: unknown, code: string): AirModule;
export function lowerSoft(ast: unknown, code: string): AirModule;

export class AirLowerError extends Error {}
export class SoftLowerError extends Error {}

// ── passes ──

export function runPasses(air: AirModule, opts?: Record<string, unknown>): void;
export function extractDependencies(air: AirModule): Set<string>;

// ── emission ──

/** Emit JavaScript for an AIR module.
 *  @param module - the lowered AIR module
 *  @param scopeKeys - names that will be available as function parameters
 *  @param injectedNames - additional always-in-scope names (e.g. `ui`, `std` in Auditable)
 *  @param options - reserved for future use
 *  @returns a JS body string; wrap in `Function(...scopeKeys, body)` or `AsyncFunction`
 */
export function emitJS(
  module: AirModule,
  scopeKeys: string[],
  injectedNames: string[],
  options?: Record<string, unknown>
): string;

/** True if the AIR module contains `await` or other async-forcing ops —
 *  means the emitted body must be wrapped in an AsyncFunction. */
export function needsAsync(module: AirModule): boolean;
