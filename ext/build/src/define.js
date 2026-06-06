// @gcu/build — define substitution (SPEC §10)
//
// opts.define maps __NAME__-convention identifiers to literal expression strings.
// Matching identifiers in EXPRESSION position are replaced with the parsed literal
// (text-spliced). Identifiers inside strings, comments, property keys, member
// property access, or declaration names are not substituted (matches esbuild).

import { buildError } from './errors.js';

const KEY_RE = /^__[A-Z][A-Z0-9_]*__$/;

// Validate the define map and confirm each value parses as an expression.
// Returns Map(name → valueText). Throws E015 (bad key) / E016 (bad value).
export function validateDefine(define, parse) {
  const map = new Map();
  if (!define) return map;
  for (const key of Object.keys(define)) {
    if (!KEY_RE.test(key)) {
      throw buildError('E015', `define key '${key}' must match the __NAME__ convention (uppercase, leading+trailing __)`, null);
    }
    const value = String(define[key]);
    try { parse(`(${value});`); }
    catch (e) { throw buildError('E016', `define value for '${key}' is not a valid expression: ${value}`, null); }
    map.set(key, value);
  }
  return map;
}

// Patches replacing define identifiers in expression position.
export function collectDefinePatches(ast, defineMap) {
  const patches = [];
  if (defineMap.size === 0) return patches;

  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return;
      case 'Identifier':
        if (defineMap.has(node.name)) patches.push({ start: node.start, end: node.end, text: defineMap.get(node.name) });
        return;
      case 'MemberExpression':
        visit(node.object);
        if (node.computed) visit(node.property);
        return;
      case 'Property':
        if (node.shorthand) {
          // `{ __X__ }` shorthand → expand to `{ __X__: <value> }`
          const id = node.value;
          if (id.type === 'Identifier' && defineMap.has(id.name)) {
            patches.push({ start: id.start, end: id.end, text: `${id.name}: ${defineMap.get(id.name)}` });
          }
          return;
        }
        if (node.computed) visit(node.key);
        visit(node.value);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed && node.key) visit(node.key);
        if (node.value) visit(node.value);
        return;
      case 'VariableDeclarator':
        // .id is a binding position; only .init is an expression
        if (node.init) visit(node.init);
        return;
      case 'LabeledStatement':
        visit(node.body);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      default:
        for (const k in node) {
          if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
          const v = node[k];
          if (Array.isArray(v)) { for (const c of v) visit(c); }
          else if (v && typeof v.type === 'string') visit(v);
        }
    }
  }

  for (const node of ast.body) visit(node);
  return patches;
}
