// adder tagged template + mpy alias
// Pure JS evaluation — no WASM bridge

import { adderParse } from './parse.js';
import { adderEval, AdderScope } from './eval.js';
import { adderBuiltins, pyStr } from './builtins.js';

export async function adderTag(strings, ...values) {
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
  // trim leading blank line
  if (start > 0 && lines[0].trim() === '') lines.shift();
  // trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  code = lines.join('\n');

  // parse
  const ast = adderParse(code);

  // create scope with builtins + injected values
  const scope = new AdderScope();
  const builtins = adderBuiltins(() => {}); // discard print output in tag context
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  for (let i = 0; i < values.length; i++) scope.set('_v' + i, values[i]);

  // evaluate
  await adderEval(ast, scope);

  // extract non-underscore-prefixed names
  const result = {};
  for (const [k, v] of scope.vars) {
    if (!k.startsWith('_') && typeof v !== 'function' || (typeof v === 'function' && v._pyFunc)) {
      if (!k.startsWith('_')) result[k] = v;
    }
  }
  return result;
}

// back-compat alias
export const mpy = adderTag;
