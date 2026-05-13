// CART decision trees — DecisionTreeClassifier + DecisionTreeRegressor.
//
// Sklearn-compatible (`sklearn.tree.DecisionTreeClassifier` /
// `DecisionTreeRegressor`). Exhaustive split search; Gini for
// classification, squared-error for regression. Numeric features only in
// v0.1 (categorical splits land with the arborist port for v0.2).
//
// Storage: parallel arrays (children_left, children_right, feature,
// threshold, impurity, n_node_samples, value) — directly mimic-io-
// serializable, sklearn-shape, ready for AIR `compileTree` (SPEC §6.5)
// in v0.2.
//
// Performance: per @gcu/line discipline (SPEC §6.4). Pre-sorted feature
// columns once at fit-time, active-sample mask filter per node, tight
// scalar accumulator inner loop. Re-sort-per-node would be ~6× slower at
// realistic sizes. Hot path uses Float64Array and Int32Array exclusively.
//
// Hyperparameters supported:
//   - criterion       'gini'           (classifier) / 'squared_error' (regressor)
//   - splitter        'best' (default — exhaustive)
//                   | 'random' (one random threshold per feature; for ExtraTrees)
//   - max_depth       int | null       (no limit when null)
//   - min_samples_split int             default 2
//   - min_samples_leaf  int             default 1
//   - max_features    null|int|'sqrt'|'log2'  (random feature subsampling per node)
//   - random_state    int|null
//
// Hyperparameters still deferred:
//   - class_weight, min_weight_fraction_leaf, max_leaf_nodes,
//     min_impurity_decrease, ccp_alpha, monotonic_cst.

import { BaseEstimator, ClassifierMixin, RegressorMixin } from './base.js';
import { asMatrix, asVector, checkNFeatures, captureFeatureNames, ValidationError } from './util/checks.js';
import { mulberry32 } from './util/random.js';
import { learnRegistry } from './serialize.js';

const MODULE_ID_TREE = '@gcu/learn.tree';

// ────────────────────────────────────────────────────────────────────
// DecisionTreeClassifier
// ────────────────────────────────────────────────────────────────────

