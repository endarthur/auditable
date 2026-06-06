// @gcu/build — node parser factory (adapter-side)
// Builds an acorn+TS parser from the vendored bundle for node adapters/tests.
// (The browser path uses window.Acorn; the pure core handles that fallback.)

import { Parser, tsPlugin } from '../../../acorn/acorn.esm.min.js';

export function makeNodeParser() {
  return Parser.extend(tsPlugin());
}
