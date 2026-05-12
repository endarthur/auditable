// @gcu/mimic-io — top-level dump / load
//
// dump(estimator) walks the estimator's exposed `params` (hyperparameters
// at construction time) and trailing-underscore fitted attributes into a
// v2 mimic-io JSON dict. Recursive for nested estimators (Pipeline steps,
// ensemble.estimators_, ColumnTransformer branches).
//
// load(json, registry?) looks up the `class` field in the registry,
// instantiates with `params`, then assigns fitted attributes. Recursive
// in the same shape.
//
// Typed-array references in `fitted` decode to real TypedArrays. Plain
// JSON arrays of numbers also accepted as semantically equivalent
// (spec §5.3).

import { encodeTypedArray, decodeTypedArray, isTypedArrayRef } from './typed-array.js';
import { defaultRegistry } from './registry.js';
import { isV1, normalizeV1 } from './v1-normalize.js';

const FORMAT_TAG = 'mimic-io';
const VERSION = 2;

/**
 * Custom error thrown when load encounters an unsupported class.
 * Distinct from generic Error so callers can catch specifically.
 */
export class MimicIOUnsupportedClass extends Error {
  constructor(class_id, module_id) {
    super(`this consumer does not implement ${class_id} from ${module_id ?? '<unknown module>'}`);
    this.name = 'MimicIOUnsupportedClass';
    this.class_id = class_id;
    this.module_id = module_id;
  }
}

/**
 * Build a v2 mimic-io JSON dict from a fitted estimator-shaped object.
 *
 * The estimator must expose:
 *   - `constructor.name` or an explicit `_class_id` field → the class
 *     identifier
 *   - `get_params()` returning the hyperparameter dict (or a `_params`
 *     field as fallback)
 *   - Trailing-underscore attributes for fitted state (`coef_`,
 *     `tree_`, `n_features_in_`, etc.)
 *
 * Or — and this is the load-without-class path — a plain JS object
 * matching the v2 shape directly is also accepted. Useful for testing
 * and for callers building the JSON by hand.
 *
 * @param {object} est — a fitted estimator or v2-shaped dict
 * @param {object} [opts]
 * @param {string} [opts.module] — module identifier to write into the
 *   `module` field. Defaults to "<unknown>" when the estimator doesn't
 *   carry one.
 * @returns {object} v2 mimic-io JSON dict
 */
export function dump(est, opts = {}) {
  if (est == null || typeof est !== 'object') {
    throw new Error('dump: input must be an object');
  }

  // Pre-shaped path: caller hands us a v2 dict directly.
  if (est.format === FORMAT_TAG && (est.version === 2 || est.version === 1)) {
    return _dumpV2Tree(est);
  }

  const class_id = est._class_id ?? est.constructor?.name;
  if (!class_id || class_id === 'Object') {
    throw new Error(
      'dump: cannot determine class identifier — set est._class_id or wrap ' +
      'in a class with a meaningful constructor.name, or pass a pre-shaped ' +
      'v2 dict.',
    );
  }
  const module_id = opts.module ?? est._module ?? '<unknown>';

  const params = typeof est.get_params === 'function'
    ? est.get_params(/* deep = */ false)
    : (est._params ?? {});

  // Collect trailing-underscore attributes as the fitted block.
  const fitted = {};
  for (const key of Object.keys(est)) {
    if (key.endsWith('_') && !key.startsWith('_')) {
      fitted[key] = _encodeValue(est[key]);
    }
  }

  const out = {
    format: FORMAT_TAG,
    version: VERSION,
    class: class_id,
    module: module_id,
    params: _encodeParams(params),
    fitted,
  };
  if (est.metadata_) out.metadata = est.metadata_;
  return out;
}

/**
 * Load a v2 (or v1) mimic-io JSON dict into a constructed estimator.
 *
 * Lookup follows: parse → optional v1→v2 normalize → registry lookup by
 * `class` → instantiate with `params` → assign fitted attributes.
 *
 * @param {object|string} input — parsed JSON object or a JSON string
 * @param {object} [opts]
 * @param {ReturnType<createRegistry>} [opts.registry] — defaults to
 *   `defaultRegistry`
 * @param {boolean} [opts.rejectBigInt=true] — see decodeTypedArray
 * @returns {object} a fresh estimator instance (or the v2 dict if no
 *   constructor was registered and opts.strict=false)
 */