export class DecisionTreeClassifier extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.criterion = params.criterion ?? 'gini';
    this.splitter = params.splitter ?? 'best';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_TREE;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data: Xd, shape } = X_info;
    const yv = asVector(y);
    if (yv.length !== shape[0]) {
      throw new ValidationError(
        `DecisionTreeClassifier.fit: y length ${yv.length} != n_samples ${shape[0]}`);
    }
    if (this.criterion !== 'gini') {
      throw new ValidationError(
        `DecisionTreeClassifier: criterion='${this.criterion}' not supported in v0.1 (use 'gini')`);
    }
    // Encode classes to dense ints 0..k-1.
    const { classes, encoded } = _encodeClasses(yv);
    this.classes_ = classes;
    this.n_classes_ = classes.length;
    this.n_features_in_ = shape[1];
    captureFeatureNames(this, X_info);

    const tree = _buildTree(Xd, encoded, shape[0], shape[1], this.n_classes_, {
      mode: 'classifier',
      splitter: this.splitter,
      max_depth: this.max_depth,
      min_samples_split: this.min_samples_split,
      min_samples_leaf: this.min_samples_leaf,
      max_features: _resolveMaxFeatures(this.max_features, shape[1]),
      random_state: this.random_state,
    });
    this.tree_ = tree;
    this.feature_importances_ = _featureImportances(tree, shape[1]);
    return this;
  }

  predict(X) {
    const { data: Xd, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const n = shape[0];
    const m = shape[1];
    const out = new Float64Array(n);
    const k = this.n_classes_;
    const value_stride = k;
    for (let i = 0; i < n; i++) {
      const leaf = _walkTree(this.tree_, Xd, i, m);
      // Argmax over the k class counts.
      const off = leaf * value_stride;
      let best = 0, bestN = -Infinity;
      for (let c = 0; c < k; c++) {
        if (this.tree_.value[off + c] > bestN) { best = c; bestN = this.tree_.value[off + c]; }
      }
      out[i] = this.classes_[best];
    }
    return out;
  }

  predict_proba(X) {
    const { data: Xd, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const n = shape[0];
    const m = shape[1];
    const k = this.n_classes_;
    const out = new Float64Array(n * k);
    const value_stride = k;
    for (let i = 0; i < n; i++) {
      const leaf = _walkTree(this.tree_, Xd, i, m);
      const off_v = leaf * value_stride;
      let total = 0;
      for (let c = 0; c < k; c++) total += this.tree_.value[off_v + c];
      const inv = total === 0 ? 0 : 1 / total;
      for (let c = 0; c < k; c++) out[i * k + c] = this.tree_.value[off_v + c] * inv;
    }
    out.shape = [n, k];
    return out;
  }
}

Object.assign(DecisionTreeClassifier.prototype, ClassifierMixin);
DecisionTreeClassifier._estimator_type = 'classifier';

// ────────────────────────────────────────────────────────────────────
// DecisionTreeRegressor
// ────────────────────────────────────────────────────────────────────

export class DecisionTreeRegressor extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.criterion = params.criterion ?? 'squared_error';
    this.splitter = params.splitter ?? 'best';
    this.max_depth = params.max_depth ?? null;
    this.min_samples_split = params.min_samples_split ?? 2;
    this.min_samples_leaf = params.min_samples_leaf ?? 1;
    this.max_features = params.max_features ?? null;
    this.random_state = params.random_state ?? null;
    this._module = MODULE_ID_TREE;
  }

  fit(X, y, _opts) {
    const X_info = asMatrix(X);
    const { data: Xd, shape } = X_info;
    const yv = asVector(y);
    if (yv.length !== shape[0]) {
      throw new ValidationError(
        `DecisionTreeRegressor.fit: y length ${yv.length} != n_samples ${shape[0]}`);
    }
    if (this.criterion !== 'squared_error') {
      throw new ValidationError(
        `DecisionTreeRegressor: criterion='${this.criterion}' not supported in v0.1 (use 'squared_error')`);
    }
    this.n_features_in_ = shape[1];
    captureFeatureNames(this, X_info);

    const tree = _buildTree(Xd, yv, shape[0], shape[1], 1, {
      mode: 'regressor',
      splitter: this.splitter,
      max_depth: this.max_depth,
      min_samples_split: this.min_samples_split,
      min_samples_leaf: this.min_samples_leaf,
      max_features: _resolveMaxFeatures(this.max_features, shape[1]),
      random_state: this.random_state,
    });
    this.tree_ = tree;
    this.feature_importances_ = _featureImportances(tree, shape[1]);
    return this;
  }

  predict(X) {
    const { data: Xd, shape } = asMatrix(X);
    checkNFeatures(this, shape, { name: 'X' });
    const n = shape[0];
    const m = shape[1];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const leaf = _walkTree(this.tree_, Xd, i, m);
      out[i] = this.tree_.value[leaf];
    }
    return out;
  }
}

Object.assign(DecisionTreeRegressor.prototype, RegressorMixin);
DecisionTreeRegressor._estimator_type = 'regressor';

// ────────────────────────────────────────────────────────────────────
// Tree construction
// ────────────────────────────────────────────────────────────────────

