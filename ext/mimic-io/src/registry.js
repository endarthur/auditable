// @gcu/mimic-io — class registry (spec §2.3, §6.3)
//
// The registry is the security boundary: load(json) only instantiates
// classes the consumer has registered. Custom classes register at
// runtime via `register(class_id, EstimatorClass, schema?)`. Default
// state is empty — a fresh consumer can't load anything until it
// registers what it knows.
//
// Per spec §6.3, the registry is per-consumer, not global. Each
// `createRegistry()` returns a fresh map; the default exported
// `defaultRegistry` is one such, shared by direct callers of
// `register(...)` for convenience. Libraries that want isolation make
// their own.

/**
 * @typedef {Object} RegistryEntry
 * @property {Function} ClassCtor   — the constructor (or factory)
 * @property {object|null} schema   — JSON Schema for params + fitted
 *                                    (optional; null means no validation)
 * @property {string[]} aliases     — additional module identifiers
 *                                    accepted on load
 */

/** Build a fresh registry. Each entry is keyed by class identifier
 *  (e.g. "DecisionTreeClassifier"); multiple module identifiers map
 *  to the same class via aliases. */
export function createRegistry() {
  const byClass = new Map(); // class_id → entry
  return {
    /**
     * Register a class for load. `class_id` is the canonical name
     * (e.g. "DecisionTreeClassifier"); `module` is the module identifier
     * (e.g. "@gcu/learn.tree" or "sklearn.tree") — the same class can be
     * registered multiple times under different modules.
     */
    register(class_id, ClassCtor, opts = {}) {
      if (!class_id || typeof class_id !== 'string') {
        throw new Error('register: class_id must be a non-empty string');
      }
      if (typeof ClassCtor !== 'function') {
        throw new Error(`register: ClassCtor for "${class_id}" must be a function`);
      }
      const existing = byClass.get(class_id);
      if (existing && existing.ClassCtor !== ClassCtor) {
        // Re-registration with a different ctor — overwrite but warn.
        // Consumers may want strict mode; for now, last-write-wins.
      }
      byClass.set(class_id, {
        ClassCtor,
        schema: opts.schema ?? null,
        aliases: opts.modules ?? (opts.module ? [opts.module] : []),
      });
    },
    /** Look up a class entry by `class` field. */
    get(class_id) { return byClass.get(class_id); },
    /** True if registered. */
    has(class_id) { return byClass.has(class_id); },
    /** All registered class identifiers (debugging / introspection). */
    list() { return [...byClass.keys()].sort(); },
    /** Remove a registration. Returns true if removed. */
    unregister(class_id) { return byClass.delete(class_id); },
  };
}

/** Shared default registry for `register(...)` and direct
 *  `load(...)` callers. Library authors who need isolation create
 *  their own via `createRegistry()`. */
export const defaultRegistry = createRegistry();

/** Convenience: register into the default registry. */
export function register(class_id, ClassCtor, opts) {
  defaultRegistry.register(class_id, ClassCtor, opts);
}
