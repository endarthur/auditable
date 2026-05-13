// dump/load wrappers around @gcu/mimic-io.
//
// learnRegistry is a per-library registry isolated from mimic-io's
// defaultRegistry — mixing learn estimators with arborist or sklearn JSON
// is intentional but requires the consumer to register what they want to
// allow. Per spec §6.3 of SPEC-mimic-io.md, registries are per-consumer,
// not global.
//
// Each estimator module self-registers at load time (side effect on
// import). preprocessing.js, tree.js, etc. each end with:
//
//   learnRegistry.register('StandardScaler', StandardScaler,
//     { module: '@gcu/learn.preprocessing' });
//
// dump(est) writes "@gcu/learn.<submodule>" into the module field; load(j)
// looks up the class against learnRegistry. Pass `{ registry: ... }` to
// load against a different registry — useful for cross-library round-trips.

import { dump as _mioDump, load as _mioLoad, createRegistry, MimicIOUnsupportedClass, isV1, normalizeV1 } from '../../mimic-io/index.js';

/** Per-library registry. Estimator modules populate this on import. */
export const learnRegistry = createRegistry();

const FORMAT_TAG = 'mimic-io';
const VERSION = 2;

/**
 * Serialize a fitted @gcu/learn estimator to a v2 mimic-io JSON dict.
 *
 * The estimator's module identifier defaults to "@gcu/learn" if not set
 * by the caller. Estimator modules are encouraged to set est._module to
 * their submodule path (e.g. "@gcu/learn.preprocessing") so cross-library
 * loaders can route correctly.
 *
 * Custom serialization: estimators that own their codec (Pipeline, etc.)
 * implement `_toMimicIo(opts)` returning a v2 dict directly. dump checks
 * for this hook and uses it in preference to mimic-io's default walker.
 *
 * @param {object} est — a fitted estimator
 * @param {object} [opts]
 * @param {string} [opts.module] — override the module identifier
 * @returns {object} v2 mimic-io JSON dict
 */
export function dump(est, opts = {}) {
  if (typeof est?._toMimicIo === 'function') {
    return est._toMimicIo(opts);
  }
  const module_id = opts.module ?? est?._module ?? '@gcu/learn';
  return _mioDump(est, { ...opts, module: module_id });
}

/**
 * Load a v2 (or v1) mimic-io JSON dict into a fresh estimator instance.
 *
 * Custom deserialization: classes that own their codec implement a
 * static `_fromMimicIo(json, opts)` method. load() resolves the class
 * through the registry, then dispatches to that hook when present in
 * preference to mimic-io's default reconstruction.
 *
 * @param {object|string} input — parsed JSON object or a JSON string
 * @param {object} [opts]
 * @param {ReturnType<createRegistry>} [opts.registry] — defaults to
 *   learnRegistry; pass mimic-io's defaultRegistry or a custom one for
 *   cross-library loads.
 * @param {boolean} [opts.strict=true] — throw MimicIOUnsupportedClass on
 *   unknown classes (default) vs returning the decoded dict as-is.
 * @returns {object} the loaded estimator
 */
export function load(input, opts = {}) {
  const registry = opts.registry ?? learnRegistry;
  // Pre-parse to check for the _fromMimicIo hook before delegating.
  const root = typeof input === 'string' ? JSON.parse(input) : input;
  const v2 = (root && isV1(root)) ? normalizeV1(root) : root;
  if (v2 && v2.format === FORMAT_TAG && v2.version === VERSION) {
    const entry = registry.get(v2.class);
    if (entry?.ClassCtor && typeof entry.ClassCtor._fromMimicIo === 'function') {
      return entry.ClassCtor._fromMimicIo(v2, { ...opts, registry });
    }
  }
  return _mioLoad(v2 ?? input, { ...opts, registry });
}

// Re-export the unsupported-class error so callers can catch specifically
// without having to import @gcu/mimic-io directly.
export { MimicIOUnsupportedClass };
