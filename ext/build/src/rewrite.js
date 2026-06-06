// @gcu/build — structural rewrite helpers (SPEC §6.3, §7)
//
// Mechanical patch builders used by core.js. References are handled by scope.js;
// these cover binding sites and statement removal. A patch is { start, end, text }
// over the original module source.

// Delete a whole statement, consuming trailing same-line whitespace + one newline
// so the output doesn't accumulate blank lines where a statement was removed.
export function stmtDelete(node, source) {
  let end = node.end;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++;
  if (source[end] === '\r') end++;
  if (source[end] === '\n') end++;
  return { start: node.start, end, text: '' };
}

// Strip the `export ` (or `export default `) prefix of an export-declaration,
// leaving the underlying `const`/`function`/`class`/`let` declaration.
export function exportPrefixStrip(exportNode) {
  return { start: exportNode.start, end: exportNode.declaration.start, text: '' };
}

// Names declared by a top-level declaration node (for export collection / decl-site renames).
export function declaredNames(declNode) {
  const out = [];
  if (declNode.type === 'VariableDeclaration') {
    for (const d of declNode.declarations) patNames(d.id, out);
  } else if ((declNode.type === 'FunctionDeclaration' || declNode.type === 'ClassDeclaration') && declNode.id) {
    out.push(declNode.id.name);
  }
  return out;
}

function patNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) patNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of node.elements) if (e) patNames(e, out);
      break;
    case 'AssignmentPattern': patNames(node.left, out); break;
    case 'RestElement': patNames(node.argument, out); break;
  }
}

// Decl-site rename patches for a top-level declaration, given a Map(name → newName).
// Handles plain identifiers and destructuring (shorthand expanded to `key: newName`).
export function declSitePatches(declNode, renames, patches) {
  if (renames.size === 0) return;
  if (declNode.type === 'VariableDeclaration') {
    for (const d of declNode.declarations) bindPatches(d.id, renames, patches, false);
  } else if ((declNode.type === 'FunctionDeclaration' || declNode.type === 'ClassDeclaration') && declNode.id) {
    const nm = declNode.id.name;
    if (renames.has(nm)) patches.push({ start: declNode.id.start, end: declNode.id.end, text: renames.get(nm) });
  }
}

// Walk a binding pattern emitting rename patches for bound identifiers.
// `inShorthand` means an enclosing ObjectPattern property was shorthand, so a
// rename must expand `{a}` → `{a: a$mod}`.
function bindPatches(node, renames, patches, inShorthand) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': {
      const nm = node.name;
      if (renames.has(nm)) {
        const nn = renames.get(nm);
        patches.push({ start: node.start, end: node.end, text: inShorthand ? `${nm}: ${nn}` : nn });
      }
      break;
    }
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') { bindPatches(p.argument, renames, patches, false); continue; }
        const bound = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
        bindPatches(bound, renames, patches, !!p.shorthand);
      }
      break;
    case 'ArrayPattern':
      for (const e of node.elements) if (e) bindPatches(e.type === 'AssignmentPattern' ? e.left : e, renames, patches, false);
      break;
    case 'AssignmentPattern': bindPatches(node.left, renames, patches, inShorthand); break;
    case 'RestElement': bindPatches(node.argument, renames, patches, false); break;
  }
}
