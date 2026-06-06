// @gcu/build — lexical scope walker (SPEC §6.3)
//
// The rewrite pass needs to distinguish a top-level (module-scope) identifier
// REFERENCE from an inner-scope shadow, so renames only touch references that
// actually resolve to the renamed module binding. AIR's scope tracking is tuned
// for SSA lowering, not identifier-reference resolution against original AST
// positions — so the bundler rolls its own small walker here (SPEC §21.5).
//
// This walker emits patches for REFERENCES only. Binding sites (declaration ids,
// params, import/export specifiers) are owned by rewrite.js / core.js. Scope
// boundaries: function, block, catch, class.

// Names bound by a binding pattern (Identifier / Object / Array / Assignment /
// Rest). Collected for params and declaration ids so inner scopes shadow.
function patNames(node, out) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) patNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of node.elements) patNames(e, out);
      break;
    case 'AssignmentPattern': patNames(node.left, out); break;
    case 'RestElement': patNames(node.argument, out); break;
  }
  return out;
}

// var + function declarations hoist to the nearest function scope. Scan the
// subtree without crossing nested function boundaries.
function hoistFunctionScoped(nodes, scope) {
  const stack = Array.isArray(nodes) ? [...nodes] : [nodes];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    const t = n.type;
    if (t === 'FunctionDeclaration') { if (n.id) scope.add(n.id.name); continue; }
    if (t === 'FunctionExpression' || t === 'ArrowFunctionExpression') continue; // boundary
    if (t === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) patNames(d.id, []).forEach((nm) => scope.add(nm));
      continue;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && c.type) stack.push(c); }
      else if (v && v.type) stack.push(v);
    }
  }
}

// let / const / class / function declarations directly in a block scope.
function hoistBlockScoped(statements, scope) {
  for (const s of statements) {
    if (!s) continue;
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
      for (const d of s.declarations) patNames(d.id, []).forEach((nm) => scope.add(nm));
    } else if ((s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') && s.id) {
      scope.add(s.id.name);
    }
  }
}

