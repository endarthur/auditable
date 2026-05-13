// Pipeline — sequential composition of transformers ending in any
// estimator (transformer or predictor).
//
// Sklearn-compatible (`sklearn.pipeline.Pipeline`). Same constructor
// shape (list of `[name, estimator]` tuples), same fit/transform/predict
// routing, same `set_params({'step__param': value})` dispatch (handled
// by BaseEstimator's dotted-name machinery — Pipeline doesn't need to
// override).
//
// Serialization: Pipeline opts in to a custom mimic-io codec via
// `_toMimicIo` / `_fromMimicIo` hooks (recognized by learn's dump/load
// wrappers in serialize.js). Each child estimator is dumped as a nested
// mimic-io v2 block within the params.steps array; reload reconstructs
// the chain by loading each child individually. Without this hook the
// default mimic-io walker would lose the children's class identity.

import { BaseEstimator } from './base.js';
// Note: alias-renamed imports (`as _foo`) get dropped by the concat
// build, so we use the unrenamed names. They resolve to serialize.js's
// dump/load in both ESM dev and the bundled build.
import { dump, load, learnRegistry } from './serialize.js';
import { asMatrix, ValidationError,
         detectTable, tableColumns, tableNumRows, tableColumn } from './util/checks.js';

const MODULE_ID_PIPELINE = '@gcu/learn.pipeline';
const MODULE_ID_COMPOSE = '@gcu/learn.compose';

// ────────────────────────────────────────────────────────────────────
// Pipeline
// ────────────────────────────────────────────────────────────────────

export class Pipeline extends BaseEstimator {
  /**
   * @param {object} params
   * @param {Array<[string, object]>} params.steps — ordered chain of
   *   (name, estimator) pairs. Last step may be a predictor (has
   *   .predict) or a transformer (has .transform); earlier steps must
   *   all be transformers (have both .fit and .transform).
   */
  constructor(params = {}) {
    super();
    this.steps = params.steps ?? [];
    this._module = MODULE_ID_PIPELINE;
  }

  /** Lookup map { name → estimator } over the current steps array. */
  get named_steps() {
    const out = {};
    for (const [name, est] of this.steps) out[name] = est;
    return out;
  }

  /**
   * Pipeline.get_params(deep=true) returns the sklearn shape: `steps`
   * itself, each step under its name, and `<name>__<param>` for each
   * nested hyperparameter. Custom override because BaseEstimator's
   * convention-based scan only sees `steps` (the array) and doesn't
   * walk into it.
   */
  get_params(deep = true) {
    const out = { steps: this.steps };
    if (!deep) return out;
    for (const [name, est] of this.steps) {
      out[name] = est;
      if (typeof est?.get_params === 'function') {
        const sub = est.get_params(true);
        for (const k of Object.keys(sub)) out[`${name}__${k}`] = sub[k];
      }
    }
    return out;
  }

  /**
   * set_params accepts:
   *   - 'steps': replace the entire chain
   *   - '<step_name>': replace a single step's estimator instance
   *   - '<step_name>__<param>': dotted-name dispatch into a nested step
   */
  set_params(params) {
    if (params == null) return this;
    const stepNames = new Set(this.steps.map(([n]) => n));
    const direct = {};
    const byStep = {};
    for (const key of Object.keys(params)) {
      const idx = key.indexOf('__');
      if (idx === -1) {
        if (key === 'steps') direct.steps = params[key];
        else if (stepNames.has(key)) direct[key] = params[key];
        else throw new Error(
          `Invalid parameter '${key}' for Pipeline. Valid: ` +
          `steps, ${[...stepNames].join(', ')}.`);
      } else {
        const root = key.slice(0, idx);
        const sub = key.slice(idx + 2);
        if (!stepNames.has(root)) throw new Error(
          `Invalid parameter '${root}' for Pipeline (no such step). ` +
          `Valid steps: ${[...stepNames].join(', ')}.`);
        if (!byStep[root]) byStep[root] = {};
        byStep[root][sub] = params[key];
      }
    }
    if ('steps' in direct) this.steps = direct.steps;
    // Replace whole steps when bare-named.
    for (const name of Object.keys(direct)) {
      if (name === 'steps') continue;
      const i = this.steps.findIndex(([n]) => n === name);
      if (i !== -1) this.steps[i] = [name, direct[name]];
    }
    // Dispatch nested params.
    for (const name of Object.keys(byStep)) {
      const i = this.steps.findIndex(([n]) => n === name);
      const step = this.steps[i][1];
      if (typeof step.set_params !== 'function') {
        throw new Error(
          `Step '${name}' on Pipeline is not an estimator (no set_params)`);
      }
      step.set_params(byStep[name]);
    }
    return this;
  }

