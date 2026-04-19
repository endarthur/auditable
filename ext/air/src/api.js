// @gcu/air — Public API
// Clean interface matching existing parseNames/findUses output shapes

import { lowerJS } from './lower/js.js';
import { runPasses, extractDependencies } from './passes.js';

// Debug logging — true during development, settable via window._airDebug
let _airDebug = (typeof window !== 'undefined') ? (window._airDebug ?? true) : false;

// JS_GLOBALS: names that are not cell imports (built-in globals)
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

/**
 * Analyze a JS/TS cell: parse, lower to AIR, run passes, extract defines/uses.
 * Returns { defines: Set<string>, uses: Set<string>, air: CellModule } on success,
 * or null if parsing/lowering fails.
 *
 * @param {string} code - Cell source code
 * @param {object} parser - Acorn parser instance (Parser.extend(tsPlugin()))
 * @param {Set<string>} allDefined - All names defined across all cells (for use detection)
 * @returns {{ defines: Set<string>, uses: Set<string>, air: object } | null}
 */
export function analyzeCell(code, parser, allDefined) {
  try {
    const ast = parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });

    const module = lowerJS(ast, code);
    runPasses(module);

    const defines = module.defines;

    // Filter imports: only keep names that are defined by other cells
    // (not JS globals, not self-defined)
    const uses = new Set();
    for (const name of module.imports) {
      if (allDefined && allDefined.has(name) && !defines.has(name) && !JS_GLOBALS.has(name)) {
        uses.add(name);
      }
    }

    return { defines, uses, air: module };
  } catch (e) {
    if (_airDebug) console.warn('[AIR] fallback for cell:', e.message);
    return null;
  }
}

/**
 * Extract defines only (for cases where we just need the names).
 * Lighter than full analyzeCell — no passes, no use filtering.
 */
export function extractDefines(code, parser) {
  try {
    const ast = parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });
    const module = lowerJS(ast, code);
    return module.defines;
  } catch (e) {
    if (_airDebug) console.warn('[AIR] extractDefines fallback:', e.message);
    return null;
  }
}

/**
 * Get export types for a cell (for fine-grained change detection).
 */
export function extractExportTypes(module) {
  if (!module) return null;
  const types = new Map();
  for (const [name, exp] of module.exports) {
    types.set(name, exp.type);
  }
  return types;
}

export { lowerJS, runPasses, extractDependencies };

// --- Browser init: register AIR on window ---
// When loaded in the browser with Acorn available, create the parser
// and set window._air for dag.js and exec.js to pick up.

if (typeof window !== 'undefined' && window.Acorn) {
  const { Parser, tsPlugin } = window.Acorn;
  const _airParser = Parser.extend(tsPlugin());
  window._airAnalyzer = function(code, allDefined) {
    return analyzeCell(code, _airParser, allDefined);
  };
  // Phase 2: emitter functions for exec.js
  window._airEmit = emitJS;
  window._airNeedsAsync = needsAsync;
}
