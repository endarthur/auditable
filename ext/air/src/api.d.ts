// Type declarations for @gcu/air (main entry).

/** An acorn-like Parser instance. The only method we call is `parse(code, opts)`. */
export interface Parser {
  parse(code: string, opts: {
    ecmaVersion: string | number;
    sourceType: string;
    locations: boolean;
    ranges: boolean;
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
  /** The parsed ESTree AST. Exposed so downstream tooling (bundlers,
   *  formatters) can reuse the parse rather than re-parsing. */
  ast: unknown;
}

/** Parse JS/TS source into an ESTree AST with AIR's default options
 *  (module source type, locations + ranges enabled). Single source of truth
 *  for parser configuration; downstream tooling should prefer this over
 *  reinventing the option set.
 *
 *  @param code - module source code
 *  @param parser - optional acorn-compatible Parser; required outside browser
 *    contexts where window.Acorn is not available
 */
export function parseModule(code: string, parser?: Parser): unknown;

/** Parse JS/TS source, lower to AIR, run passes, and extract defines/uses.
 *  Returns null if parse or lowering fails (the caller should fall back).
 *  The returned object also includes the parsed AST so consumers can reuse it.
 *
 *  @param code - module source code
 *  @param parser - optional acorn-compatible Parser (uses window.Acorn if omitted)
 *  @param allDefined - optional set of names defined in sibling modules.
 *    When provided, `uses` is restricted to names in this set; when absent,
 *    every free non-JS-global name becomes a use.
 */
export function analyzeModule(code: string, parser?: Parser, allDefined?: Set<string>): AnalysisResult | null;

/** Back-compat alias for analyzeModule.
 *  @deprecated since 0.2.0 — use analyzeModule */
export const analyzeCell: typeof analyzeModule;

/** Extract only defined names from a source module. Lighter than analyzeModule. */
export function extractDefines(code: string, parser?: Parser): Set<string> | null;

/** Extract a name→type map from an AIR module's exports. */
export function extractExportTypes(module: AirModule | null): Map<string, AirType> | null;

// ── ES module declaration extraction ──

export type ImportDescriptor =
  | { kind: 'named'; source: string; specifiers: Array<{ imported: string; local: string }> }
  | { kind: 'namespace'; source: string; local: string }
  | { kind: 'default'; source: string; local: string }
  | { kind: 'side-effect'; source: string };

export type ExportDescriptor =
  | { kind: 'named'; specifiers: Array<{ local: string; exported: string }> }
  | { kind: 'reexport-named'; source: string; specifiers: Array<{ local: string; exported: string }> }
  | { kind: 'reexport-wildcard'; source: string; exported: string | null }
  | { kind: 'declaration'; declaration: unknown }
  | { kind: 'default'; declaration: unknown };

/** Walk top-level ImportDeclarations in an AST and return structured descriptors.
 *  Consumers (bundlers, reactive-DAG tooling) decide how to handle each kind. */
export function extractImports(ast: unknown): ImportDescriptor[];

/** Walk top-level ExportDeclarations in an AST and return structured descriptors. */
export function extractExports(ast: unknown): ExportDescriptor[];

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
