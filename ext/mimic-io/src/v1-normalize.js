// @gcu/mimic-io — v1 → v2 in-memory normalization (spec §3.5)
//
// arborist has been writing mimic-io v1 since its initial release. v1's
// top-level shape is flat — fields like `algorithm`, `criterion`, `mode`,
// `tree`, `bonsai` live directly under the root rather than under
// `params` / `fitted` / `metadata`.
//
// This module transforms a parsed v1 JSON object into the equivalent v2
// shape so the rest of the load pipeline doesn't have to special-case it.
// The transform is data-only (no instantiation); the load layer takes the
// resulting v2 dict and routes it through the registry as usual.
//
// v1 covers DecisionTreeClassifier and DecisionTreeRegressor only —
// arborist never emitted anything else. mode="classification" maps to
// DecisionTreeClassifier; mode="regression" maps to DecisionTreeRegressor.

/**
 * @param {object} v1 — parsed v1 JSON object (the top-level dict)
 * @returns {object} — equivalent v2 dict
 */
export function normalizeV1(v1) {
  if (v1.version !== 1) {
    throw new Error(`normalizeV1: expected version 1, got ${v1.version}`);
  }
  if (v1.format !== 'mimic-io') {
    throw new Error(`normalizeV1: not a mimic-io file (format="${v1.format}")`);
  }
  // mode determines classifier vs regressor.
  const isReg = v1.mode === 'regression';
  const class_id = isReg ? 'DecisionTreeRegressor' : 'DecisionTreeClassifier';

  const v2 = {
    format: 'mimic-io',
    version: 2,
    class: class_id,
    // Synthetic module identifier — there is no arborist class id in v1.
    // Consumers may treat "arborist" as an alias for "@gcu/learn.tree".
    module: 'arborist',
    params: {
      criterion: v1.criterion ?? (isReg ? 'variance' : 'gini'),
      // _mode is a synthetic field — underscore-prefixed to mark it as a
      // v1-bridge artifact rather than a real sklearn param. The class id
      // already encodes mode, but we keep it for downstream code that
      // expects to read it.
      _mode: v1.mode ?? (isReg ? 'regression' : 'classification'),
    },
    fitted: {
      n_features_in_: v1.n_features,
      tree_: v1.tree,  // parallel-array structure carries over unchanged
    },
    metadata: {},
  };

  if (Array.isArray(v1.feature_names)) {
    v2.fitted.feature_names_in_ = v1.feature_names;
  }
  if (Array.isArray(v1.class_names)) {
    v2.fitted.classes_ = v1.class_names;
    v2.fitted.n_classes_ = v1.n_classes ?? v1.class_names.length;
  } else if (Number.isFinite(v1.n_classes)) {
    v2.fitted.n_classes_ = v1.n_classes;
  }
  if (v1.target_name != null) {
    v2.metadata.target_name = v1.target_name;
  }
  if (v1.bonsai && typeof v1.bonsai === 'object') {
    v2.metadata.bonsai = v1.bonsai;
  }
  if (v1.exported_at) {
    v2.metadata.fitted_at = v1.exported_at;
  }
  if (v1.algorithm && v1.algorithm !== 'CART') {
    // Note non-CART algorithms in metadata so consumers can see them;
    // we don't try to handle them (arborist has only ever emitted CART).
    v2.metadata.v1_algorithm = v1.algorithm;
  }

  // Drop metadata if empty for cleanliness.
  if (Object.keys(v2.metadata).length === 0) delete v2.metadata;

  return v2;
}

/** True if a parsed object looks like a v1 mimic-io file. */
export function isV1(obj) {
  return obj && typeof obj === 'object'
    && obj.format === 'mimic-io'
    && obj.version === 1;
}