  fit(X, y, opts) {
    _validateSteps(this.steps);
    let Xt = X;
    for (let i = 0; i < this.steps.length - 1; i++) {
      const est = this.steps[i][1];
      Xt = est.fit(Xt, y, opts).transform(Xt);
    }
    // Last step: fit only (no transform expected for predictors).
    const last = this.steps[this.steps.length - 1][1];
    last.fit(Xt, y, opts);
    // Mark fitted with at least one trailing-underscore attr.
    this.n_features_in_ = _firstFeatureCount(X);
    // Inherit feature_names_in_ from the raw X first (covers Tables /
    // DataFrames / plain named-column objects). Fall back to the first
    // step's feature_names_in_ if the first step captured them but X
    // itself didn't carry names directly. sklearn convention:
    // pipeline-level feature_names_in_ mirrors the input column names,
    // not the post-transform ones.
    const x_names = _firstFeatureNames(X);
    if (x_names) {
      this.feature_names_in_ = x_names;
    } else {
      const first = this.steps[0][1];
      if (first?.feature_names_in_) {
        this.feature_names_in_ = first.feature_names_in_.slice();
      }
    }
    return this;
  }

  transform(X) {
    _validateSteps(this.steps);
    let Xt = X;
    for (const [, est] of this.steps) {
      if (typeof est.transform !== 'function') {
        throw new ValidationError(
          `Pipeline.transform: step '${_nameOf(est)}' has no .transform; ` +
          `final step must be a transformer for transform() to apply.`);
      }
      Xt = est.transform(Xt);
    }
    return Xt;
  }

  predict(X) {
    _validateSteps(this.steps);
    let Xt = X;
    for (let i = 0; i < this.steps.length - 1; i++) {
      Xt = this.steps[i][1].transform(Xt);
    }
    const last = this.steps[this.steps.length - 1][1];
    if (typeof last.predict !== 'function') {
      throw new ValidationError(
        `Pipeline.predict: final step '${this.steps.at(-1)[0]}' has no .predict`);
    }
    return last.predict(Xt);
  }

  predict_proba(X) {
    let Xt = X;
    for (let i = 0; i < this.steps.length - 1; i++) {
      Xt = this.steps[i][1].transform(Xt);
    }
    const last = this.steps[this.steps.length - 1][1];
    if (typeof last.predict_proba !== 'function') {
      throw new ValidationError(
        `Pipeline.predict_proba: final step '${this.steps.at(-1)[0]}' has no .predict_proba`);
    }
    return last.predict_proba(Xt);
  }

  score(X, y, opts) {
    let Xt = X;
    for (let i = 0; i < this.steps.length - 1; i++) {
      Xt = this.steps[i][1].transform(Xt);
    }
    const last = this.steps[this.steps.length - 1][1];
    if (typeof last.score !== 'function') {
      throw new ValidationError(
        `Pipeline.score: final step '${this.steps.at(-1)[0]}' has no .score`);
    }
    return last.score(Xt, y, opts);
  }

  __sklearn_tags__() {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    // Output-shape tags (estimator_type, requires_y, multioutput) come
    // from the LAST step — that's the predictor/transformer that
    // determines what fit/predict produces.
    // Input-shape tags (allow_nan, requires_positive_X) come from the
    // FIRST step — that's what receives the raw X. A Pipeline starting
    // with SimpleImputer should report allow_nan=true even if its
    // final classifier doesn't accept NaN itself.
    if (!this.steps || this.steps.length === 0) return base;
    const last = this.steps[this.steps.length - 1][1];
    const first = this.steps[0][1];
    const lastTags = typeof last?.__sklearn_tags__ === 'function'
      ? last.__sklearn_tags__() : {};
    const firstTags = typeof first?.__sklearn_tags__ === 'function'
      ? first.__sklearn_tags__() : {};
    return {
      ...base,
      ...lastTags,
      // Input-gated tags override.
      allow_nan: firstTags.allow_nan ?? lastTags.allow_nan ?? base.allow_nan,
      requires_positive_X: firstTags.requires_positive_X
        ?? lastTags.requires_positive_X ?? base.requires_positive_X,
    };
  }

