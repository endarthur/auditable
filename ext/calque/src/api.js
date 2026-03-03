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

export function calque(stringsOrSource, ...values) {
  // Tagged template: calque`source`
  if (Array.isArray(stringsOrSource) || (stringsOrSource && stringsOrSource.raw)) {
    let source = stringsOrSource[0];
    for (let i = 0; i < values.length; i++) {
      source += String(values[i]);
      source += stringsOrSource[i + 1];
    }
    return calque.run(source);
  }
  // Direct call: calque(source)
  if (typeof stringsOrSource === 'string') {
    return calque.run(stringsOrSource);
  }
  throw new Error('calque: expected string or tagged template');
}

calque.run = function(source) {
  const tokens = lex(source);
  const ast = parse(tokens);
  return evaluate(ast);
};

calque.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

calque.lex = function(source) {
  return lex(source);
};

calque.compile = function(source, opts) {
  const tokens = lex(source);
  const ast = parse(tokens);
  const result = evaluate(ast);
  const layoutResult = layout(ast, result);
  const { workbook, warnings } = codegen(ast, layoutResult, result, opts);
  return { workbook, warnings, result };
};

// Internals for testing
calque._lex = lex;
calque._parse = parse;
calque._evaluate = evaluate;
calque._layout = layout;
calque._codegen = codegen;
calque._tokenize = tokenizeCalque;
calque._stdlib = stdlib;

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.calque = { tokenize: tokenizeCalque, completions: calqueCompletions, sigHint: calqueSigHint };
}
