// @gcu/build — error codes & formatting (SPEC §15)
//
// All errors carry a stable short code (E0xx). Codes are never renumbered;
// new codes get new numbers. Phase 1 uses a subset; the rest land with the
// lint pass in phase 2.

export class BuildError extends Error {
  constructor(code, message, loc) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.loc = loc || null; // { file, line, col }
  }
  toString() {
    let s = `gcu-build: error ${this.code}: ${this.message}`;
    if (this.loc) s += `\n  at ${this.loc.file}:${this.loc.line}:${this.loc.col}`;
    return s;
  }
}

// Codes in use this phase (full table in SPEC §15).
export const CODES = {
  E001: 'parse error',
  E002: 'relative import escapes src/',
  E003: 'extension-less import',
  E004: 'directory-index import',
  E005: 'export default in sources',
  E006: 'dynamic import() in sources',
  E007: 'unresolvable collision',
  E013: 'circular import detected',
};

export function buildError(code, message, loc) {
  return new BuildError(code, message, loc);
}

// Translate an acorn loc ({ line, column }) plus a file path into our loc shape.
export function astLoc(file, node) {
  if (!node || !node.loc) return { file, line: 0, col: 0 };
  return { file, line: node.loc.start.line, col: node.loc.start.column };
}