  /**
   * Recursive clone — produces a fresh Pipeline with cloned children.
   * Required because the default base.clone() relies on get_params(false)
   * round-trip through the constructor, but Pipeline's `steps` contains
   * estimator instances that themselves need recursive cloning.
   */
  __sklearn_clone__() {
    const cloned = this.steps.map(([name, est]) => {
      // Each child estimator gets cloned via its own __sklearn_clone__
      // hook or the standard get_params/constructor path.
      const Ctor = est.constructor;
      const params = typeof est.get_params === 'function'
        ? est.get_params(false) : {};
      const childClone = typeof est.__sklearn_clone__ === 'function'
        ? est.__sklearn_clone__()
        : new Ctor(params);
      return [name, childClone];
    });
    return new Pipeline({ steps: cloned });
  }

  /**
   * Custom mimic-io encoder: dump each child estimator as a nested v2
   * block inside params.steps. Without this hook, mimic-io's default
   * walker would lose the children's class identity.
   */
  _toMimicIo() {
    const stepsEncoded = this.steps.map(([name, est]) => [name, dump(est)]);
    const out = {
      format: 'mimic-io',
      version: 2,
      class: 'Pipeline',
      module: this._module,
      params: { steps: stepsEncoded },
    };
    // Pipeline's own fitted state is n_features_in_ + feature_names_in_;
    // everything else load-bearing lives in the encoded children.
    if (this.n_features_in_ !== undefined) {
      out.fitted = { n_features_in_: this.n_features_in_ };
      if (this.feature_names_in_) {
        out.fitted.feature_names_in_ = this.feature_names_in_.slice();
      }
    } else {
      out.fitted = null;
    }
    return out;
  }

  /**
   * Custom mimic-io decoder: load each child estimator from its v2
   * block. Counterpart to _toMimicIo above.
   */
  static _fromMimicIo(json, opts = {}) {
    const stepsRaw = json.params?.steps ?? [];
    const steps = stepsRaw.map(([name, childBlock]) => {
      // Each childBlock is itself a mimic-io v2 dict — load it.
      const child = load(childBlock, opts);
      return [name, child];
    });
    const pipe = new Pipeline({ steps });
    if (json.fitted?.n_features_in_ !== undefined) {
      pipe.n_features_in_ = json.fitted.n_features_in_;
    }
    if (json.fitted?.feature_names_in_) {
      pipe.feature_names_in_ = json.fitted.feature_names_in_.slice();
    }
    return pipe;
  }
}

Pipeline._estimator_type = null;  // resolved at runtime via final step

// ────────────────────────────────────────────────────────────────────
// make_pipeline
// ────────────────────────────────────────────────────────────────────

/**
 * Convenience constructor: build a Pipeline from a sequence of
 * estimator instances, naming each step from its class name (lowercased,
 * with collision suffixes when the same class appears twice).
 *
 *   make_pipeline(new StandardScaler(), new DecisionTreeClassifier())
 *   // → Pipeline([['standardscaler', sc], ['decisiontreeclassifier', tree]])
 */
export function make_pipeline(...estimators) {
  const counts = {};
  const steps = estimators.map(est => {
    const base = (est.constructor?.name ?? 'step').toLowerCase();
    counts[base] = (counts[base] ?? 0);
    const name = counts[base] === 0 ? base : `${base}-${counts[base]}`;
    counts[base]++;
    return [name, est];
  });
  return new Pipeline({ steps });
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function _validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ValidationError(`Pipeline: steps must be a non-empty array of [name, estimator] tuples`);
  }
  for (let i = 0; i < steps.length; i++) {
    const tup = steps[i];
    if (!Array.isArray(tup) || tup.length !== 2 || typeof tup[0] !== 'string') {
      throw new ValidationError(
        `Pipeline: step ${i} must be a [string, estimator] tuple; got ${JSON.stringify(tup)}`);
    }
    const est = tup[1];
    if (est == null || typeof est !== 'object') {
      throw new ValidationError(`Pipeline: step '${tup[0]}' is not an estimator`);
    }
    if (i < steps.length - 1 && typeof est.transform !== 'function') {
      throw new ValidationError(
        `Pipeline: intermediate step '${tup[0]}' has no .transform; ` +
        `every step except the last must be a transformer.`);
    }
  }
}

function _nameOf(est) {
  return est?.constructor?.name ?? '<unknown>';
}