// Returns a plain object with parallel arrays. mimic-io's typed-array
// codec handles per-field serialization on dump/load.
//
//   children_left  Int32Array     -1 for leaves
//   children_right Int32Array     -1 for leaves
//   feature        Int32Array     -2 for leaves (sentinel)
//   threshold      Float64Array   NaN for leaves
//   impurity       Float64Array
//   n_node_samples Int32Array
//   value          Float64Array   length = n_nodes * value_stride
//   value_stride   number          (n_classes for classifier, 1 for regressor)
//   n_outputs      number          1 (multi-output deferred)
//   max_depth      number          observed max depth (root = 0)
//   node_count     number          == children_left.length
function _buildTree(Xd, y, n_total, m, n_classes, opts) {
  const mode = opts.mode;
  const splitter = opts.splitter ?? 'best';
  const max_depth = opts.max_depth ?? Infinity;
  const min_samples_split = opts.min_samples_split;
  const min_samples_leaf = opts.min_samples_leaf;
  const max_features = opts.max_features;
  const rng = opts.random_state == null ? null : mulberry32(opts.random_state);
  const value_stride = mode === 'classifier' ? n_classes : 1;
  if (splitter !== 'best' && splitter !== 'random') {
    throw new ValidationError(
      `tree: splitter='${splitter}' must be 'best' | 'random'`);
  }

  // Pre-sort indices per feature once. sorted_idx[j] is an Int32Array of
  // length n_total, holding global sample indices ordered by X[:, j].
  const sorted_idx = new Array(m);
  for (let j = 0; j < m; j++) sorted_idx[j] = _argsortColumn(Xd, n_total, m, j);

  // Active mask scratch (reused across nodes; size n_total bytes).
  const mask = new Uint8Array(n_total);

  // Pre-extracted scratch for "active-in-feature-order" walks; reused per
  // node so we don't allocate inside the loop. Two parallel arrays:
  //   active_x: Float64Array of feature values (in sorted order)
  //   active_y: Float64Array of label / target values (in sorted order)
  const active_x = new Float64Array(n_total);
  const active_y = new Float64Array(n_total);

  // Parallel-array tree being built. Grow lazily as a JS array of node
  // descriptors; convert to typed arrays at the end.
  const nodes = [];
  // Worklist of pending nodes: { node_id, indices, depth }.
  // We push children right-after-left so leftmost gets popped first
  // (gives a sane, reproducible left-leaning traversal).
  const work = [];

  // Initialize root indices.
  const root_indices = new Int32Array(n_total);
  for (let i = 0; i < n_total; i++) root_indices[i] = i;
  nodes.push(_emptyNode());
  work.push({ node_id: 0, indices: root_indices, depth: 0 });

  while (work.length) {
    const { node_id, indices, depth } = work.pop();
    const n = indices.length;

    // Compute node statistics.
    const stats = _computeNodeStats(y, indices, n, n_classes, mode);
    nodes[node_id].n_samples = n;
    nodes[node_id].impurity = stats.impurity;
    nodes[node_id].value = stats.value;  // Float64Array of length value_stride

    // Stopping conditions → leaf.
    if (depth >= max_depth || n < min_samples_split || stats.impurity === 0) continue;

    // Build active mask for this node.
    for (let i = 0; i < n_total; i++) mask[i] = 0;
    for (let i = 0; i < n; i++) mask[indices[i]] = 1;

    // Choose features (random subsample if max_features < m).
    const features = _chooseFeatures(m, max_features, rng);

    let best_gain = 0;
    let best_feature = -1;
    let best_threshold = NaN;
    let best_l_impurity = 0;
    let best_r_impurity = 0;
    let best_n_left = 0;

    for (const f of features) {
      // Walk sorted_idx[f], filter by mask, into active_x / active_y.
      const sx = sorted_idx[f];
      let len = 0;
      for (let p = 0; p < n_total; p++) {
        const i = sx[p];
        if (mask[i]) {
          active_x[len] = Xd[i * m + f];
          active_y[len] = y[i];
          len++;
        }
      }
      if (len < 2) continue;

      // splitter='random' (ExtraTrees-style): one random threshold per
      // feature, evaluate the resulting split. Way faster than 'best'
      // (no per-position sweep), produces higher-variance trees that
      // average out well in an ensemble.
      if (splitter === 'random') {
        const f_min = active_x[0];
        const f_max = active_x[len - 1];
        if (f_min === f_max) continue;
        const r = rng ?? Math.random;
        const threshold = f_min + r() * (f_max - f_min);
        // Locate split index k = number of samples with active_x <= threshold.
        let k_split = 0;
        while (k_split < len && active_x[k_split] <= threshold) k_split++;
        const n_left = k_split;
        const n_right = len - k_split;
        if (n_left < min_samples_leaf || n_right < min_samples_leaf) continue;
        let l_imp, r_imp;
        if (mode === 'classifier') {
          const left_counts = new Float64Array(n_classes);
          const right_counts = new Float64Array(n_classes);
          for (let i = 0; i < n_left; i++) left_counts[active_y[i] | 0]++;
          for (let i = n_left; i < len; i++) right_counts[active_y[i] | 0]++;
          let l_sumsq = 0, r_sumsq = 0;
          for (let c = 0; c < n_classes; c++) {
            l_sumsq += left_counts[c] * left_counts[c];
            r_sumsq += right_counts[c] * right_counts[c];
          }
          l_imp = 1 - l_sumsq / (n_left * n_left);
          r_imp = 1 - r_sumsq / (n_right * n_right);
        } else {
          let l_sum = 0, l_sq = 0, r_sum = 0, r_sq = 0;
          for (let i = 0; i < n_left; i++) { l_sum += active_y[i]; l_sq += active_y[i] * active_y[i]; }
          for (let i = n_left; i < len; i++) { r_sum += active_y[i]; r_sq += active_y[i] * active_y[i]; }
          const l_mean = l_sum / n_left, r_mean = r_sum / n_right;
          l_imp = Math.max(0, l_sq / n_left - l_mean * l_mean);
          r_imp = Math.max(0, r_sq / n_right - r_mean * r_mean);
        }
        const weighted = (n_left * l_imp + n_right * r_imp) / n;
        const gain = stats.impurity - weighted;
        if (gain > best_gain) {
          best_gain = gain;
          best_feature = f;
          best_threshold = threshold;
          best_l_impurity = l_imp;
          best_r_impurity = r_imp;
          best_n_left = n_left;
        }
        continue;  // skip the exhaustive sweep below
      }

      // Sweep candidate splits ('best' path). Compute impurity for
      // left/right after each transition between distinct feature values.
      if (mode === 'classifier') {
        const left_counts = new Float64Array(n_classes);
        const right_counts = new Float64Array(n_classes);
        // Initialize right_counts from stats.value (which is class counts).
        for (let c = 0; c < n_classes; c++) right_counts[c] = stats.value[c];
        let n_left = 0;
        let n_right = n;
        for (let k = 0; k < len - 1; k++) {
          const cls = active_y[k] | 0;
          left_counts[cls]++;
          right_counts[cls]--;
          n_left++;
          n_right--;
          if (active_x[k] === active_x[k + 1]) continue;
          if (n_left < min_samples_leaf || n_right < min_samples_leaf) continue;
          // Gini: 1 - Σ (count/total)²
          let l_sumsq = 0, r_sumsq = 0;
          for (let c = 0; c < n_classes; c++) {
            l_sumsq += left_counts[c] * left_counts[c];
            r_sumsq += right_counts[c] * right_counts[c];
          }
          const l_imp = 1 - l_sumsq / (n_left * n_left);
          const r_imp = 1 - r_sumsq / (n_right * n_right);
          const weighted = (n_left * l_imp + n_right * r_imp) / n;
          const gain = stats.impurity - weighted;
          if (gain > best_gain) {
            best_gain = gain;
            best_feature = f;
            best_threshold = (active_x[k] + active_x[k + 1]) / 2;
            best_l_impurity = l_imp;
            best_r_impurity = r_imp;
            best_n_left = n_left;
          }
        }
      } else {
        // squared_error: maintain left/right sum and sum_sq.
        let l_sum = 0, l_sq = 0, r_sum = 0, r_sq = 0;
        for (let k = 0; k < len; k++) { r_sum += active_y[k]; r_sq += active_y[k] * active_y[k]; }
        let n_left = 0;
        let n_right = n;
        for (let k = 0; k < len - 1; k++) {
          const v = active_y[k];
          l_sum += v; l_sq += v * v;
          r_sum -= v; r_sq -= v * v;
          n_left++; n_right--;
          if (active_x[k] === active_x[k + 1]) continue;
          if (n_left < min_samples_leaf || n_right < min_samples_leaf) continue;
          const l_mean = l_sum / n_left;
          const r_mean = r_sum / n_right;
          const l_imp = Math.max(0, l_sq / n_left - l_mean * l_mean);
          const r_imp = Math.max(0, r_sq / n_right - r_mean * r_mean);
          const weighted = (n_left * l_imp + n_right * r_imp) / n;
          const gain = stats.impurity - weighted;
          if (gain > best_gain) {
            best_gain = gain;
            best_feature = f;
            best_threshold = (active_x[k] + active_x[k + 1]) / 2;
            best_l_impurity = l_imp;
            best_r_impurity = r_imp;
            best_n_left = n_left;
          }
        }
      }
    }

    if (best_feature === -1) continue;  // no useful split → leaf

    // Partition indices into left / right.
    const left_indices = new Int32Array(best_n_left);
    const right_indices = new Int32Array(n - best_n_left);
    let li = 0, ri = 0;
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      if (Xd[idx * m + best_feature] <= best_threshold) left_indices[li++] = idx;
      else right_indices[ri++] = idx;
    }
    // Sanity (defensive — partition counts should match best_n_left).
    if (li !== best_n_left) {
      // Threshold rounding edge case — equal-valued samples on the boundary.
      // Use the actual partition.
      const truncated_left = left_indices.subarray(0, li);
      const truncated_right = right_indices.subarray(0, ri);
      const left_id = nodes.length; nodes.push(_emptyNode());
      const right_id = nodes.length; nodes.push(_emptyNode());
      nodes[node_id].feature = best_feature;
      nodes[node_id].threshold = best_threshold;
      nodes[node_id].left = left_id;
      nodes[node_id].right = right_id;
      work.push({ node_id: right_id, indices: Int32Array.from(truncated_right), depth: depth + 1 });
      work.push({ node_id: left_id, indices: Int32Array.from(truncated_left), depth: depth + 1 });
      continue;
    }

    const left_id = nodes.length; nodes.push(_emptyNode());
    const right_id = nodes.length; nodes.push(_emptyNode());
    nodes[node_id].feature = best_feature;
    nodes[node_id].threshold = best_threshold;
    nodes[node_id].left = left_id;
    nodes[node_id].right = right_id;
    work.push({ node_id: right_id, indices: right_indices, depth: depth + 1 });
    work.push({ node_id: left_id, indices: left_indices, depth: depth + 1 });
  }

  // Convert to parallel arrays.
  const node_count = nodes.length;
  const children_left = new Int32Array(node_count);
  const children_right = new Int32Array(node_count);
  const feature = new Int32Array(node_count);
  const threshold = new Float64Array(node_count);
  const impurity = new Float64Array(node_count);
  const n_node_samples = new Int32Array(node_count);
  const value = new Float64Array(node_count * value_stride);
  let observed_max_depth = 0;

  // Walk depth-first to record node depth (for max_depth observation).
  const depth_arr = new Int32Array(node_count);
  const stack = [{ id: 0, d: 0 }];
  while (stack.length) {
    const { id, d } = stack.pop();
    depth_arr[id] = d;
    if (d > observed_max_depth) observed_max_depth = d;
    if (nodes[id].left !== -1) stack.push({ id: nodes[id].left, d: d + 1 });
    if (nodes[id].right !== -1) stack.push({ id: nodes[id].right, d: d + 1 });
  }

  for (let id = 0; id < node_count; id++) {
    children_left[id] = nodes[id].left;
    children_right[id] = nodes[id].right;
    feature[id] = nodes[id].feature;
    threshold[id] = nodes[id].threshold;
    impurity[id] = nodes[id].impurity;
    n_node_samples[id] = nodes[id].n_samples;
    if (nodes[id].value) {
      const v = nodes[id].value;
      const off = id * value_stride;
      for (let s = 0; s < value_stride; s++) value[off + s] = v[s];
    }
  }

  return {
    children_left, children_right, feature, threshold,
    impurity, n_node_samples, value,
    value_stride, n_outputs: 1, n_classes,
    max_depth: observed_max_depth, node_count,
  };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _emptyNode() {
  return {
    left: -1, right: -1, feature: -2, threshold: NaN,
    impurity: 0, n_samples: 0, value: null,
  };
}

