// Parser for @gcu/yaml.
//
// Recursive descent over the line records produced by preprocess().
// Each block (map or sequence) lives at one indent level; entries within a
// block all share that indent. Nested blocks sit at indent + 2.

import { YamlParseError, scalar, mapNode, seqNode, mapEntry, MAX_DEPTH } from './types.js';
import {
  preprocess,
  splitComment,
  isCommentOnly,
  commentBody,
  tryParseTag,
  tryParseBareKey,
  parseQuotedKey,
  parseValueText,
} from './lex.js';

export function parse(text) {
  const lines = preprocess(text);
  if (lines.length === 0) {
    throw new YamlParseError('5.2', 1, 1, 'empty file');
  }

  const ctx = { lines, pos: 0, depth: 0 };

  const fileLeading = [];
  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) { ctx.pos++; continue; }
    if (isCommentOnly(ln.content)) {
      fileLeading.push(commentBody(ln.content));
      ctx.pos++;
      continue;
    }
    break;
  }

  if (ctx.pos >= ctx.lines.length) {
    throw new YamlParseError('5.2', 1, 1,
      'file contains only comments/blanks; need a block map or sequence');
  }

  const firstLine = ctx.lines[ctx.pos];
  if (firstLine.indent !== 0) {
    throw new YamlParseError('5.3', firstLine.lineNumber, firstLine.indent + 1,
      'top-level content must start at column 0');
  }
  if (firstLine.content === '---' || firstLine.content === '...'
      || firstLine.content.startsWith('--- ') || firstLine.content.startsWith('... ')) {
    throw new YamlParseError('5.1', firstLine.lineNumber, 1,
      'document-start/end markers (--- / ...) not permitted; single document only');
  }
  // §5.2 — bare top-level scalars are not permitted. Detect by: not a seq
  // dash, and no ':' outside quotes on the first content line.
  if (!startsWithDash(firstLine.content) && !hasMapColonOutsideQuotes(firstLine.content)) {
    throw new YamlParseError('5.2', firstLine.lineNumber, 1,
      'top-level must be a block map or block sequence; bare scalars not permitted');
  }

  const root = parseBlockBody(ctx, 0, fileLeading, null);

  const tail = [];
  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) { ctx.pos++; continue; }
    if (isCommentOnly(ln.content)) {
      tail.push(commentBody(ln.content));
      ctx.pos++;
      continue;
    }
    throw new YamlParseError('5.3', ln.lineNumber, ln.indent + 1,
      'unexpected content after root document');
  }
  if (tail.length > 0) {
    root.blockTrailingComments = root.blockTrailingComments.concat(tail);
  }

  return root;
}

// ---- Block body (map or seq) at the given indent --------------------------

function parseBlockBody(ctx, indent, leadingComments, topLevelTag) {
  if (++ctx.depth > MAX_DEPTH) {
    const ln = ctx.lines[ctx.pos] || { lineNumber: 1 };
    throw new YamlParseError('5.4', ln.lineNumber, indent + 1,
      'maximum nesting depth (64) exceeded');
  }

  let pendingComments = leadingComments.slice();
  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) { ctx.pos++; continue; }
    if (isCommentOnly(ln.content)) {
      pendingComments.push(commentBody(ln.content));
      ctx.pos++;
      continue;
    }
    if (ln.indent < indent) {
      throw new YamlParseError('5.3', ln.lineNumber, ln.indent + 1,
        `unexpected dedent (expected indent ${indent}, got ${ln.indent})`);
    }
    if (ln.indent > indent) {
      throw new YamlParseError('5.3', ln.lineNumber, ln.indent + 1,
        `unexpected over-indent (expected ${indent}, got ${ln.indent})`);
    }
    break;
  }

  if (ctx.pos >= ctx.lines.length) {
    throw new YamlParseError('5.2', 1, 1,
      'expected map or sequence content but found EOF');
  }

  const firstLine = ctx.lines[ctx.pos];
  const isSeq = startsWithDash(firstLine.content);

  let node;
  if (isSeq) node = parseSeqBlock(ctx, indent, pendingComments, topLevelTag);
  else node = parseMapBlock(ctx, indent, pendingComments, topLevelTag);

  ctx.depth--;
  return node;
}

function startsWithDash(content) {
  return content[0] === '-'
    && (content.length === 1 || content[1] === ' ');
}