function _firstFeatureCount(X) {
  if (X == null) return undefined;
  if (Array.isArray(X.shape) && X.shape.length === 2) return X.shape[1];
  if (X.data instanceof Float64Array && Array.isArray(X.shape)) return X.shape[1];
  if (Array.isArray(X) && X.length > 0 && Array.isArray(X[0])) return X[0].length;
  // sadpan Table / DataFrame / plain named-column object.
  const kind = detectTable(X);
  if (kind) return tableColumns(X, kind).length;
  return undefined;
}

// Same trio for "first column names" — used by Pipeline to inherit
// feature_names_in_ from the input when the first step doesn't set it.
function _firstFeatureNames(X) {
  if (X == null) return null;
  if (X.feature_names) return X.feature_names.slice();
  if (X instanceof Float64Array && X.feature_names) return X.feature_names.slice();
  const kind = detectTable(X);
  if (kind) return tableColumns(X, kind).slice();
  return null;
}

// ────────────────────────────────────────────────────────────────────
// ColumnTransformer
// ────────────────────────────────────────────────────────────────────

/**
 * Apply different transformers to different columns of X, then
 * horizontally stack the results.
 *
 * Constructor:
 *   new ColumnTransformer({
 *     transformers: [
 *       ['numeric', new StandardScaler(), [0, 1, 2]],
 *       ['categorical', new OneHotEncoder(), [3, 4]],
 *     ],
 *     remainder: 'drop' | 'passthrough',     // default 'drop'
 *   })
 *
 * Column selectors are integer arrays of column indices in v0.1
 * (string column names defer to sadpan integration). Output is the
 * concatenation of each transformer's transform(X[:, cols]) in
 * declaration order, optionally followed by the remainder columns.
 *
 * fit_transform routes through each step's fit_transform when defined
 * (avoids redundant double-fit cost).
 *
 * inverse_transform is intentionally not provided — it's not unique in
 * general (which dropped/added/reshaped columns came from where?). For
 * the special case where every transformer preserves column count and
 * order, inverse_transform per-step is straightforward and the user
 * can roll their own.
 */
