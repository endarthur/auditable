// @gcu/learn — adder cell bridge.
//
// Per SPEC §2.4: registers as `learn` under `_auditableExtensions`, so
// adder cells can write source-compatible scikit-learn imports with a
// single namespace edit (`s/sklearn/learn/`):
//
//   from learn.tree import DecisionTreeClassifier
//   from learn.preprocessing import StandardScaler
//   from learn.model_selection import KFold, cross_val_score
//   from learn.metrics import accuracy_score
//   from learn import dump, load
//
// adder's import machinery walks the dotted path through the namespace
// objects (preprocessing, tree, …) which are plain JS objects. No
// __getattr__ trick needed because every submodule is exposed directly
// as a property.

import * as _learn from './index.js';

const _module = {
  // ── submodules (sklearn-shape namespaces) ──
  base: _learn.base,
  preprocessing: _learn.preprocessing,
  tree: _learn.tree,
  cluster: _learn.cluster,
  decomposition: _learn.decomposition,
  compositional: _learn.compositional,
  pipeline: _learn.pipeline,
  compose: _learn.compose,
  model_selection: _learn.model_selection,
  metrics: _learn.metrics,
  utils: _learn.utils,
  linear_model: _learn.linear_model,
  ensemble: _learn.ensemble,
  impute: _learn.impute,
  neighbors: _learn.neighbors,
  mixture: _learn.mixture,
  cross_decomposition: _learn.cross_decomposition,

  // ── top-level helpers (exposed at `learn.<name>`) ──
  dump: _learn.dump,
  load: _learn.load,
  clone: _learn.clone,
  check_is_fitted: _learn.check_is_fitted,
  check_estimator: _learn.check_estimator,
  NotFittedError: _learn.NotFittedError,
  learnRegistry: _learn.learnRegistry,
  mulberry32: _learn.mulberry32,
  makeRng: _learn.makeRng,

  // ── flat re-exports of the most-used classes (so `from learn import …`
  // pulls them directly, matching sklearn's habit of `from sklearn import
  // pipeline` working alongside `from sklearn.pipeline import Pipeline`) ──
  BaseEstimator: _learn.BaseEstimator,
  ClassifierMixin: _learn.ClassifierMixin,
  RegressorMixin: _learn.RegressorMixin,
  TransformerMixin: _learn.TransformerMixin,
  ClusterMixin: _learn.ClusterMixin,
  Pipeline: _learn.Pipeline,
  make_pipeline: _learn.make_pipeline,
  ColumnTransformer: _learn.ColumnTransformer,
  make_column_transformer: _learn.make_column_transformer,
};

// ── Registration ──
// Auditable's manifest API is preferred when available (auto-validates
// the extension shape); fall back to the legacy slot for older runtimes.
if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/learn',
      version: '0.1.0',
      description: 'sklearn-compatible classical ML for adder cells',
      exports: { learn: _module },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions['learn'] = _module;
  }
}

export { _module as learnAdder };