// True if a `:` appears outside any `"..."` or `'...'` quoted region.
function hasMapColonOutsideQuotes(content) {
  let inDQ = false, inSQ = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inDQ) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (c === "'" && content[i + 1] === "'") { i++; continue; }
      if (c === "'") inSQ = false;
      continue;
    }
    if (c === '"') { inDQ = true; continue; }
    if (c === "'") { inSQ = true; continue; }
    if (c === ':') return true;
  }
  return false;
}

// ---- Map block -----------------------------------------------------------

function parseMapBlock(ctx, indent, firstEntryLeading, topLevelTag) {
  const entries = [];
  const seenKeys = new Set();
  let pendingComments = firstEntryLeading.slice();
  let firstLineNumber = ctx.lines[ctx.pos].lineNumber;

  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) { ctx.pos++; continue; }
    if (isCommentOnly(ln.content)) {
      pendingComments.push(commentBody(ln.content));
      ctx.pos++;
      continue;
    }
    if (ln.indent < indent) break;
    if (ln.indent > indent) {
      throw new YamlParseError('5.3', ln.lineNumber, ln.indent + 1,
        `unexpected over-indent (expected ${indent})`);
    }
    if (startsWithDash(ln.content)) {
      throw new YamlParseError('8.4', ln.lineNumber, ln.indent + 1,
        'sequence entry not permitted inside a map block');
    }

    const entry = parseMapEntry(ctx, indent, pendingComments);
    pendingComments = [];
    if (seenKeys.has(entry.key.value)) {
      throw new YamlParseError('7.2', entry.key.loc.line, entry.key.loc.column,
        `duplicate map key '${entry.key.value}'`);
    }
    seenKeys.add(entry.key.value);
    entries.push(entry);
  }

  if (entries.length === 0) {
    throw new YamlParseError('5.2', firstLineNumber, indent + 1,
      'block map with no entries');
  }

  if (pendingComments.length > 0) {
    const last = entries[entries.length - 1].value;
    last.blockTrailingComments = last.blockTrailingComments.concat(pendingComments);
  }

  return mapNode(entries, {
    tag: topLevelTag,
    loc: { line: entries[0].key.loc.line, column: indent + 1 },
  });
}

// Parses a single map entry at ctx.lines[ctx.pos] (must be at `indent`).
// Advances ctx.pos past all consumed lines (including nested blocks and
// block scalar bodies).
function parseMapEntry(ctx, indent, leadingComments) {
  const ln = ctx.lines[ctx.pos];
  return parseMapEntryFromContent(ctx, ln.content, ln.lineNumber, indent + 1, indent + 2, leadingComments, /*advanceFirstLine=*/true);
}

// Core map-entry parser. Accepts a content string (already at column `keyCol`)
// and processes it. The "nested indent" for any block value is `nestedIndent`.
// If `advanceFirstLine` is true, ctx.pos is advanced past the current line
// after the inline portion is consumed.
function parseMapEntryFromContent(ctx, content, lineNum, keyCol, nestedIndent, leadingComments, advanceFirstLine) {
  // Key
  let keyNode, keyLen;
  if (content[0] === '"' || content[0] === "'") {
    const r = parseQuotedKey(content, lineNum, keyCol);
    keyNode = r.keyNode;
    keyLen = r.consumed;
  } else {
    const b = tryParseBareKey(content);
    if (!b) {
      throw new YamlParseError('7.1', lineNum, keyCol,
        'expected key (bare identifier or quoted string)');
    }
    keyNode = scalar('string', b.key, { loc: { line: lineNum, column: keyCol } });
    keyLen = b.len;
  }

  if (content[keyLen] !== ':') {
    throw new YamlParseError('7.1', lineNum, keyCol + keyLen,
      `expected ':' after key (got '${content[keyLen] || 'EOL'}')`);
  }

  // After the colon
  let afterColon = content.slice(keyLen + 1);
  const afterColonCol = keyCol + keyLen + 1;

  // Empty: `key:` end of line — nested block follows.
  if (afterColon.length === 0) {
    if (advanceFirstLine) ctx.pos++;
    const value = parseNestedValue(ctx, nestedIndent, lineNum, afterColonCol, null, null);
    value.leadingComments = leadingComments;
    return mapEntry(keyNode, value);
  }

  if (afterColon[0] !== ' ') {
    if (afterColon[0] === '\t') {
      throw new YamlParseError('4.4', lineNum, afterColonCol + 1,
        'tab not permitted as separator after colon');
    }
    throw new YamlParseError('8.2', lineNum, afterColonCol + 1,
      'colon must be followed by a space and a value (or end of line)');
  }

  // Consume one or more SPs as the colon/value separator. The canonical
  // emitter writes exactly one; the parser accepts column-aligned forms.
  let sepLen = 0;
  while (afterColon[sepLen] === ' ') sepLen++;
  const valuePart = afterColon.slice(sepLen);
  const valueCol = afterColonCol + sepLen;

  return finishInlineMapEntry(ctx, keyNode, valuePart, lineNum, valueCol, nestedIndent, leadingComments, advanceFirstLine);
}