// argsort one column of a row-major X.
function _argsortColumn(Xd, n, m, j) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // Plain JS sort on Int32Array uses numeric compare with our function.
  const arr = Array.from(idx);
  arr.sort((a, b) => Xd[a * m + j] - Xd[b * m + j]);
  for (let i = 0; i < n; i++) idx[i] = arr[i];
  return idx;
}

// Compute (impurity, value) for a node given its sample indices.
//   classifier: value = Float64Array of class counts (length n_classes),
//               impurity = Gini of class proportions.
//   regressor:  value = Float64Array of length 1 (the mean),
//               impurity = MSE around the mean.
function _computeNodeStats(y, indices, n, n_classes, mode) {
  if (mode === 'classifier') {
    const counts = new Float64Array(n_classes);
    for (let i = 0; i < n; i++) counts[y[indices[i]] | 0]++;
    let sumsq = 0;
    for (let c = 0; c < n_classes; c++) sumsq += counts[c] * counts[c];
    const impurity = n === 0 ? 0 : 1 - sumsq / (n * n);
    return { impurity, value: counts };
  }
  // regressor
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const v = y[indices[i]];
    sum += v; sq += v * v;
  }
  const mean = n === 0 ? 0 : sum / n;
  const impurity = n === 0 ? 0 : Math.max(0, sq / n - mean * mean);
  const value = new Float64Array(1);
  value[0] = mean;
  return { impurity, value };
}

