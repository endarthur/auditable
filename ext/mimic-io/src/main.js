// @gcu/mimic-io — package entry point
//
// Public surface (per SPEC-mimic-io.md):
//   - dump(estimator, opts?)            — produce a v2 JSON dict
//   - load(json, opts?)                 — instantiate from v2 (or v1) JSON
//   - register(class_id, Ctor, opts?)   — register in defaultRegistry
//   - createRegistry()                  — fresh, isolated registry
//   - defaultRegistry                   — shared registry for register()
//   - canonicalize(value, opts?)        — canonical serialization for signing
//   - encodeTypedArray / decodeTypedArray — typed-array codec helpers
//   - MimicIOUnsupportedClass           — thrown when load can't find a class
//   - normalizeV1 / isV1                — v1 → v2 data-only transform

export { dump, load, MimicIOUnsupportedClass } from './dump-load.js';
export { register, createRegistry, defaultRegistry } from './registry.js';
export { canonicalize } from './canonical.js';
export {
  encodeTypedArray,
  decodeTypedArray,
  isTypedArrayRef,
} from './typed-array.js';
export { normalizeV1, isV1 } from './v1-normalize.js';
