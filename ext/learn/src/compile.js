// Tree compilation — emit native-JS predict functions from fitted
// decision trees. Implements SPEC §6.5's `.compile()` performance
// tier for the tree family (DecisionTree*, RandomForest*, ExtraTrees*,
// GradientBoosting*).
//
// Pragmatic implementation note. The spec proposes routing through
// AIR's lower→emit pipeline so tree compilation reuses the same
// machinery as adder/Soft. For v0.2 we instead emit JS source strings
// directly and `new Function`-them. Same V8 outcome (JIT'd nested
// branches with literal thresholds, exactly the shape Treelite emits
// to C). Less plumbing while AIR's API for synthetic-IR construction
// stabilizes; can be retargeted to AIR in v0.3 without API changes.
//
// Public surface:
//   - compileTreeValue(tree)   → fn(x: Float64Array, off: int) → leaf value (for regressor)
//   - compileTreeClass(tree, classes_) → fn(x, off) → predicted class label
//   - compileTreeLeaf(tree)    → fn(x, off) → leaf node id
//
// All compiled functions take (x, off) where x is a flat Float64Array
// (the full row-major X matrix) and off is the row offset (i * m).
// This avoids per-row slicing — the caller iterates rows by stepping
// off by m each time.

import { ValidationError } from './util/checks.js';

// ────────────────────────────────────────────────────────────────────
// Source emitters
// ────────────────────────────────────────────────────────────────────

/** Emit JS source that walks `tree` and returns the leaf value (regressor). */
export function compileTreeValue(tree) {
  // Single `return <ternary>;` shape: smaller function body than nested
  // if/else blocks, keeps V8's inliner happy past deeper trees.
  const body = 'return ' + _emitNodeTernary(tree, 0, (leaf_id) => String(tree.value[leaf_id])) + ';';
  // eslint-disable-next-line no-new-func
  return new Function('x', 'off', body);
}

/**
 * Emit JS source that walks `tree` and returns the predicted class label.
 * The argmax class index per leaf is precomputed and inlined as a literal.
 *
 * @param {object} tree    — fitted tree object
 * @param {Float64Array} classes — sorted class labels
 */
export function compileTreeClass(tree, classes) {
  // Precompute argmax class index per leaf.
  const stride = tree.value_stride;
  const k = stride;  // n_classes
  const labelOf = (leaf_id) => {
    const off = leaf_id * stride;
    let best = 0, bestN = -Infinity;
    for (let c = 0; c < k; c++) {
      if (tree.value[off + c] > bestN) { best = c; bestN = tree.value[off + c]; }
    }
    return classes[best];
  };
  const body = 'return ' + _emitNodeTernary(tree, 0, (leaf_id) => String(labelOf(leaf_id))) + ';';
  return new Function('x', 'off', body);
}

/** Emit JS source that returns the leaf node id (for predict_proba lookup). */
export function compileTreeLeaf(tree) {
  const body = 'return ' + _emitNodeTernary(tree, 0, (leaf_id) => String(leaf_id)) + ';';
  return new Function('x', 'off', body);
}

// Recursive node emitter, ternary form:
//   `(x[off+f] <= t ? <left-expr> : <right-expr>)`
// Each leaf is rendered as a literal expression by `leafToValue`.
// Single-expression form keeps the function small — V8's inliner uses
// function-source size as one heuristic, and nested if/else blocks
// generate multiple statements + multiple returns that bloat the AST.
function _emitNodeTernary(tree, node_id, leafToValue) {
  if (tree.children_left[node_id] === -1) {
    return leafToValue(node_id);
  }
  const f = tree.feature[node_id];
  const t_str = _floatLiteral(tree.threshold[node_id]);
  return (
    '(x[off+' + f + ']<=' + t_str + '?' +
    _emitNodeTernary(tree, tree.children_left[node_id], leafToValue) +
    ':' +
    _emitNodeTernary(tree, tree.children_right[node_id], leafToValue) +
    ')'
  );
}

// Format a float to a JS literal preserving precision. Integer-valued
// floats stay as ints (cleaner output); everything else uses the
// shortest round-trippable representation (Number.prototype.toString
// returns this by default).
function _floatLiteral(v) {
  if (!Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'NaN';
    return v > 0 ? 'Infinity' : '-Infinity';
  }
  return String(v);
}

