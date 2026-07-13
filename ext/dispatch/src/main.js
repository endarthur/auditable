// @gcu/dispatch — module manifest / curated export surface.
// One utterance in, one routed, explainable tool call out — session-trained
// (the model is younger than your coffee), zero-dep, browser-pure, Sealed-
// compatible. See SPEC.md; provenance: the gcu-dispatch incubator.
export { deriveVocab, LOCALES, ELEMENT_LEX } from './vocab.js';
export { createContext } from './features.js';
export { KINDS } from './kinds.js';
export { generate } from './gen.js';
export { alignCorpus, trainModels, TAGS } from './train.js';
export { createDispatcher, trainSession } from './api.js';
export { tokenize, normText, mulberry32 } from './text.js';