/**
 * Collect reference-rename patches for one module's AST.
 *
 * @param {object} ast      ESTree Program (with ranges)
 * @param {Map<string,string>} renameMap  name → replacement (for module-top bindings)
 * @param {Set<string>} topNames  every name declared at module top level (owned +
 *   import locals), so inner shadows are detected correctly.
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function collectRenamePatches(ast, renameMap, topNames) {
  const patches = [];
  if (renameMap.size === 0) return patches;
  const topScope = new Set(topNames);

  // A name resolves to the module top iff it's in the top scope and no inner
  // scope on the stack shadows it. scopes[0] is the top (module) scope.
  function resolvesToTop(name, scopes) {
    for (let i = scopes.length - 1; i >= 1; i--) {
      if (scopes[i].has(name)) return false;
    }
    return scopes[0].has(name);
  }

  function ref(id, scopes) {
    if (!id || id.type !== 'Identifier') return;
    const nm = id.name;
    if (!renameMap.has(nm)) return;
    if (!resolvesToTop(nm, scopes)) return;
    patches.push({ start: id.start, end: id.end, text: renameMap.get(nm) });
  }

  // Generic recursion over child node properties (used as the default).
  function children(node, scopes) {
    for (const k in node) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) visit(c, scopes); }
      else if (v && typeof v.type === 'string') visit(v, scopes);
    }
  }

  function enterFunction(node, scopes) {
    const fscope = new Set();
    // Named function expression: its own name is visible inside its body only.
    if ((node.type === 'FunctionExpression') && node.id) fscope.add(node.id.name);
    for (const p of node.params) patNames(p, []).forEach((nm) => fscope.add(nm));
    if (node.type !== 'ArrowFunctionExpression') fscope.add('arguments');
    const inner = [...scopes, fscope];
    // Hoist var/function across the whole body (block boundaries inside share
    // the function scope for var; let/const get block scopes as we recurse).
    if (node.body.type === 'BlockStatement') {
      hoistFunctionScoped(node.body.body, fscope);
      hoistBlockScoped(node.body.body, fscope);
    }
    // Param default expressions are references resolved in the function scope.
    for (const p of node.params) {
      if (p.type === 'AssignmentPattern') visit(p.right, inner);
      else if (p.type === 'RestElement') { /* binding only */ }
      // destructuring defaults inside ObjectPattern/ArrayPattern:
      else if (p.type === 'ObjectPattern' || p.type === 'ArrayPattern') visitPatternDefaults(p, inner);
    }
    if (node.body.type === 'BlockStatement') {
      for (const s of node.body.body) visit(s, inner);
    } else {
      visit(node.body, inner); // arrow expression body
    }
  }

  // Walk default-value expressions inside a binding pattern (references), without
  // treating the bound names as references.
  function visitPatternDefaults(pat, scopes) {
    if (!pat) return;
    switch (pat.type) {
      case 'AssignmentPattern': visit(pat.right, scopes); visitPatternDefaults(pat.left, scopes); break;
      case 'ObjectPattern':
        for (const p of pat.properties) {
          if (p.type === 'RestElement') { visitPatternDefaults(p.argument, scopes); continue; }
          if (p.computed) visit(p.key, scopes);
          visitPatternDefaults(p.value, scopes);
        }
        break;
      case 'ArrayPattern':
        for (const e of pat.elements) visitPatternDefaults(e, scopes);
        break;
      case 'RestElement': visitPatternDefaults(pat.argument, scopes); break;
    }
  }

  function visit(node, scopes) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration': return;       // owned by rewrite.js
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration, scopes); // export const/fn/class
        return;                                // specifiers owned by rewrite.js
      case 'ExportAllDeclaration': return;
      case 'ExportDefaultDeclaration': return; // banned anyway

      case 'Identifier': ref(node, scopes); return;

      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        enterFunction(node, scopes);
        return;

      case 'BlockStatement': {
        const bscope = new Set();
        hoistBlockScoped(node.body, bscope);
        const inner = [...scopes, bscope];
        for (const s of node.body) visit(s, inner);
        return;
      }

      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const bscope = new Set();
        const inner = [...scopes, bscope];
        // loop-head let/const bindings live in the loop block scope
        const head = node.init || node.left;
        if (head && head.type === 'VariableDeclaration') {
          if (head.kind !== 'var') for (const d of head.declarations) patNames(d.id, []).forEach((nm) => bscope.add(nm));
          for (const d of head.declarations) if (d.init) visit(d.init, inner);
          if (node.right) visit(node.right, inner);
          if (node.test) visit(node.test, inner);
          if (node.update) visit(node.update, inner);
        } else {
          if (node.init) visit(node.init, inner);
          if (node.left) visit(node.left, inner);
          if (node.right) visit(node.right, inner);
          if (node.test) visit(node.test, inner);
          if (node.update) visit(node.update, inner);
        }
        visit(node.body, inner);
        return;
      }

      case 'CatchClause': {
        const cscope = new Set();
        if (node.param) patNames(node.param, []).forEach((nm) => cscope.add(nm));
        const inner = [...scopes, cscope];
        if (node.param) visitPatternDefaults(node.param, inner);
        visit(node.body, inner);
        return;
      }

      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.superClass) visit(node.superClass, scopes);
        // class name visible inside body (expression form); harmless to add.
        const cscope = new Set();
        if (node.id) cscope.add(node.id.name);
        const inner = [...scopes, cscope];
        for (const m of node.body.body) {
          if (m.computed && m.key) visit(m.key, inner);
          if (m.value) visit(m.value, inner);
        }
        return;
      }

      case 'VariableDeclarator':
        // .id is a binding; only .init is reference-bearing. Destructuring
        // defaults in .id are references though.
        visitPatternDefaults(node.id, scopes);
        if (node.init) visit(node.init, scopes);
        return;

      case 'MemberExpression':
        visit(node.object, scopes);
        if (node.computed) visit(node.property, scopes);
        return;

      case 'Property': {
        // Object literal property (ObjectExpression). Patterns are handled via
        // visitPatternDefaults and never reach here.
        if (node.shorthand && node.value.type === 'Identifier') {
          const id = node.value;
          if (renameMap.has(id.name) && resolvesToTop(id.name, scopes)) {
            patches.push({ start: id.start, end: id.end, text: `${id.name}: ${renameMap.get(id.name)}` });
          }
          return;
        }
        if (node.computed) visit(node.key, scopes);
        visit(node.value, scopes);
        return;
      }

      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (node.computed && node.key) visit(node.key, scopes);
        if (node.value) visit(node.value, scopes);
        return;
      }

      case 'LabeledStatement': visit(node.body, scopes); return;
      case 'BreakStatement':
      case 'ContinueStatement': return; // labels are not references

      default:
        children(node, scopes);
    }
  }

  for (const node of ast.body) visit(node, [topScope]);
  return patches;
}