// Walk the tree from root for sample i. Returns the leaf node id.
function _walkTree(tree, Xd, i, m) {
  let node = 0;
  while (tree.children_left[node] !== -1) {
    const f = tree.feature[node];
    const t = tree.threshold[node];
    if (Xd[i * m + f] <= t) node = tree.children_left[node];
    else node = tree.children_right[node];
  }
  return node;
}

// Resolve max_features hyperparameter to an integer count.
function _resolveMaxFeatures(spec, m) {
  if (spec == null) return m;
  if (typeof spec === 'number') {
    if (Number.isInteger(spec)) return Math.max(1, Math.min(m, spec));
    // Float = fraction.
    return Math.max(1, Math.min(m, Math.floor(spec * m)));
  }
  if (spec === 'sqrt') return Math.max(1, Math.floor(Math.sqrt(m)));
  if (spec === 'log2') return Math.max(1, Math.floor(Math.log2(m)));
  if (spec === 'auto') return m;  // sklearn legacy alias
  throw new ValidationError(
    `tree: max_features must be null | int | float | 'sqrt' | 'log2'; got ${spec}`);
}

// Pick which feature indices to consider at a node. When max_features ==
// m, returns 0..m-1; otherwise samples without replacement using rng.
function _chooseFeatures(m, max_features, rng) {
  if (max_features >= m) {
    const out = new Int32Array(m);
    for (let j = 0; j < m; j++) out[j] = j;
    return out;
  }
  // Reservoir-sample max_features from 0..m-1.
  const r = rng ?? Math.random;
  const all = new Int32Array(m);
  for (let j = 0; j < m; j++) all[j] = j;
  // Fisher-Yates partial shuffle: pull max_features unique entries.
  for (let i = 0; i < max_features; i++) {
    const j = i + Math.floor(r() * (m - i));
    const t = all[i]; all[i] = all[j]; all[j] = t;
  }
  return all.subarray(0, max_features);
}

