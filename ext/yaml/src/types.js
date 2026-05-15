// AST node shape and error class for @gcu/yaml.
//
// Every node is one of:
//   { kind: 'scalar', type: 'null'|'bool'|'int'|'float'|'string', value, ... }
//   { kind: 'map',  entries: [{ key, value }] }
//   { kind: 'seq',  items: [Node] }
//
// All nodes carry:
//   tag                    — string | null
//   leadingComments        — string[]  (comments on lines above the node)
//   trailingComment        — string | null  (same-line trailing)
//   blockTrailingComments  — string[]  (comments attached after the node's region)
//   loc                    — { line, column } 1-based, byte-counted
//
// Scalar nodes may carry hints (not data) for the emitter:
//   radix       — 'hex' | 'oct' | 'bin'                (int only)
//   separators  — true                                  (int only: emit underscores)
//   style       — 'double' | 'single' | 'block-clip'
//                | 'block-strip'                         (string only)

export class YamlParseError extends Error {
  constructor(rule, line, column, message, byteRange) {
    super(`[rule ${rule}] line ${line}, col ${column}: ${message}`);
    this.name = 'YamlParseError';
    this.rule = rule;
    this.line = line;
    this.column = column;
    this.byteRange = byteRange || null;
  }
}

export function scalar(type, value, opts = {}) {
  return {
    kind: 'scalar',
    type,
    value,
    radix: opts.radix || null,
    separators: opts.separators || false,
    style: opts.style || null,
    tag: opts.tag || null,
    leadingComments: opts.leadingComments || [],
    trailingComment: opts.trailingComment || null,
    blockTrailingComments: opts.blockTrailingComments || [],
    loc: opts.loc || { line: 0, column: 0 },
  };
}

export function mapNode(entries, opts = {}) {
  return {
    kind: 'map',
    entries: entries || [],
    tag: opts.tag || null,
    leadingComments: opts.leadingComments || [],
    trailingComment: opts.trailingComment || null,
    blockTrailingComments: opts.blockTrailingComments || [],
    loc: opts.loc || { line: 0, column: 0 },
  };
}

export function seqNode(items, opts = {}) {
  return {
    kind: 'seq',
    items: items || [],
    tag: opts.tag || null,
    leadingComments: opts.leadingComments || [],
    trailingComment: opts.trailingComment || null,
    blockTrailingComments: opts.blockTrailingComments || [],
    loc: opts.loc || { line: 0, column: 0 },
  };
}

export function mapEntry(key, value) {
  return { key, value };
}

export const MAX_DEPTH = 64;
