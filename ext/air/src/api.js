// @gcu/air — Public API
// Clean interface matching existing parseNames/findUses output shapes

import { lowerJS } from './lower/js.js';
import { lowerAdder, AirLowerError } from './lower/adder.js';
import { lowerSoft, SoftLowerError } from './lower/soft.js';
import { runPasses, extractDependencies } from './passes.js';
import { emitJS, needsAsync } from './emit-js.js';

// Debug logging — true during development, settable via window._airDebug
let _airDebug = (typeof window !== 'undefined') ? (window._airDebug ?? true) : false;

// JS_GLOBALS: ambient names that should not be treated as module imports
// (global intrinsics, browser globals, common environment provisions).
const JS_GLOBALS = new Set([
  'Math', 'console', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData',
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'TextEncoder', 'TextDecoder',
  'WebAssembly', 'Atomics',
  'document', 'window', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'indexedDB',
  'crypto', 'performance', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa',
  'CompressionStream', 'DecompressionStream',
  'Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'AbortController', 'AbortSignal',
  'EventSource', 'WebSocket',
  'Image', 'CanvasRenderingContext2D', 'OffscreenCanvas',
  'globalThis', 'self', 'this',
  'arguments',
]);

// Single source of truth for parser options. Downstream tooling (bundlers,
// formatters) that asks AIR for an AST gets byte ranges + source positions
// for free.
const DEFAULT_PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  locations: true,
  ranges: true,
};

// Lazily-created parser instance. Set at browser init (from window.Acorn) or
// on first parseModule() call that provides a parser factory.
let _cachedParser = null;

function _getDefaultParser() {
  if (_cachedParser) return _cachedParser;
  if (typeof window !== 'undefined' && window.Acorn) {
    const { Parser, tsPlugin } = window.Acorn;
    _cachedParser = Parser.extend(tsPlugin());
    return _cachedParser;
  }
  return null;
}

/**
 * Parse a JS/TS module into an ESTree AST with AIR's default options
 * (module source type, locations and ranges enabled). Single source of truth
 * for parser configuration — downstream tooling should call this rather than
 * reinventing the option set.
 *
 * @param {string} code - module source code
 * @param {object} [parser] - Acorn parser instance. Optional in browser
 *   contexts where window.Acorn is available; required otherwise.
 * @returns {object} ESTree Program node
 */
export function parseModule(code, parser) {
  const p = parser || _getDefaultParser();
  if (!p) throw new Error('parseModule: no parser available. Pass one explicitly, or ensure window.Acorn is loaded in the browser.');
  return p.parse(code, DEFAULT_PARSE_OPTIONS);
}

/**
 * Analyze a JS/TS module: parse, lower to AIR, run passes, extract defines/uses.
 * Returns { defines, uses, air, ast } on success, or null if parsing/lowering fails.
 *
 * @param {string} code - module source code
 * @param {object} [parser] - Acorn parser instance; optional in browser
 * @param {Set<string>} [allDefined] - if provided, restricts `uses` to names defined
 *   elsewhere in a set of sibling modules (used by Auditable's cell-scope model).
 *   Pass null/undefined for "any free name is a use."
 * @returns {{ defines: Set<string>, uses: Set<string>, air: object, ast: object } | null}
 */
export function analyzeModule(code, parser, allDefined) {
  try {
    const ast = parseModule(code, parser);
    const module = lowerJS(ast, code);
    runPasses(module);

    const defines = module.defines;

    // Filter imports to a "uses" set. When allDefined is provided we only count
    // names that appear in it (Auditable's cell-scope semantics); when not,
    // we count every free name that isn't a JS global.
    const uses = new Set();
    for (const name of module.imports) {
      if (defines.has(name) || JS_GLOBALS.has(name)) continue;
      if (!allDefined || allDefined.has(name)) uses.add(name);
    }

    return { defines, uses, air: module, ast };
  } catch (e) {
    if (_airDebug) console.warn('[AIR] analyze fallback:', e.message);
    return null;
  }
}

/**
 * Back-compat alias. Prefer `analyzeModule` in new code.
 * @deprecated since 0.2.0 — use analyzeModule
 */
export const analyzeCell = analyzeModule;

/**
 * Extract defines only (for cases where we just need the names).
 * Lighter than full analyzeModule — no passes, no use filtering.
 */
export function extractDefines(code, parser) {
  try {
    const ast = parseModule(code, parser);
    const module = lowerJS(ast, code);
    return module.defines;
  } catch (e) {
    if (_airDebug) console.warn('[AIR] extractDefines fallback:', e.message);
    return null;
  }
}

/**
 * Extract structured import declarations from an AST. Returns an array of
 * descriptors — consumers (bundler, reactive DAG) decide how to handle each kind.
 *
 *   { kind: 'named',       source, specifiers: [{ imported, local }] }
 *   { kind: 'namespace',   source, local }
 *   { kind: 'default',     source, local }
 *   { kind: 'side-effect', source }
 *
 * For `import defaultExport, { foo } from './x'` both a 'default' and a 'named'
 * descriptor are emitted (one per role) so consumers don't miss either piece.
 *
 * @param {object} ast - ESTree Program node (from parseModule)
 * @returns {Array<object>}
 */
