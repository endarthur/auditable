// Public API — tagged template, .run, .parse, .lex, self-registration
//
// Pipeline: source → lex → parse → evaluate → { bindings, exports, sheets, scope }

import { lex } from './lex.js';
import { parse } from './parse.js';
import { evaluate } from './eval.js';
import { stdlib } from './stdlib.js';
import { layout } from './layout.js';
import { codegen } from './codegen.js';
import { tokenizeCalque, calqueCompletions, calqueSigHint } from './highlight.js';
import { grid } from './grid.js';

function toSource(stringsOrSource, values) {
  if (Array.isArray(stringsOrSource) || (stringsOrSource && stringsOrSource.raw)) {
    let source = stringsOrSource[0];
    for (let i = 0; i < values.length; i++) {
      source += String(values[i]);
      source += stringsOrSource[i + 1];
    }
    return source;
  }
  if (typeof stringsOrSource === 'string') return stringsOrSource;
  return null;
}

export function calque(stringsOrSource, ...values) {
  // calque({ imports: {...} })`...` — curried with options
  if (typeof stringsOrSource === 'object' && !Array.isArray(stringsOrSource) && !stringsOrSource.raw) {
    const opts = stringsOrSource;
    return function(strings, ...vals) {
      const src = toSource(strings, vals);
      if (src !== null) return calque.run(src, opts);
      throw new Error('calque: expected tagged template after options');
    };
  }
  const source = toSource(stringsOrSource, values);
  if (source !== null) return calque.run(source);
  throw new Error('calque: expected string or tagged template');
}

calque.run = function(source, opts) {
  const tokens = lex(source);
  const ast = parse(tokens);
  const result = evaluate(ast, opts);
  result._ast = ast;
  result.compile = function() {
    const layoutResult = layout(ast, result);
    const { workbook, warnings } = codegen(ast, layoutResult, result);
    return { workbook, warnings };
  };
  return result;
};

calque.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

calque.lex = function(source) {
  return lex(source);
};

calque.compile = function(stringsOrSource, ...values) {
  const source = toSource(stringsOrSource, values);
  if (source === null) throw new Error('calque.compile: expected string or tagged template');
  const result = calque.run(source);
  const { workbook, warnings } = result.compile();
  return { workbook, warnings, result };
};

calque.grid = function(result) {
  return grid(result);
};

// Internals for testing
calque._lex = lex;
calque._parse = parse;
calque._evaluate = evaluate;
calque._layout = layout;
calque._codegen = codegen;
calque._grid = grid;
calque._tokenize = tokenizeCalque;
calque._stdlib = stdlib;

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.calque = { tokenize: tokenizeCalque, completions: calqueCompletions, sigHint: calqueSigHint };
}
