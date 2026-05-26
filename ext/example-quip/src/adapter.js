// Python-shape adapter — EXTENSION_SPEC §4 (adder.js convention).
//
// Exposes the `quip` namespace to adder cells so:
//
//   /// adder
//   from quip import parse, render
//   p = parse("hello = Hi, {name}!")
//   print(p["hello"]({"name": "Ana"}))
//   print(render("Watch out for {x}!", {"x": "bears"}))
//
// resolves transparently through window._auditableExtensions.

import { parseQuip, renderQuip, compileQuip, makePhrases } from './parse.js';

export const quipNamespace = {
  // Match Python conventions where it's natural — but quip is small
  // enough that the JS names are already idiomatic in either language.
  parse:   parseQuip,
  render:  renderQuip,
  compile: compileQuip,
  fromMap: makePhrases,
};