function finishInlineMapEntry(ctx, keyNode, valuePart, lineNum, valueCol, nestedIndent, leadingComments, advanceFirstLine) {
  const { body, comment } = splitComment(valuePart);

  if (body.length === 0) {
    if (advanceFirstLine) ctx.pos++;
    const value = parseNestedValue(ctx, nestedIndent, lineNum, valueCol, comment, null);
    value.leadingComments = leadingComments;
    return mapEntry(keyNode, value);
  }

  let tag = null;
  let rest = body;
  if (rest[0] === '!') {
    const t = tryParseTag(rest, lineNum, valueCol);
    tag = t.tag;
    rest = t.restAfterTag;
  }

  if (rest.length === 0) {
    if (advanceFirstLine) ctx.pos++;
    const value = parseNestedValue(ctx, nestedIndent, lineNum, valueCol, comment, tag);
    value.leadingComments = leadingComments;
    return mapEntry(keyNode, value);
  }

  if (rest === '|' || rest === '|-') {
    if (advanceFirstLine) ctx.pos++;
    const chomp = rest === '|-' ? 'strip' : 'clip';
    const value = parseBlockScalar(ctx, nestedIndent, lineNum, chomp);
    if (tag) value.tag = tag;
    value.leadingComments = leadingComments;
    if (comment) value.trailingComment = comment;
    return mapEntry(keyNode, value);
  }
  rejectBadBlockScalar(rest, lineNum, valueCol);

  // Inline value.
  if (advanceFirstLine) ctx.pos++;
  const valueNode = buildValueNode(rest, lineNum, valueCol, tag, leadingComments, comment);
  rejectMixedContent(ctx, nestedIndent - 2);
  return mapEntry(keyNode, valueNode);
}

function buildValueNode(text, lineNum, col, tag, leadingComments, trailingComment) {
  const r = parseValueText(text, lineNum, col);
  let node;
  if (r.emptySeq) node = seqNode([], { loc: { line: lineNum, column: col } });
  else if (r.emptyMap) node = mapNode([], { loc: { line: lineNum, column: col } });
  else node = r.node;

  if (tag) node.tag = tag;
  node.leadingComments = leadingComments;
  if (trailingComment) node.trailingComment = trailingComment;
  return node;
}

function rejectBadBlockScalar(rest, lineNum, col) {
  if (rest === '|+' || /^\|[0-9]/.test(rest)) {
    throw new YamlParseError('6.6', lineNum, col,
      `block scalar form '${rest}' not permitted (only | and |-)`);
  }
  if (rest[0] === '>') {
    throw new YamlParseError('6.6', lineNum, col,
      'folded block scalar (>) not permitted');
  }
}

// Look ahead: if there's an over-indented non-blank/comment line right after,
// that's "value on this line + nested children" = mixed content (§8.4).
function rejectMixedContent(ctx, indent) {
  for (let p = ctx.pos; p < ctx.lines.length; p++) {
    const ln = ctx.lines[p];
    if (ln.isBlank) continue;
    if (isCommentOnly(ln.content)) continue;
    if (ln.indent > indent) {
      throw new YamlParseError('8.4', ln.lineNumber, ln.indent + 1,
        'value given on previous line; indented child not permitted');
    }
    return;
  }
}

// ---- Sequence block ------------------------------------------------------