// ────────────────────────────────────────────────────────────────────
// .compile() helpers — install on the tree-family estimator classes
// ────────────────────────────────────────────────────────────────────

/**
 * Wire `.compile()` onto the tree-family estimators. Idempotent: calling
 * twice replaces the compiled functions. Called from main.js at module
 * load.
 *
 * Each estimator type gets a custom compile() that:
 *   - builds compiled per-tree functions
 *   - rewires `predict` (and `predict_proba` where applicable) to
 *     dispatch through them
 *   - preserves the original predict as `_predict_interpreted`
 *     (sklearn-shape diagnostic hook)
 *
 * compile() returns `this` for chaining: `est.fit(X, y).compile().predict(X)`.
 */
export function installCompile({
  DecisionTreeClassifier, DecisionTreeRegressor,
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  GradientBoostingRegressor,
}) {
  // BaseEstimator default already exists as a no-op (added separately).
  // Below: tree-family overrides.

  // ── DecisionTreeRegressor ──
  DecisionTreeRegressor.prototype.compile = function () {
    if (!this.tree_) throw new ValidationError('compile: not fitted');
    const fn = compileTreeValue(this.tree_);
    this._compiled_predict_value = fn;
    this._predict_interpreted = this._predict_interpreted ?? this.predict;
    this.predict = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = fn(Xa, i * this.n_features_in_);
      return out;
    };
    return this;
  };

  // ── DecisionTreeClassifier ──
  DecisionTreeClassifier.prototype.compile = function () {
    if (!this.tree_) throw new ValidationError('compile: not fitted');
    const classFn = compileTreeClass(this.tree_, this.classes_);
    const leafFn = compileTreeLeaf(this.tree_);
    this._compiled_predict_class = classFn;
    this._compiled_predict_leaf = leafFn;
    this._predict_interpreted = this._predict_interpreted ?? this.predict;
    this._predict_proba_interpreted = this._predict_proba_interpreted ?? this.predict_proba;
    this.predict = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = classFn(Xa, i * this.n_features_in_);
      return out;
    };
    // For proba we still need the per-leaf normalized counts; precompute
    // a row per leaf and stash on the instance.
    const k = this.n_classes_;
    const stride = this.tree_.value_stride;
    const node_count = this.tree_.node_count;
    const leaf_proba = new Float64Array(node_count * k);
    for (let id = 0; id < node_count; id++) {
      let total = 0;
      for (let c = 0; c < k; c++) total += this.tree_.value[id * stride + c];
      const inv = total === 0 ? 0 : 1 / total;
      for (let c = 0; c < k; c++) leaf_proba[id * k + c] = this.tree_.value[id * stride + c] * inv;
    }
    this._leaf_proba = leaf_proba;
    this.predict_proba = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n * k);
      for (let i = 0; i < n; i++) {
        const leaf = leafFn(Xa, i * this.n_features_in_);
        const off_l = leaf * k;
        for (let c = 0; c < k; c++) out[i * k + c] = leaf_proba[off_l + c];
      }
      out.shape = [n, k];
      return out;
    };
    return this;
  };

  // ── RandomForestRegressor ──
  RandomForestRegressor.prototype.compile = function () {
    if (!this.estimators_) throw new ValidationError('compile: not fitted');
    const fns = this.estimators_.map(t => compileTreeValue(t.tree_));
    this._compiled_tree_values = fns;
    this._predict_interpreted = this._predict_interpreted ?? this.predict;
    this.predict = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n);
      const inv_t = 1 / fns.length;
      for (let i = 0; i < n; i++) {
        const off = i * this.n_features_in_;
        let s = 0;
        for (let t = 0; t < fns.length; t++) s += fns[t](Xa, off);
        out[i] = s * inv_t;
      }
      return out;
    };
    return this;
  };

  // ── RandomForestClassifier ──
  RandomForestClassifier.prototype.compile = function () {
    if (!this.estimators_) throw new ValidationError('compile: not fitted');
    const fns = this.estimators_.map(t => compileTreeLeaf(t.tree_));
    // Precompute per-tree per-leaf probability rows in the *forest* class
    // space (since each tree may have a different classes_ subset, we
    // remap via the union classes).
    const K = this.classes_.length;
    const tree_leaf_proba = new Array(this.estimators_.length);
    for (let t = 0; t < this.estimators_.length; t++) {
      const tree = this.estimators_[t].tree_;
      const tree_classes = this.estimators_[t].classes_;
      const k_t = tree_classes.length;
      const node_count = tree.node_count;
      const leaf_proba = new Float64Array(node_count * K);
      // Map this tree's class index → forest class index.
      const remap = new Int32Array(k_t);
      for (let c = 0; c < k_t; c++) {
        remap[c] = this.classes_.indexOf(tree_classes[c]);
      }
      for (let id = 0; id < node_count; id++) {
        let total = 0;
        for (let c = 0; c < k_t; c++) total += tree.value[id * tree.value_stride + c];
        const inv = total === 0 ? 0 : 1 / total;
        for (let c = 0; c < k_t; c++) {
          leaf_proba[id * K + remap[c]] = tree.value[id * tree.value_stride + c] * inv;
        }
      }
      tree_leaf_proba[t] = leaf_proba;
    }
    this._predict_interpreted = this._predict_interpreted ?? this.predict;
    this._predict_proba_interpreted = this._predict_proba_interpreted ?? this.predict_proba;
    this.predict_proba = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n * K);
      const inv_t = 1 / fns.length;
      for (let i = 0; i < n; i++) {
        const off = i * this.n_features_in_;
        for (let t = 0; t < fns.length; t++) {
          const leaf = fns[t](Xa, off);
          const off_l = leaf * K;
          const lp = tree_leaf_proba[t];
          for (let c = 0; c < K; c++) out[i * K + c] += lp[off_l + c] * inv_t;
        }
      }
      out.shape = [n, K];
      return out;
    };
    const classes = this.classes_;
    this.predict = function (X) {
      const proba = this.predict_proba(X);
      const n = proba.length / K;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let best = 0, bestP = -1;
        for (let c = 0; c < K; c++) {
          if (proba[i * K + c] > bestP) { best = c; bestP = proba[i * K + c]; }
        }
        out[i] = classes[best];
      }
      return out;
    };
    return this;
  };

  // ── ExtraTrees{Classifier,Regressor} share the RF compile path ──
  ExtraTreesClassifier.prototype.compile = RandomForestClassifier.prototype.compile;
  ExtraTreesRegressor.prototype.compile = RandomForestRegressor.prototype.compile;

  // ── GradientBoostingRegressor ──
  GradientBoostingRegressor.prototype.compile = function () {
    if (!this.estimators_) throw new ValidationError('compile: not fitted');
    const fns = this.estimators_.map(t => compileTreeValue(t.tree_));
    const lr = this.learning_rate;
    const init = this.init_value_;
    this._compiled_tree_values = fns;
    this._predict_interpreted = this._predict_interpreted ?? this.predict;
    this.predict = function (X) {
      const Xa = _asFlat(X, this.n_features_in_);
      const n = Xa.length / this.n_features_in_;
      const out = new Float64Array(n);
      out.fill(init);
      for (let i = 0; i < n; i++) {
        const off = i * this.n_features_in_;
        let s = init;
        for (let t = 0; t < fns.length; t++) s += lr * fns[t](Xa, off);
        out[i] = s;
      }
      return out;
    };
    return this;
  };

  // GradientBoostingClassifier compile is more involved (per-stage per-class
  // trees + softmax) — defer to v0.3.
}

// Coerce X to a flat Float64Array, validating feature count.
function _asFlat(X, m) {
  if (X == null) throw new ValidationError('compile.predict: X is null');
  if (X instanceof Float64Array && X.length % m === 0) return X;
  if (X.data instanceof Float64Array && Array.isArray(X.shape) && X.shape[1] === m) {
    return X.data;
  }
  if (Array.isArray(X) && X.length > 0 && Array.isArray(X[0])) {
    if (X[0].length !== m) throw new ValidationError(
      `compile.predict: X has ${X[0].length} features, expected ${m}`);
    const out = new Float64Array(X.length * m);
    for (let i = 0; i < X.length; i++) {
      for (let j = 0; j < m; j++) out[i * m + j] = X[i][j];
    }
    return out;
  }
  throw new ValidationError('compile.predict: unrecognized X shape');
}