export class ColumnTransformer extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.transformers = params.transformers ?? [];
    this.remainder = params.remainder ?? 'drop';
    this._module = MODULE_ID_COMPOSE;
  }

  get named_transformers_() {
    const out = {};
    for (const [name, t] of this.transformers) out[name] = t;
    return out;
  }

  fit(X, y, opts) {
    _validateColumnTransformers(this.transformers);
    const shape = _shapeOf(X);
    this.n_features_in_ = shape[1];
    const x_names = _firstFeatureNames(X);
    if (x_names) this.feature_names_in_ = x_names;
    const used = new Set();
    for (const [name, t, cols] of this.transformers) {
      _validateCols(cols, shape[1], name);
      for (const c of cols) used.add(c);
      t.fit(_gatherCols(X, shape, cols), y, opts);
    }
    if (this.remainder === 'passthrough') {
      this._remainder_cols_ = [];
      for (let j = 0; j < shape[1]; j++) if (!used.has(j)) this._remainder_cols_.push(j);
    } else if (this.remainder !== 'drop') {
      throw new ValidationError(
        `ColumnTransformer: remainder='${this.remainder}' must be 'drop' | 'passthrough'`);
    }
    return this;
  }

  transform(X) {
    if (this.n_features_in_ === undefined) {
      throw new ValidationError('ColumnTransformer: not fitted');
    }
    const shape = _shapeOf(X);
    const blocks = [];
    for (const [, t, cols] of this.transformers) {
      blocks.push(t.transform(_gatherCols(X, shape, cols)));
    }
    if (this.remainder === 'passthrough' && this._remainder_cols_?.length) {
      blocks.push(_gatherColsNumeric(X, shape, this._remainder_cols_));
    }
    return _hstack(blocks, shape[0]);
  }

  fit_transform(X, y, opts) {
    _validateColumnTransformers(this.transformers);
    const shape = _shapeOf(X);
    this.n_features_in_ = shape[1];
    const x_names = _firstFeatureNames(X);
    if (x_names) this.feature_names_in_ = x_names;
    const used = new Set();
    const blocks = [];
    for (const [name, t, cols] of this.transformers) {
      _validateCols(cols, shape[1], name);
      for (const c of cols) used.add(c);
      const slice = _gatherCols(X, shape, cols);
      const out = typeof t.fit_transform === 'function'
        ? t.fit_transform(slice, y, opts)
        : t.fit(slice, y, opts).transform(slice);
      blocks.push(out);
    }
    if (this.remainder === 'passthrough') {
      this._remainder_cols_ = [];
      for (let j = 0; j < shape[1]; j++) if (!used.has(j)) this._remainder_cols_.push(j);
      if (this._remainder_cols_.length) {
        blocks.push(_gatherColsNumeric(X, shape, this._remainder_cols_));
      }
    } else if (this.remainder !== 'drop') {
      throw new ValidationError(
        `ColumnTransformer: remainder='${this.remainder}' must be 'drop' | 'passthrough'`);
    }
    return _hstack(blocks, shape[0]);
  }

  __sklearn_clone__() {
    const cloned = this.transformers.map(([name, t, cols]) => {
      const Ctor = t.constructor;
      const params = typeof t.get_params === 'function' ? t.get_params(false) : {};
      const tc = typeof t.__sklearn_clone__ === 'function'
        ? t.__sklearn_clone__()
        : new Ctor(params);
      return [name, tc, [...cols]];
    });
    return new ColumnTransformer({ transformers: cloned, remainder: this.remainder });
  }

  _toMimicIo() {
    const transformersEncoded = this.transformers.map(
      ([name, t, cols]) => [name, dump(t), Array.from(cols)],
    );
    const out = {
      format: 'mimic-io',
      version: 2,
      class: 'ColumnTransformer',
      module: this._module,
      params: {
        transformers: transformersEncoded,
        remainder: this.remainder,
      },
    };
    if (this.n_features_in_ !== undefined) {
      out.fitted = {
        n_features_in_: this.n_features_in_,
        _remainder_cols_: this._remainder_cols_ ?? null,
      };
      if (this.feature_names_in_) {
        out.fitted.feature_names_in_ = this.feature_names_in_.slice();
      }
    } else {
      out.fitted = null;
    }
    return out;
  }

  static _fromMimicIo(json, opts = {}) {
    const transformers = (json.params?.transformers ?? []).map(
      ([name, childBlock, cols]) => [name, load(childBlock, opts), [...cols]],
    );
    const ct = new ColumnTransformer({
      transformers,
      remainder: json.params?.remainder ?? 'drop',
    });
    if (json.fitted?.n_features_in_ !== undefined) {
      ct.n_features_in_ = json.fitted.n_features_in_;
      if (json.fitted._remainder_cols_) ct._remainder_cols_ = json.fitted._remainder_cols_;
    }
    if (json.fitted?.feature_names_in_) {
      ct.feature_names_in_ = json.fitted.feature_names_in_.slice();
    }
    return ct;
  }
}

ColumnTransformer._estimator_type = 'transformer';
Object.assign(ColumnTransformer.prototype, {
  __sklearn_tags__: function () {
    const base = BaseEstimator.prototype.__sklearn_tags__.call(this);
    return { ...base, estimator_type: 'transformer' };
  },
});

/**
 * Convenience constructor: build a ColumnTransformer from
 * `(transformer, columns)` pairs, naming each step from class name.
 *
 *   make_column_transformer(
 *     [new StandardScaler(), [0, 1, 2]],
 *     [new OneHotEncoder(), [3, 4]],
 *   )
 */
export function make_column_transformer(...pairs) {
  const counts = {};
  const transformers = pairs.map(([t, cols]) => {
    if (!Array.isArray(cols)) {
      throw new ValidationError(
        `make_column_transformer: each pair must be [transformer, columns]; got ${typeof cols}`);
    }
    const base = (t.constructor?.name ?? 'step').toLowerCase();
    counts[base] = (counts[base] ?? 0);
    const name = counts[base] === 0 ? base : `${base}-${counts[base]}`;
    counts[base]++;
    return [name, t, cols];
  });
  return new ColumnTransformer({ transformers });
}

// ────────────────────────────────────────────────────────────────────
// ColumnTransformer helpers
// ────────────────────────────────────────────────────────────────────

function _validateColumnTransformers(transformers) {
  if (!Array.isArray(transformers)) {
    throw new ValidationError(
      `ColumnTransformer: transformers must be an array of [name, est, cols] tuples`);
  }
  for (let i = 0; i < transformers.length; i++) {
    const tup = transformers[i];
    if (!Array.isArray(tup) || tup.length !== 3 || typeof tup[0] !== 'string') {
      throw new ValidationError(
        `ColumnTransformer: transformer ${i} must be [name, est, cols]; got ${JSON.stringify(tup)}`);
    }
  }
}

