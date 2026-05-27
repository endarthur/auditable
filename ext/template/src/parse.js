// Tokenizer + parser for {{path | filter args | filter args}} syntax.
//
// Output AST is a flat array of nodes:
//   { kind: 'literal', text }                        — passthrough text
//   { kind: 'opaque',  text }                        — interpolated value
//                                                      from a tagged template;
//                                                      never re-scanned for
//                                                      template syntax
//   { kind: 'template', path, filters: [{name, args}] }
//
// Two entry points: parseText(s) for plain strings, parseTagged(strings, values)
// for tagged-template-literal calls. parseTagged is the safe form: interpolated
// JS values land as 'opaque' nodes and can't introduce new {{...}} directives.
//
// The template syntax itself: anything between `{{` and `}}`. Inside:
//   path[ | filter [arg [arg ...]] [| filter [arg ...]] ... ]
// Path is everything up to the first `|` (or `}}` if no filters). Filters are
// pipe-separated, each: a name followed by space-separated args. Args support
// double-quoted strings for spaces.

export class TemplateParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'TemplateParseError';
    this.pos = pos;
  }
}

const OPEN = '{{';
const CLOSE = '}}';

// Walk a single string, emit a list of literal-or-template nodes. Used both by
// parseText directly and by parseTagged on each raw string segment.
function _parseString(s, nodesOut) {
  let i = 0;
  while (i < s.length) {
    const openIdx = s.indexOf(OPEN, i);
    if (openIdx === -1) {
      if (i < s.length) nodesOut.push({ kind: 'literal', text: s.slice(i) });
      return;
    }
    if (openIdx > i) nodesOut.push({ kind: 'literal', text: s.slice(i, openIdx) });
    const closeIdx = s.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      throw new TemplateParseError(
        `unclosed '{{' starting at offset ${openIdx}`, openIdx);
    }
    const body = s.slice(openIdx + OPEN.length, closeIdx);
    nodesOut.push(_parseDirective(body, openIdx + OPEN.length));
    i = closeIdx + CLOSE.length;
  }
}

// path | filter args | filter args ...
//
// Splitting on `|` is straightforward — `|` is not a legal VFS path character
// and we don't (yet) support pipes inside quoted strings. If that becomes a
// need, tokenize properly.
function _parseDirective(body, pos) {
  const parts = body.split('|').map((p) => p.trim());
  const path = parts[0];
  if (!path) {
    throw new TemplateParseError(`empty template directive at offset ${pos}`, pos);
  }
  const filters = [];
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (!segment) {
      throw new TemplateParseError(
        `empty filter segment in '{{${body}}}' at offset ${pos}`, pos);
    }
    filters.push(_parseFilter(segment, pos));
  }
  return { kind: 'template', path, filters };
}

// Tokenize one filter segment. Name is the first whitespace-delimited token,
// remaining tokens are args. Args support double-quoted strings (with \" and
// \\ escapes); a bare token is whatever non-space sequence follows.
function _parseFilter(segment, pos) {
  const tokens = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i])) i++;
    if (i >= segment.length) break;
    if (segment[i] === '"') {
      let buf = '';
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < segment.length) {
          buf += segment[i + 1];
          i += 2;
        } else {
          buf += segment[i++];
        }
      }
      if (i >= segment.length) {
        throw new TemplateParseError(
          `unterminated quoted argument in filter "${segment}"`, pos);
      }
      i++;
      tokens.push(buf);
    } else {
      let buf = '';
      while (i < segment.length && !/\s/.test(segment[i])) buf += segment[i++];
      tokens.push(buf);
    }
  }
  if (tokens.length === 0) {
    throw new TemplateParseError(`empty filter segment at offset ${pos}`, pos);
  }
  return { name: tokens[0], args: tokens.slice(1) };
}

// Public entry: parse a plain template string.
export function parseText(s) {
  if (typeof s !== 'string') {
    throw new TemplateParseError(`parseText expected a string, got ${typeof s}`, 0);
  }
  const nodes = [];
  _parseString(s, nodes);
  return nodes;
}

// Public entry: parse from tagged-template arguments. Interpolated `${expr}`
// values land as 'opaque' nodes so they're never re-scanned for {{...}}, which
// would otherwise let a user-controlled value inject directives.
export function parseTagged(strings, values) {
  const nodes = [];
  for (let i = 0; i < strings.length; i++) {
    _parseString(strings[i], nodes);
    if (i < values.length) {
      nodes.push({ kind: 'opaque', text: String(values[i]) });
    }
  }
  return nodes;
}

// Walk an AST and return the set of paths it references. Used for reactivity:
// the consumer subscribes to VFS.Changed for each path and re-renders.
// Resolved paths (relative vs absolute) are NOT computed here — the renderer
// does that with cwd context. This returns the raw `path` field from each
// template node.
export function listPaths(ast) {
  const out = [];
  for (const n of ast) if (n.kind === 'template') out.push(n.path);
  return out;
}
