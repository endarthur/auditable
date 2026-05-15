// Public surface for @gcu/yaml.

import { parse } from './parse.js';
import { emit } from './emit.js';

export { parse, emit };
export { YamlParseError, scalar, mapNode, seqNode } from './types.js';

// Returns null if `text` parses successfully, otherwise the YamlParseError
// instance from the strict parser.
export function check(text) {
  try {
    parse(text);
    return null;
  } catch (e) {
    return e;
  }
}

// Parse + emit. Convenience for one-shot canonicalization.
export function format(text) {
  return emit(parse(text));
}