function _validateCols(cols, m, name) {
  if (!Array.isArray(cols) && !(ArrayBuffer.isView(cols) && !(cols instanceof DataView))) {
    throw new ValidationError(
      `ColumnTransformer: '${name}' columns must be an array of int indices`);
  }
  for (const c of cols) {
    if (!Number.isInteger(c) || c < 0 || c >= m) {
      throw new ValidationError(
        `ColumnTransformer: '${name}' column index ${c} out of range [0, ${m})`);
    }
  }
}

// Determine [n, m] for any supported X shape without coercing to numeric
// (so mixed-type inputs survive ColumnTransformer's column routing).
function _shapeOf(X) {
  if (X == null) throw new ValidationError('ColumnTransformer: X is null');
  if (X.data instanceof Float64Array && Array.isArray(X.shape) && X.shape.length === 2) {
    return X.shape;
  }
  if (X instanceof Float64Array && Array.isArray(X.shape) && X.shape.length === 2) {
    return X.shape;
  }
  if (Array.isArray(X) && X.length > 0 && Array.isArray(X[0])) {
    return [X.length, X[0].length];
  }
  // sadpan Table / DataFrame / plain named-column object.
  const kind = detectTable(X);
  if (kind) return [tableNumRows(X, kind), tableColumns(X, kind).length];
  throw new ValidationError(
    `ColumnTransformer: X must be a 2D nested array, Float64Array with .shape, or a sadpan Table/DataFrame`);
}

// Slice columns. Preserves arbitrary value types when X is a 2D nested
// array (returns 2D nested array), uses the numeric fast path when X is
// a Float64Array (returns Float64Array.shape).
function _gatherCols(X, shape, cols) {
  const [n] = shape;
  const k = cols.length;
  if (Array.isArray(X) && Array.isArray(X[0])) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = new Array(k);
      for (let c = 0; c < k; c++) row[c] = X[i][cols[c]];
      out[i] = row;
    }
    return out;
  }
  // Sadpan tables: extract by column-name, preserving raw types.
  const kind = detectTable(X);
  if (kind) {
    const names = tableColumns(X, kind);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = new Array(k);
    for (let c = 0; c < k; c++) {
      const col = tableColumn(X, kind, names[cols[c]]);
      for (let i = 0; i < n; i++) out[i][c] = col[i];
    }
    return out;
  }
  return _gatherColsNumeric(X, shape, cols);
}

// Numeric column slicing (Float64Array output). Used for the
// remainder='passthrough' path. Accepts 2D nested arrays (coerces each
// value to number) or Float64Array.shape (direct gather).
function _gatherColsNumeric(X, shape, cols) {
  const [n, m] = shape;
  const k = cols.length;
  const out = new Float64Array(n * k);
  if (Array.isArray(X) && Array.isArray(X[0])) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) out[i * k + c] = +X[i][cols[c]];
    }
  } else if (detectTable(X)) {
    const kind = detectTable(X);
    const names = tableColumns(X, kind);
    for (let c = 0; c < k; c++) {
      const col = tableColumn(X, kind, names[cols[c]]);
      for (let i = 0; i < n; i++) out[i * k + c] = +col[i];
    }
  } else {
    const data = X.data ?? X;
    for (let i = 0; i < n; i++) {
      const off_in = i * m;
      const off_out = i * k;
      for (let c = 0; c < k; c++) out[off_out + c] = +data[off_in + cols[c]];
    }
  }
  out.shape = [n, k];
  return out;
}

function _hstack(blocks, n) {
  let total = 0;
  for (const b of blocks) {
    const w = b.shape ? b.shape[1] : (b.data?.shape?.[1] ?? 0);
    total += w;
  }
  const out = new Float64Array(n * total);
  let col_off = 0;
  for (const b of blocks) {
    const data = b.data ?? b;
    const w = b.shape ? b.shape[1] : 0;
    for (let i = 0; i < n; i++) {
      const off_in = i * w;
      const off_out = i * total + col_off;
      for (let c = 0; c < w; c++) out[off_out + c] = data[off_in + c];
    }
    col_off += w;
  }
  out.shape = [n, total];
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Self-registration
// ────────────────────────────────────────────────────────────────────

learnRegistry.register('Pipeline', Pipeline, { module: MODULE_ID_PIPELINE });
learnRegistry.register('ColumnTransformer', ColumnTransformer, { module: MODULE_ID_COMPOSE });