function parseSeqBlock(ctx, indent, firstEntryLeading, topLevelTag) {
  const items = [];
  let pendingComments = firstEntryLeading.slice();
  let firstLineNumber = ctx.lines[ctx.pos].lineNumber;

  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) { ctx.pos++; continue; }
    if (isCommentOnly(ln.content)) {
      pendingComments.push(commentBody(ln.content));
      ctx.pos++;
      continue;
    }
    if (ln.indent < indent) break;
    if (ln.indent > indent) {
      throw new YamlParseError('5.3', ln.lineNumber, ln.indent + 1,
        `unexpected over-indent (expected ${indent})`);
    }
    if (!startsWithDash(ln.content)) {
      throw new YamlParseError('8.4', ln.lineNumber, ln.indent + 1,
        'map entry not permitted inside a sequence block');
    }

    const itemValue = parseSeqEntry(ctx, indent, pendingComments);
    pendingComments = [];
    items.push(itemValue);
  }

  if (items.length === 0) {
    throw new YamlParseError('5.2', firstLineNumber, indent + 1,
      'block sequence with no entries');
  }

  if (pendingComments.length > 0) {
    const last = items[items.length - 1];
    last.blockTrailingComments = last.blockTrailingComments.concat(pendingComments);
  }

  return seqNode(items, {
    tag: topLevelTag,
    loc: { line: firstLineNumber, column: indent + 1 },
  });
}

function parseSeqEntry(ctx, indent, leadingComments) {
  const ln = ctx.lines[ctx.pos];
  const content = ln.content;
  const colBase = indent + 1;

  // Bare `-` alone — nested block follows on indented lines.
  if (content.length === 1) {
    ctx.pos++;
    const value = parseNestedValue(ctx, indent + 2, ln.lineNumber, colBase + 1, null, null);
    value.leadingComments = leadingComments;
    return value;
  }

  // `- value` shapes. Consume one or more SPs after the dash; the canonical
  // emitter writes exactly one, but the parser accepts column-aligned forms.
  let dashSep = 1;
  while (content[dashSep] === ' ') dashSep++;
  const valuePart = content.slice(dashSep);
  const valueCol = colBase + dashSep;

  const { body, comment } = splitComment(valuePart);

  if (body.length === 0) {
    ctx.pos++;
    const value = parseNestedValue(ctx, indent + 2, ln.lineNumber, valueCol, comment, null);
    value.leadingComments = leadingComments;
    return value;
  }

  let tag = null;
  let rest = body;
  let restCol = valueCol;
  if (rest[0] === '!') {
    const t = tryParseTag(rest, ln.lineNumber, valueCol);
    tag = t.tag;
    const consumed = rest.length - t.restAfterTag.length;
    restCol += consumed;
    rest = t.restAfterTag;
  }

  if (rest.length === 0) {
    ctx.pos++;
    const value = parseNestedValue(ctx, indent + 2, ln.lineNumber, valueCol, comment, tag);
    value.leadingComments = leadingComments;
    return value;
  }

  if (rest === '|' || rest === '|-') {
    ctx.pos++;
    const chomp = rest === '|-' ? 'strip' : 'clip';
    const value = parseBlockScalar(ctx, indent + 2, ln.lineNumber, chomp);
    if (tag) value.tag = tag;
    value.leadingComments = leadingComments;
    if (comment) value.trailingComment = comment;
    return value;
  }
  rejectBadBlockScalar(rest, ln.lineNumber, restCol);

  // "- key: value" embedded-map shorthand?
  if (looksLikeMapKey(rest)) {
    // Parse this line as a map entry at indent + 2, and continue collecting
    // further map entries at the same indent.
    // advanceFirstLine=true: the entry parser must consume the opener line
    // BEFORE it looks for a nested block, or `- key:` followed by indented
    // children would see the opener's own shallow indent and reject it.
    const firstEntry = parseMapEntryFromContent(
      ctx, rest, ln.lineNumber, restCol, indent + 4, [], /*advanceFirstLine=*/true
    );
    const trailingFirst = comment;
    if (trailingFirst) firstEntry.value.trailingComment = trailingFirst;

    const entries = [firstEntry];
    const seenKeys = new Set([firstEntry.key.value]);
    let pendingComments = [];

    while (ctx.pos < ctx.lines.length) {
      const nx = ctx.lines[ctx.pos];
      if (nx.isBlank) { ctx.pos++; continue; }
      if (isCommentOnly(nx.content)) {
        pendingComments.push(commentBody(nx.content));
        ctx.pos++;
        continue;
      }
      if (nx.indent < indent + 2) break;
      if (nx.indent > indent + 2) {
        throw new YamlParseError('5.3', nx.lineNumber, nx.indent + 1,
          `unexpected over-indent (expected ${indent + 2})`);
      }
      if (startsWithDash(nx.content)) {
        throw new YamlParseError('8.4', nx.lineNumber, nx.indent + 1,
          'sequence dash not permitted inside an embedded map');
      }
      const entry = parseMapEntry(ctx, indent + 2, pendingComments);
      pendingComments = [];
      if (seenKeys.has(entry.key.value)) {
        throw new YamlParseError('7.2', entry.key.loc.line, entry.key.loc.column,
          `duplicate map key '${entry.key.value}'`);
      }
      seenKeys.add(entry.key.value);
      entries.push(entry);
    }

    if (pendingComments.length > 0) {
      const last = entries[entries.length - 1].value;
      last.blockTrailingComments = last.blockTrailingComments.concat(pendingComments);
    }

    const mn = mapNode(entries, {
      tag,
      loc: { line: ln.lineNumber, column: restCol },
    });
    mn.leadingComments = leadingComments;
    return mn;
  }

  // Plain inline scalar / empty collection.
  ctx.pos++;
  const valueNode = buildValueNode(rest, ln.lineNumber, restCol, tag, leadingComments, comment);
  rejectMixedContent(ctx, indent);
  return valueNode;
}

