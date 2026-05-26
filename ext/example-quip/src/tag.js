// Tagged template — EXTENSION_SPEC §3.2.
//
// Lets a JS code cell embed a quip block inline:
//
//   const phrases = quip`
//     hello = Hi, {name}!
//     bye   = See you, {name}.
//   `;
//   phrases.hello({ name: "Ana" });   // "Hi, Ana!"
//
// Same parse-then-compile flow as the cell handler.

import { compileQuip } from './parse.js';

export function quipTag(strings, ...values) {
  // Standard tag interpolation: interleave strings + values into one
  // source string, then compile. Values are stringified via String().
  let src = '';
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) src += String(values[i]);
  }
  return compileQuip(src);
}
