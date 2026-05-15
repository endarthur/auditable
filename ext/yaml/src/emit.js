// Canonical emitter for @gcu/yaml.
//
// Pure function from AST to bytes. No configuration; the canonical form is
// fixed by §12.5:
//   - 2 SP per indent level
//   - LF only, exactly one at EOF, no trailing SP on any line
//   - Strings emit as "..." by default; style='single' → '...'; block scalars
//     emit as | or |- with body at indent + 2
//   - Integers emit in decimal unless radix hint says hex/oct/bin (lowercase)
//   - Floats emit in shortest decimal round-trip form with explicit '.'
//   - Empty collections emit as [] or {}
//   - Tags emit as !name before the tagged value

export function emit(ast) {
  if (ast.kind !== 'map' && ast.kind !== 'seq') {
    throw new Error('emit: top-level must be map or seq');
  }
  const out = [];
  // Leading comments on the root (file-level pre-comments) — these were
  // attached to the first entry, so they come out naturally.
  emitBlock(ast, 0, out, ast.tag || null);
  // File-level trailing comments
  for (const c of ast.blockTrailingComments) {
    out.push('#' + c);
  }
  return out.join('\n') + '\n';
}

// ---- Block emitters ------------------------------------------------------

function emitBlock(node, indent, out, /*unused*/ tagOnBlock) {
  if (node.kind === 'map') emitMapBlock(node, indent, out);
  else if (node.kind === 'seq') emitSeqBlock(node, indent, out);
}

function emitMapBlock(map, indent, out) {
  const pad = ' '.repeat(indent);
  for (const entry of map.entries) {
    for (const c of entry.value.leadingComments) {
      out.push(pad + '#' + c);
    }
    emitMapEntry(entry, indent, out);
    for (const c of entry.value.blockTrailingComments) {
      out.push(pad + '#' + c);
    }
  }
}

function emitSeqBlock(seq, indent, out) {
  const pad = ' '.repeat(indent);
  for (const item of seq.items) {
    for (const c of item.leadingComments) {
      out.push(pad + '#' + c);
    }
    emitSeqItem(item, indent, out);
    for (const c of item.blockTrailingComments) {
      out.push(pad + '#' + c);
    }
  }
}

function emitMapEntry(entry, indent, out) {
  const pad = ' '.repeat(indent);
  const keyRepr = emitKey(entry.key);
  const value = entry.value;
  const shape = valueShape(value);
  const tagPart = value.tag ? ' !' + value.tag : '';
  const trailing = value.trailingComment ? '  #' + value.trailingComment : '';

  if (shape === 'inline') {
    out.push(pad + keyRepr + ':' + tagPart + ' ' + emitInlineValue(value) + trailing);
  } else if (shape === 'block-scalar') {
    const opener = value.style === 'block-strip' ? '|-' : '|';
    out.push(pad + keyRepr + ':' + tagPart + ' ' + opener + trailing);
    emitBlockScalarBody(value.value, indent + 2, out);
  } else if (shape === 'nested-map') {
    out.push(pad + keyRepr + ':' + tagPart + trailing);
    emitMapBlock(value, indent + 2, out);
  } else if (shape === 'nested-seq') {
    out.push(pad + keyRepr + ':' + tagPart + trailing);
    emitSeqBlock(value, indent + 2, out);
  }
}

function emitSeqItem(item, indent, out) {
  const pad = ' '.repeat(indent);
  const tagPart = item.tag ? ' !' + item.tag : '';
  const trailing = item.trailingComment ? '  #' + item.trailingComment : '';

  const shape = valueShape(item);

  if (shape === 'inline') {
    if (item.kind === 'scalar') {
      out.push(pad + '-' + tagPart + ' ' + emitScalar(item) + trailing);
    } else {
      // empty map or seq
      const repr = item.kind === 'map' ? '{}' : '[]';
      out.push(pad + '-' + tagPart + ' ' + repr + trailing);
    }
  } else if (shape === 'block-scalar') {
    const opener = item.style === 'block-strip' ? '|-' : '|';
    out.push(pad + '-' + tagPart + ' ' + opener + trailing);
    emitBlockScalarBody(item.value, indent + 2, out);
  } else if (shape === 'nested-map') {
    // Embedded-map form: write first entry inline on dash line.
    emitEmbeddedMap(item, indent, out);
  } else if (shape === 'nested-seq') {
    // Bare dash, nested seq below.
    out.push(pad + '-' + tagPart + trailing);
    emitSeqBlock(item, indent + 2, out);
  }
}