export function extractImports(ast) {
  const out = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    if (node.specifiers.length === 0) { out.push({ kind: 'side-effect', source }); continue; }

    const named = [];
    for (const spec of node.specifiers) {
      switch (spec.type) {
        case 'ImportNamespaceSpecifier':
          out.push({ kind: 'namespace', source, local: spec.local.name });
          break;
        case 'ImportDefaultSpecifier':
          out.push({ kind: 'default', source, local: spec.local.name });
          break;
        case 'ImportSpecifier':
          named.push({
            imported: spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value,
            local: spec.local.name,
          });
          break;
      }
    }
    if (named.length > 0) out.push({ kind: 'named', source, specifiers: named });
  }
  return out;
}

/**
 * Extract structured export declarations from an AST. Returns an array of:
 *
 *   { kind: 'named',             specifiers: [{ local, exported }] }
 *   { kind: 'reexport-named',    source, specifiers: [{ local, exported }] }
 *   { kind: 'reexport-wildcard', source, exported }  // exported is the `as ns` name, or null
 *   { kind: 'declaration',       declaration: <ESTree node> }  // export const/let/function/class
 *   { kind: 'default',           declaration: <ESTree node> }
 *
 * @param {object} ast - ESTree Program node (from parseModule)
 * @returns {Array<object>}
 */
export function extractExports(ast) {
  const out = [];
  for (const node of ast.body) {
    switch (node.type) {
      case 'ExportNamedDeclaration':
        if (node.declaration) {
          out.push({ kind: 'declaration', declaration: node.declaration });
        } else if (node.source) {
          out.push({
            kind: 'reexport-named',
            source: node.source.value,
            specifiers: node.specifiers.map(s => ({
              local: s.local.type === 'Identifier' ? s.local.name : s.local.value,
              exported: s.exported.type === 'Identifier' ? s.exported.name : s.exported.value,
            })),
          });
        } else {
          out.push({
            kind: 'named',
            specifiers: node.specifiers.map(s => ({
              local: s.local.type === 'Identifier' ? s.local.name : s.local.value,
              exported: s.exported.type === 'Identifier' ? s.exported.name : s.exported.value,
            })),
          });
        }
        break;
      case 'ExportAllDeclaration':
        out.push({
          kind: 'reexport-wildcard',
          source: node.source.value,
          exported: node.exported ? (node.exported.type === 'Identifier' ? node.exported.name : node.exported.value) : null,
        });
        break;
      case 'ExportDefaultDeclaration':
        out.push({ kind: 'default', declaration: node.declaration });
        break;
    }
  }
  return out;
}

/**
 * Get export types for a module (for fine-grained change detection).
 */
export function extractExportTypes(module) {
  if (!module) return null;
  const types = new Map();
  for (const [name, exp] of module.exports) {
    types.set(name, exp.type);
  }
  return types;
}

export { lowerJS, lowerAdder, lowerSoft, runPasses, extractDependencies, emitJS, needsAsync, AirLowerError, SoftLowerError };

// --- Browser init: register AIR on window ---
// When loaded in the browser with Acorn available, create the parser
// and set window._air for dag.js and exec.js to pick up.

if (typeof window !== 'undefined' && window.Acorn) {
  // Seed the cached parser; parseModule() and analyzeModule() both see it
  // via _getDefaultParser() when no parser is passed explicitly.
  const { Parser, tsPlugin } = window.Acorn;
  _cachedParser = Parser.extend(tsPlugin());
  window._airAnalyzer = function(code, allDefined) {
    return analyzeModule(code, _cachedParser, allDefined);
  };
  // Phase 2: emitter functions for exec.js
  window._airEmit = emitJS;
  window._airNeedsAsync = needsAsync;
  // Phase 3: adder transpile entry — returns { air, defines } or null on failure
  window._airLowerAdder = function(ast, code) {
    try {
      const air = lowerAdder(ast, code);
      runPasses(air);
      return { air, defines: air.defines };
    } catch (e) {
      if (e instanceof AirLowerError) return null;
      throw e;
    }
  };
  // Soft transpile entry
  window._airLowerSoft = function(ast, code) {
    try {
      const air = lowerSoft(ast, code);
      runPasses(air);
      return { air, defines: air.defines };
    } catch (e) {
      if (e instanceof SoftLowerError) return null;
      throw e;
    }
  };
  // Re-run passes on an existing AIR module with given import types.
  // Used by Auditable for cross-cell type flow: the upstream module's export
  // types seed the downstream module's imports. Returns true if anything changed.
  window._airRePropagate = function(air, opts) {
    try {
      runPasses(air, opts || {});
      return true;
    } catch (e) {
      return false;
    }
  };
}