export function load(input, opts = {}) {
  const registry = opts.registry ?? defaultRegistry;
  const rejectBigInt = opts.rejectBigInt ?? true;
  const strict = opts.strict ?? true;

  const root = typeof input === 'string' ? JSON.parse(input) : input;

  // v1 normalization happens before anything else — by the time we hit
  // the registry the data is in v2 shape.
  const v2 = isV1(root) ? normalizeV1(root) : root;

  if (v2.format !== FORMAT_TAG) {
    throw new Error(`load: not a mimic-io file (format="${v2.format}")`);
  }
  if (v2.version !== VERSION) {
    throw new Error(`load: unsupported version ${v2.version} (this loader handles v${VERSION})`);
  }

  return _loadOne(v2, registry, rejectBigInt, strict);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _loadOne(node, registry, rejectBigInt, strict) {
  const class_id = node.class;
  const module_id = node.module;
  const entry = registry.get(class_id);

  if (!entry) {
    if (strict) throw new MimicIOUnsupportedClass(class_id, module_id);
    // Non-strict: return the decoded dict as-is. Caller deals.
    return _decodeBlock(node, registry, rejectBigInt, strict);
  }

  // Decode params (recursively — nested estimators in hyperparameters).
  const params = _decodeParams(node.params ?? {}, registry, rejectBigInt, strict);
  // Instantiate. The constructor signature is per-class-specific; the
  // sklearn convention is "store hyperparameters only, no work" — so
  // passing the params dict as a single argument is enough for most
  // estimators. Custom registrations can override by passing a factory.
  const est = new entry.ClassCtor(params);

  // Decode fitted state.
  const fitted = node.fitted;
  if (fitted != null && fitted !== false && typeof fitted === 'object') {
    for (const key of Object.keys(fitted)) {
      est[key] = _decodeValue(fitted[key], registry, rejectBigInt, strict);
    }
  }

  // Preserve metadata on `metadata_` for round-trip.
  if (node.metadata) est.metadata_ = node.metadata;
  return est;
}

// Walk a value that came from `fitted` or a hyperparameter slot:
//   - Nested mimic-io block → recursive load (instantiated estimator)
//   - Typed-array ref → decoded TypedArray
//   - Plain array → walk element-wise (may contain nested blocks)
//   - Plain object → walk values (preserves shape, no class instantiation)
//   - Scalar → pass through
function _decodeValue(v, registry, rejectBigInt, strict) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return v.map(x => _decodeValue(x, registry, rejectBigInt, strict));
  }
  if (isTypedArrayRef(v)) {
    return decodeTypedArray(v, { rejectBigInt });
  }
  if (v.format === FORMAT_TAG && v.version === VERSION) {
    // Nested estimator block — recurse.
    return _loadOne(v, registry, rejectBigInt, strict);
  }
  // Plain object — walk values, preserve shape (e.g. Pipeline's named_steps).
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = _decodeValue(v[k], registry, rejectBigInt, strict);
  }
  return out;
}

// Params can contain nested mimic-io blocks (e.g. BaggingClassifier's
// base_estimator). For unfitted nested params, `fitted` is null.
function _decodeParams(params, registry, rejectBigInt, strict) {
  if (params == null || typeof params !== 'object') return params;
  if (Array.isArray(params)) {
    return params.map(p => _decodeValue(p, registry, rejectBigInt, strict));
  }
  const out = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v != null && typeof v === 'object' && v.format === FORMAT_TAG
        && v.version === VERSION && v.fitted == null) {
      // Unfitted nested estimator — instantiate from params only.
      const entry = registry.get(v.class);
      if (!entry) {
        if (strict) throw new MimicIOUnsupportedClass(v.class, v.module);
        out[k] = _decodeBlock(v, registry, rejectBigInt, strict);
        continue;
      }
      const nestedParams = _decodeParams(v.params ?? {}, registry, rejectBigInt, strict);
      out[k] = new entry.ClassCtor(nestedParams);
    } else {
      out[k] = _decodeValue(v, registry, rejectBigInt, strict);
    }
  }
  return out;
}

// Used when strict=false and a class isn't registered — return a decoded
// dict so caller can inspect it without instantiation.
function _decodeBlock(node, registry, rejectBigInt, strict) {
  const out = {
    format: node.format,
    version: node.version,
    class: node.class,
    module: node.module,
    params: _decodeParams(node.params ?? {}, registry, rejectBigInt, strict),
    fitted: node.fitted ? _decodeValue(node.fitted, registry, rejectBigInt, strict) : node.fitted,
  };
  if (node.metadata) out.metadata = node.metadata;
  return out;
}

// Walk an already-v2 JSON tree (estimator-shape dict) and produce a clean
// copy with typed arrays normalized to refs. Used when caller passes a
// pre-shaped v2 dict to dump().
function _dumpV2Tree(node) {
  const out = {
    format: node.format,
    version: node.version,
    class: node.class,
    module: node.module,
    params: _encodeParams(node.params ?? {}),
    fitted: node.fitted == null ? node.fitted : _encodeValue(node.fitted),
  };
  if (node.metadata) out.metadata = node.metadata;
  return out;
}

// Walk a value for the dump path — typed arrays become refs, nested
// mimic-io-shaped subobjects pass through with their typed arrays also
// encoded.
function _encodeValue(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    // Real typed array — encode.
    return encodeTypedArray(v);
  }
  if (Array.isArray(v)) {
    return v.map(_encodeValue);
  }
  if (v.format === FORMAT_TAG) {
    // Already-shaped nested mimic-io block — recurse via the tree walker.
    return _dumpV2Tree(v);
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = _encodeValue(v[k]);
  return out;
}

function _encodeParams(params) {
  if (params == null || typeof params !== 'object') return params;
  return _encodeValue(params);
}