// Encode unique class labels to dense ints 0..k-1. Returns {classes, encoded}
// where classes is the sorted unique label array and encoded is a
// Float64Array of length n with the integer-encoded labels.
function _encodeClasses(yv) {
  const seen = new Map();  // raw → int
  const order = [];
  for (let i = 0; i < yv.length; i++) {
    const v = yv[i];
    if (!seen.has(v)) { seen.set(v, true); order.push(v); }
  }
  // Sort to get deterministic class order (sklearn convention).
  order.sort((a, b) => a - b);
  const idx = new Map();
  for (let c = 0; c < order.length; c++) idx.set(order[c], c);
  const encoded = new Float64Array(yv.length);
  for (let i = 0; i < yv.length; i++) encoded[i] = idx.get(yv[i]);
  return { classes: Float64Array.from(order), encoded };
}

// Gain-weighted feature importance, normalized to sum to 1.
// At each internal node: importance += n_node_samples * impurity -
//   left_n * left_imp - right_n * right_imp, attributed to feature[node].
function _featureImportances(tree, m) {
  const imp = new Float64Array(m);
  const cl = tree.children_left;
  const cr = tree.children_right;
  for (let i = 0; i < tree.node_count; i++) {
    if (cl[i] === -1) continue;
    const f = tree.feature[i];
    const ns = tree.n_node_samples[i];
    const lns = tree.n_node_samples[cl[i]];
    const rns = tree.n_node_samples[cr[i]];
    imp[f] += ns * tree.impurity[i]
            - lns * tree.impurity[cl[i]]
            - rns * tree.impurity[cr[i]];
  }
  let total = 0;
  for (let j = 0; j < m; j++) total += imp[j];
  if (total > 0) for (let j = 0; j < m; j++) imp[j] /= total;
  return imp;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('DecisionTreeClassifier', DecisionTreeClassifier, { module: MODULE_ID_TREE });
learnRegistry.register('DecisionTreeRegressor', DecisionTreeRegressor, { module: MODULE_ID_TREE });
