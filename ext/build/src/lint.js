// @gcu/build — lint rules (SPEC §9)
//
// Enforced at parse time (the AST is already walked). Not style rules — they
// protect the bundler's flat-scope assumptions or catch bugs that concatenation
// would turn silent. Import/export bans (E002/E005/E006) live in resolve.js +
// core.js; this module covers the statement/identifier rules.
//
// Errors: E010 (var), E011 (with), E012 (eval).
// Warnings: W001 (top-level binding shadowed by an inner-scope declaration).
//
// E009 (implicit globals) is deferred — a correct, false-positive-free check
// needs a full globals allowlist + cross-module binding awareness.

import { buildError } from './errors.js';

function patNames(node, out) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) patNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) if (e) patNames(e, out); break;
    case 'AssignmentPattern': patNames(node.left, out); break;
    case 'RestElement': patNames(node.argument, out); break;
  }
  return out;
}

// Lint one module. Throws BuildError on an error rule; pushes warnings.
export function lintModule(ast, path, warnings) {
  const topNames = new Set();
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!decl) continue;
    if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) patNames(d.id, []).forEach((n) => topNames.add(n));
    else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) topNames.add(decl.id.name);
  }
  const warned = new Set(); // de-dupe W001 per name

  // `depth` 0 = module top level. Identifier reference position is tracked so
  // `eval` as a property key / member access / string is not flagged.
  function visit(node, depth) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind === 'var') throw buildError('E010', `'var' is not allowed — use let or const`, { file: path, line: node.loc.start.line, col: node.loc.start.column });
        for (const d of node.declarations) {
          if (depth > 0) for (const n of patNames(d.id, [])) maybeShadow(n, node);
          children(node, depth);
        }
        return;
      case 'WithStatement':
        throw buildError('E011', `'with' statements are not allowed`, { file: path, line: node.loc.start.line, col: node.loc.start.column });
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (depth > 0 && node.id) maybeShadow(node.id.name, node);
        descendScope(node, depth);
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        descendScope(node, depth);
        return;
      case 'Identifier':
        if (node.name === 'eval') throw buildError('E012', `'eval' is not allowed`, { file: path, line: node.loc.start.line, col: node.loc.start.column });
        return;
      case 'MemberExpression':
        visit(node.object, depth);
        if (node.computed) visit(node.property, depth);
        return;
      case 'Property':
        if (node.computed) visit(node.key, depth);
        if (!node.shorthand) visit(node.value, depth);
        else visit(node.value, depth); // shorthand value is a reference
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed && node.key) visit(node.key, depth);
        if (node.value) visit(node.value, depth);
        return;
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return;
      case 'LabeledStatement':
        visit(node.body, depth);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      default:
        children(node, depth);
    }
  }

  function children(node, depth) {
    for (const k in node) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) visit(c, depth); }
      else if (v && typeof v.type === 'string') visit(v, depth);
    }
  }

  // entering a nested scope bumps depth (so inner decls count as shadows)
  function descendScope(node, depth) { children(node, depth + 1); }

  function maybeShadow(name, node) {
    if (topNames.has(name) && !warned.has(name)) {
      warned.add(name);
      warnings.push({ code: 'W001', message: `top-level binding '${name}' shadowed by an inner-scope declaration in ${path}` });
    }
  }

  for (const node of ast.body) visit(node, 0);
}
