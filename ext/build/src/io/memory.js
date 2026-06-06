// @gcu/build — in-memory adapter (SPEC §1.4)
// A plain object in, a BundleResult out. Backs the test suite — no temp dirs,
// deterministic. The only "I/O" is acquiring a parser.

import { bundleModules } from '../core.js';
import { makeNodeParser } from './parser-node.js';

let _parser = null;

export function bundleMemory(sources, opts) {
  if (!_parser) _parser = makeNodeParser();
  return bundleModules(sources, { ...opts, parser: _parser });
}