// True if `text` begins with a bare or quoted key followed by `:`.
function looksLikeMapKey(text) {
  if (text[0] === '"' || text[0] === "'") {
    const qch = text[0];
    let i = 1;
    while (i < text.length) {
      if (qch === '"' && text[i] === '\\') { i += 2; continue; }
      if (qch === "'" && text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
      if (text[i] === qch) { i++; break; }
      i++;
    }
    return text[i] === ':';
  }
  const b = tryParseBareKey(text);
  if (!b) return false;
  return text[b.len] === ':';
}

// ---- Nested value (block following a `key:` or `- ` opener) --------------

function parseNestedValue(ctx, indent, parentLine, parentColumn, parentTrailingComment, topTag) {
  let p = ctx.pos;
  while (p < ctx.lines.length) {
    const ln = ctx.lines[p];
    if (ln.isBlank) { p++; continue; }
    if (isCommentOnly(ln.content)) { p++; continue; }
    break;
  }
  if (p >= ctx.lines.length) {
    throw new YamlParseError('7.3', parentLine, parentColumn,
      'expected nested block but found EOF (use explicit `null` or `""`)');
  }
  const next = ctx.lines[p];
  if (next.indent < indent) {
    throw new YamlParseError('7.3', parentLine, parentColumn,
      'expected nested block but next content is at parent indent or less');
  }
  if (next.indent !== indent) {
    throw new YamlParseError('5.3', next.lineNumber, next.indent + 1,
      `expected indent ${indent} for nested block, got ${next.indent}`);
  }
  const block = parseBlockBody(ctx, indent, [], topTag || null);
  if (parentTrailingComment) {
    block.trailingComment = parentTrailingComment;
  }
  return block;
}

// ---- Block scalar (| or |-) ----------------------------------------------

function parseBlockScalar(ctx, indent, openerLine, chomp) {
  const bodyLines = [];
  const blankIndices = [];

  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos];
    if (ln.isBlank) {
      bodyLines.push('');
      blankIndices.push(bodyLines.length - 1);
      ctx.pos++;
      continue;
    }
    if (ln.indent < indent) break;

    // Slice off `indent` SPs from the raw line, preserving any further chars
    // as content (including extra leading spaces).
    const raw = ln.raw;
    const stripped = raw.length >= indent ? raw.slice(indent) : '';
    // Per §4.4 the raw-line trailing-SP strip applies to non-block contexts;
    // inside a block-scalar body, trailing SP is part of content. Actually
    // §4.4: "Trailing SP on any line outside a "..." or '...' string is
    // stripped silently by the parser". This wording is ambiguous about
    // block scalars; spec example treats them as preserved content lines.
    // We'll preserve everything we slice — this matches the example output.
    bodyLines.push(stripped);
    ctx.pos++;
  }

  if (bodyLines.length === 0) {
    throw new YamlParseError('6.6', openerLine, indent + 1,
      'block scalar body is empty; use `""` for an empty string');
  }

  // Drop trailing blank body lines (they belong to the surrounding context,
  // not the scalar body).
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }
  if (bodyLines.length === 0) {
    throw new YamlParseError('6.6', openerLine, indent + 1,
      'block scalar body is empty after trimming blanks');
  }

  let value = bodyLines.join('\n');
  if (chomp === 'clip') value += '\n';

  return scalar('string', value, {
    style: 'block-' + chomp,
    loc: { line: openerLine + 1, column: indent + 1 },
  });
}