function emitEmbeddedMap(mapNode, indent, out) {
  const pad = ' '.repeat(indent);
  const tagPart = mapNode.tag ? ' !' + mapNode.tag : '';

  const entries = mapNode.entries;
  const first = entries[0];
  const firstVal = first.value;
  const firstKey = emitKey(first.key);

  const firstShape = valueShape(firstVal);
  const firstTrailing = firstVal.trailingComment ? '  #' + firstVal.trailingComment : '';
  const firstValTag = firstVal.tag ? ' !' + firstVal.tag : '';

  if (firstShape === 'inline') {
    out.push(pad + '-' + tagPart + ' ' + firstKey + ':' + firstValTag + ' '
      + emitInlineValue(firstVal) + firstTrailing);
  } else if (firstShape === 'block-scalar') {
    const opener = firstVal.style === 'block-strip' ? '|-' : '|';
    out.push(pad + '-' + tagPart + ' ' + firstKey + ':' + firstValTag + ' '
      + opener + firstTrailing);
    emitBlockScalarBody(firstVal.value, indent + 4, out);
  } else if (firstShape === 'nested-map') {
    out.push(pad + '-' + tagPart + ' ' + firstKey + ':' + firstValTag + firstTrailing);
    emitMapBlock(firstVal, indent + 4, out);
  } else if (firstShape === 'nested-seq') {
    out.push(pad + '-' + tagPart + ' ' + firstKey + ':' + firstValTag + firstTrailing);
    emitSeqBlock(firstVal, indent + 4, out);
  }

  // First entry's block-trailing comments (at the map's indent = indent + 2).
  const subIndent = indent + 2;
  const subPad = ' '.repeat(subIndent);
  for (const c of firstVal.blockTrailingComments) {
    out.push(subPad + '#' + c);
  }

  // Remaining entries at indent + 2.
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    for (const c of entry.value.leadingComments) {
      out.push(subPad + '#' + c);
    }
    emitMapEntry(entry, subIndent, out);
    for (const c of entry.value.blockTrailingComments) {
      out.push(subPad + '#' + c);
    }
  }
}

// ---- Shape classification ------------------------------------------------

function valueShape(value) {
  if (value.kind === 'scalar') {
    if (value.type === 'string'
        && (value.style === 'block-clip' || value.style === 'block-strip')) {
      return 'block-scalar';
    }
    return 'inline';
  }
  if (value.kind === 'map') return value.entries.length === 0 ? 'inline' : 'nested-map';
  if (value.kind === 'seq') return value.items.length === 0 ? 'inline' : 'nested-seq';
}

function emitInlineValue(value) {
  if (value.kind === 'scalar') return emitScalar(value);
  if (value.kind === 'map') return '{}';
  if (value.kind === 'seq') return '[]';
}

// ---- Scalars -------------------------------------------------------------

function emitScalar(s) {
  if (s.type === 'null') return 'null';
  if (s.type === 'bool') return s.value ? 'true' : 'false';
  if (s.type === 'int') return emitInt(s);
  if (s.type === 'float') return emitFloat(s.value);
  if (s.type === 'string') {
    if (s.style === 'single') return emitSingleQuoted(s.value);
    return emitDoubleQuoted(s.value);
  }
  throw new Error('emitScalar: unknown type ' + s.type);
}

function emitDoubleQuoted(value) {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const cc = value.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cc < 0x20 || cc === 0x7F) {
      out += '\\u' + cc.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function emitSingleQuoted(value) {
  // Single-quoted can't carry control chars; if any are present, fall back to
  // double-quoted (which has escape sequences).
  for (let i = 0; i < value.length; i++) {
    const cc = value.charCodeAt(i);
    if (cc < 0x20 || cc === 0x7F) return emitDoubleQuoted(value);
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

function emitInt(node) {
  const v = node.value;
  let s;
  if (node.radix === 'hex') s = (v < 0 ? '-' : '') + '0x' + Math.abs(v).toString(16);
  else if (node.radix === 'oct') s = (v < 0 ? '-' : '') + '0o' + Math.abs(v).toString(8);
  else if (node.radix === 'bin') s = (v < 0 ? '-' : '') + '0b' + Math.abs(v).toString(2);
  else s = String(v);

  if (node.separators) s = applyGrouping(s, node.radix);
  return s;
}

function applyGrouping(s, radix) {
  let prefix = '';
  let digits = s;
  if (s.startsWith('-')) { prefix = '-'; digits = s.slice(1); }
  if (digits.startsWith('0x') || digits.startsWith('0o') || digits.startsWith('0b')) {
    prefix += digits.slice(0, 2);
    digits = digits.slice(2);
  }
  const groupSize = (radix === 'hex' || radix === 'bin') ? 4 : 3;
  let result = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % groupSize === 0) result += '_';
    result += digits[i];
  }
  return prefix + result;
}

function emitFloat(v) {
  let s = String(v);
  if (!/[.eE]/.test(s)) s += '.0';
  return s;
}

// ---- Keys ----------------------------------------------------------------

function emitKey(keyNode) {
  const k = keyNode.value;
  if (keyNode.style !== 'single' && isBareKey(k)) return k;
  if (keyNode.style === 'single') return emitSingleQuoted(k);
  return emitDoubleQuoted(k);
}

function isBareKey(s) {
  if (s.length === 0) return false;
  if (!/[A-Za-z_]/.test(s[0])) return false;
  for (let i = 1; i < s.length; i++) {
    if (!/[A-Za-z0-9_.\-]/.test(s[i])) return false;
  }
  return true;
}

// ---- Block scalar body ---------------------------------------------------

function emitBlockScalarBody(text, indent, out) {
  let body = text;
  // For clip the body ends with \n; for strip it doesn't. The trailing \n
  // would split as an extra empty line, which we don't want as a body line.
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const lines = body.split('\n');
  const pad = ' '.repeat(indent);
  for (const ln of lines) {
    if (ln === '') out.push('');
    else out.push(pad + ln);
  }
}
