// soft tagged template — use soft`...` in JS code cells
// Returns an object with all top-level defines as properties.

import { softParse } from './parse.js';
import { softEval } from './eval.js';

export function softTag(strings, ...values) {
  // build code with _v0, _v1 placeholders
  let code = strings[0];
  for (let i = 0; i < values.length; i++) {
    code += '_v' + i + strings[i + 1];
  }

  // dedent: strip common leading whitespace
  const lines = code.split('\n');
  let start = 0;
  if (lines[start].trim() === '') start++;
  let minIndent = Infinity;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].match(/^ */)[0].length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent > 0 && minIndent < Infinity) {
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() !== '') lines[i] = lines[i].slice(minIndent);
    }
  }
  if (start > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  code = lines.join('\n');

  // inject interpolated values into scope
  const scopeInit = {};
  for (let i = 0; i < values.length; i++) scopeInit['_v' + i] = values[i];

  const result = softEval(code, { scopeInit });

  // extract non-underscore-prefixed defines
  const out = {};
  for (const [k, v] of Object.entries(result.scope)) {
    if (k.startsWith('_') || k === 'it') continue;
    if (typeof v === 'function' && !v._softName) continue;
    out[k] = v;
  }
  return out;
}
