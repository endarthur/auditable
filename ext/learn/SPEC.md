# @gcu/learn

**Machine learning in JS, sklearn-shaped.** Estimators, transformers, pipelines, model selection, metrics — pure JS + [@gcu/line](https://www.npmjs.com/package/@gcu/line) (BLAS) + [@gcu/scitra](https://www.npmjs.com/package/@gcu/scitra) (statistics) under the hood, no Python runtime.

The premise: every Python ML notebook starts with `from sklearn.X import Y`, the API is well-known, and the boundary surface (estimator contract, fit/predict/transform/score, pipelines, cross-validation) is well-shaped. We don't reinvent the contract; we reimplement it. A Python notebook that says `from sklearn.tree import DecisionTreeClassifier` rewrites to `from learn.tree import DecisionTreeClassifier` and keeps working.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.2 (459 tests, 20 files, ~355 KB bundle)      |
| Status     | Pre-1.0; shipped 2026-05                       |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | scikit-learn API; NumPy / SciPy stack          |

---

## Lineage

scikit-learn is the de facto standard ML library for Python and has been since ~2010. Its API has been refined for fifteen years by hundreds of contributors; the estimator contract (`fit(X, y)` → `predict(X)`, parameters in `__init__`, fitted state as `attribute_`) has become the lingua franca of tabular ML far beyond Python itself. Spark MLlib, ML.NET, scikit-learn-compatible JAX/PyTorch wrappers — they all adopt the same shape because it's what users expect.

`@gcu/learn` is a sklearn-shaped JavaScript reimplementation, not a wrapper around scikit-learn (no Pyodide, no FFI). Estimators are pure JS; matrix work delegates to [@gcu/line](https://www.npmjs.com/package/@gcu/line); statistical primitives delegate to [@gcu/scitra](https://www.npmjs.com/package/@gcu/scitra); persistence delegates to [@gcu/mimic-io](https://www.npmjs.com/package/@gcu/mimic-io).

The namespace is `learn` (not `sklearn`) because `learn` is the *kind* of thing; sklearn is the original. The semantics are sklearn's; the implementation is ours.

## Premise

Three commitments drive the design:

1. **API legibility over creativity.** Estimators expose the same hyperparameter names, defaults, and fitted attributes as scikit-learn. `s/sklearn/learn/` in import statements should "just work" for the supported subset. Deviations are documented (see §"What matches and what doesn't").
2. **Per-estimator implementation freedom.** The API is sklearn; the algorithm is whatever's appropriate for the JS runtime. Decision-tree training uses parallel arrays (cache-friendly). PCA uses [line](https://www.npmjs.com/package/@gcu/line)'s SVD. PLS uses NIPALS. GradientBoosting uses stagewise additive boosting with squared-error/log-loss. None of these are sklearn ports; they're reimplementations that match sklearn's *output* given matched random seeds.
3. **Geoscientific tilts where it matters.** Beyond sklearn-shape, learn adds the things mining/geology workflows reach for: `SpatialKFold` for spatial cross-validation, `BDLImputer` for below-detection-limit handling, compositional transforms (CLR / ILR / ALR), Aitchison-aware preprocessing. These don't exist in sklearn and won't ship there; they belong in learn.

## The estimator contract

Every estimator follows the sklearn protocol:

### Construction

```js
const est = new DecisionTreeClassifier({
  max_depth: 5,
  min_samples_split: 2,
  criterion: 'gini',
});
```

All parameters go in the constructor; no positional args. Parameter names + defaults match sklearn for every hyperparameter learn implements. Parameters are stored as `est.<name>` (no underscore prefix — these are the user's choices, not fitted state).

### Fitting

```js
est.fit(X, y);
```

Returns `est` (for chaining). After `fit`, the estimator carries **fitted attributes**, each suffixed with `_` (sklearn convention):

```js
est.tree_              // CART tree as parallel arrays
est.n_features_in_     // count of features seen during fit
est.classes_           // unique class labels (classifiers)
est.feature_importances_
```

`feature_names_in_` is populated automatically if `X` came from a sadpan Table / DataFrame / `{col: array}` mapping; `n_features_in_` is always populated.

### Prediction / transformation / scoring

```js
const yPred = est.predict(X);           // classifier / regressor
const proba = est.predict_proba(X);      // classifier (when available)
const Z = transformer.transform(X);      // transformers
const Z = transformer.fit_transform(X);  // shortcut
const s = est.score(X, y);               // mean accuracy (clf) or R² (reg)
```

`predict_proba`, `decision_function`, and `predict_log_proba` are available on classifiers that natively expose them (not all do — RandomForest does; SVC currently doesn't).

### Cloning + parameter inspection

```js
clone(est);                  // unfitted copy with same params
est.get_params();            // {param: value, …}
est.set_params({ max_depth: 10 });   // dotted keys work for nested
```

`clone` produces an unfitted instance with the same hyperparameters — the operation pipelines + grid search rely on. `set_params` accepts dotted keys (`{'tree__max_depth': 10}`) for nested estimators.

### Fitted-state introspection

```js
import { check_is_fitted } from '@gcu/learn';

check_is_fitted(est);   // throws NotFittedError if not fit-completed
check_is_fitted(est, ['tree_', 'classes_']);   // explicit attribute list
```

Used inside `predict` / `transform` / `score` to short-circuit on unfitted estimators with a clear error.

### Conformance check

```js
import { check_estimator } from '@gcu/learn/check_estimator';

check_estimator(new DecisionTreeClassifier());
// throws if the estimator violates the contract
```

A test harness that exercises ~30 invariants: parameter passthrough on `fit`, fitted-attribute presence, `predict` shape, `clone` behavior, `set_params`/`get_params` round-trip, serialization round-trip via mimic-io.

## Module surface

Mirrors sklearn's namespace:

| Module | Estimators / functions |
|---|---|
| `learn.tree` | DecisionTreeClassifier, DecisionTreeRegressor (CART; Gini / squared-error) |
| `learn.ensemble` | RandomForest{Classifier,Regressor}, ExtraTrees{Classifier,Regressor}, Bagging{Classifier,Regressor}, GradientBoosting{Classifier,Regressor} |
| `learn.linear_model` | LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression |
| `learn.neighbors` | KNeighborsClassifier, KNeighborsRegressor (backed by scitra's KDTree) |
| `learn.cluster` | KMeans, AgglomerativeClustering (Ward / single / complete / average), DBSCAN |
| `learn.mixture` | GaussianMixture |
| `learn.decomposition` | PCA, TruncatedSVD, NMF |
| `learn.cross_decomposition` | PLSRegression |
| `learn.impute` | SimpleImputer, KNNImputer, BDLImputer |
| `learn.preprocessing` | StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler, LabelEncoder, OrdinalEncoder, OneHotEncoder, KBinsDiscretizer, PowerTransformer |
| `learn.compositional` | CLR, ILR, ALR (Aitchison log-ratio transforms) |
| `learn.pipeline` | Pipeline, make_pipeline, ColumnTransformer, make_column_transformer |
| `learn.model_selection` | train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold, cross_val_score, cross_validate |
| `learn.metrics` | accuracy_score, precision/recall/f1, confusion_matrix, classification_report, cohen_kappa, MCC, R²/MSE/MAE/MAPE/EV |

Per-module sub-path imports work: `@gcu/learn/tree`, `@gcu/learn/linear_model`, etc.

## What matches sklearn and what doesn't

### Matches

- **Parameter names + defaults** for every hyperparameter learn implements.
- **Fitted attributes + trailing-underscore convention** (`mean_`, `scale_`, `coef_`, `tree_`, …).
- **Method signatures** — `fit(X, y)`, `predict(X)`, `transform(X)`, `score(X, y)`, `predict_proba`, `decision_function`.
- **Estimator types** — Classifier / Regressor / Transformer naming.
- **Pipeline conventions** — list-of-tuples `[('step', est), …]`, named step dot-access, `set_params({'step__param': value})`.
- **Cross-validation iterators** — yielding `[trainIdx, testIdx]` pairs.
- **Random-state handling** — every estimator accepts `random_state` (number or seedable RNG).

### Deliberate divergences

- **No NumPy.** Inputs are JS arrays, typed arrays, sadpan Tables, or `{col: array}` mappings. Sklearn's "anything array-like" is "anything that has `.length` or `.shape`."
- **No joblib.** Persistence is via mimic-io (a single-file JSON convention with a custom codec for nested estimators). The wire format is sklearn-aware but not sklearn-compatible — a pickled scikit-learn estimator won't load in learn, and vice versa.
- **No multiprocessing.** `n_jobs > 1` is a no-op for now (the ensemble fits are single-threaded). Worker-pool parallelism is on the roadmap.
- **No SVMs (yet).** `learn.svm` is empty. Kernel methods are a known gap; not in v0.2.
- **Adder shape preserved.** When called from an adder (Python) cell, the API stays Pythonic — `from learn.tree import DecisionTreeClassifier`, snake_case, `est.fit(X, y)`. The adder bridge lives in `learn/adder.js`.

## Serialization (mimic-io)

Every fitted estimator round-trips through `@gcu/mimic-io`:

```js
import { dump, load } from '@gcu/mimic-io';

const blob = dump(fittedEst);          // → string (JSON-shaped)
const restored = load(blob);           // → fitted estimator
```

Each estimator's `_codec` field declares the JSON shape: hyperparameters + fitted-attribute names + nested-estimator pointers. mimic-io walks the codec at dump time, recursively serializes children (for Pipelines, ColumnTransformers, ensemble base estimators), and reconstructs the type tree at load time.

Format is intentionally human-readable JSON, not protobuf. A fitted DecisionTree round-trips through `JSON.parse(JSON.stringify(dump(t)))` and remains predictable. Trees are stored as parallel arrays (`feature_`, `threshold_`, `value_`, `children_left_`, `children_right_`); ensembles serialize as `{base_estimator_, estimators_: [...] }`.

## Tree compilation

Decision trees and forests support an opt-in `.compile()` step that emits the predict path as inlined JS:

```js
const forest = new RandomForestClassifier({ n_estimators: 100, max_depth: 8 });
forest.fit(X_train, y_train);
forest.compile();                     // JIT-emit predict path
const y_pred = forest.predict(X_test);
```

The compiled predict is a nested ternary expression (one per tree) emitted as a JS string and instantiated via `new Function`. V8 inlines it aggressively; speedups range from ~1.2-1.4× on shallow forests to ~0.9× on very deep trees (where the function body exceeds V8's inlining heuristic).

Pragmatic choice: we emit the JS string directly rather than routing through AIR's lower-and-emit pipeline. The shape is simple enough (single expression, no control flow other than ternaries) that AIR's optimization passes wouldn't add value. The predict surface is small; the codegen is ~80 lines.

16 parity tests in `learn-compile.test.mjs` enforce that compiled and interpreted predicts produce identical outputs.

## sadpan integration

Tables and DataFrames from [@gcu/sadpan](https://www.npmjs.com/package/@gcu/sadpan) work directly as `X` and `y` arguments. The `from_table` adapter handles the conversion:

```js
import { from_table } from '@gcu/learn';

const { X, y, feature_names, groups, xyz } =
  from_table(table, { features: ['a','b','c'], target: 'class', groups: 'hole_id', xyz: ['x','y','z'] });

est.fit(X, y);
est.feature_names_in_;   // ['a', 'b', 'c'] — populated automatically
```

Auto string-label encoding: if `y` is a column of strings (`['ore','waste','ore',…]`), it's encoded to integers and the inverse mapping is stored on the estimator (`est.classes_`).

`asMatrix(X)` (used internally) accepts:

- Sadpan Table / DataFrame (with `.toArray()` or column iteration)
- Plain `{col: array}` mapping
- 2D JS arrays
- Typed-array views (line ndarrays)

Each path populates `feature_names_in_` from column names when available.

## Architecture

```
ext/learn/src/
  base.js                — BaseEstimator, ClassifierMixin, RegressorMixin, TransformerMixin
  check_estimator.js     — conformance harness
  serialize.js           — dump/load (delegates to mimic-io)
  util/                  — clone, check_is_fitted, asMatrix, helpers
  tree.js                — DecisionTree{Classifier,Regressor}
  ensemble.js            — RandomForest, ExtraTrees, Bagging, GradientBoosting
  linear_model.js        — LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression
  neighbors.js           — KNN
  cluster.js             — KMeans, AgglomerativeClustering, DBSCAN
  mixture.js             — GaussianMixture
  decomposition.js       — PCA, TruncatedSVD, NMF
  cross_decomposition.js — PLSRegression
  impute.js              — SimpleImputer, KNNImputer, BDLImputer
  preprocessing.js       — Scalers, Encoders, Discretizers, PowerTransformer
  compositional.js       — CLR, ILR, ALR
  pipeline.js            — Pipeline, ColumnTransformer
  model_selection.js     — train_test_split, KFold variants, cross_val_score
  metrics.js             — classification + regression scores
  compile.js             — tree compilation to inlined JS predict
  main.js                — concat manifest
```

Each module is a single file because the estimators within share helpers (Gini computation, criterion functions, etc.); cross-module sharing happens through `util/` only. The `base.js` mixins are tiny — they expose `score`, `get_params`, `set_params`, and the not-fitted check; the substantive work lives in each estimator.

## Testing

459 tests across 20 files in `test/learn-*.test.mjs`. Coverage by module:

- `learn-base.test.mjs` — BaseEstimator, mixins, clone, check_is_fitted
- `learn-tree.test.mjs` + `learn-compile.test.mjs` — tree fit + predict + compiled-vs-interpreted parity
- `learn-ensemble.test.mjs` — forests, boosting, bagging
- `learn-linear-model.test.mjs` — regression fits + sklearn reference values
- `learn-cluster.test.mjs` + `-extras.test.mjs` — KMeans, agglomerative, DBSCAN
- `learn-decomposition.test.mjs` — PCA against SVD, TruncatedSVD, NMF
- `learn-pipeline.test.mjs` — pipelines + ColumnTransformer
- `learn-model-selection.test.mjs` — CV iterators + scoring
- `learn-metrics.test.mjs` — every metric against hand-computed reference
- `learn-adder-bridge.test.mjs` — adder cell import + use

`check_estimator` is run on every new estimator as part of the test suite.

## Open questions

- **`n_jobs > 1` for forests.** Worker-pool parallelism. The estimator-level loop (one worker per tree) is the obvious shape; needs a SharedArrayBuffer-safe data layout (or copy-cost amortization).
- **SVMs.** No kernel methods yet. SMO would be the implementation; substantial work, deferred.
- **Calibration.** No CalibratedClassifierCV. Easy to add once the cross-validation iterators are battle-tested (which they are now).
- **Feature importance via permutation.** `permutation_importance` would be useful. Trivial wrapper.
- **HalvingGridSearchCV.** Successive halving is the modern grid-search variant. Worth adding.
- **GPU compute.** Almost certainly not worth it for learn (the bottleneck for in-browser ML at our scale is data movement, not compute). Mentioned for completeness.

## What @gcu/learn is NOT

- **A scikit-learn port.** We share the API; we don't share the implementation. Estimators give identical outputs for identical seeds in supported cases — but a fitted sklearn estimator can't be loaded into learn and vice versa.
- **A neural-network framework.** For ML beyond classical tabular: TF.js, ONNX runtime web. Not on the roadmap.
- **A statistical inference library.** No p-values, no confidence intervals on coefficients. statsmodels-shape is a different package; learn is the scikit-learn-shape one.
- **A feature store.** Persistence of fitted models, yes (via mimic-io). Persistence of feature definitions and pipelines is a feature-store concern, not learn's.

## Versioning

Pre-1.0 means: parameter defaults are stable, fitted-attribute names are stable, the estimator contract is stable, the mimic-io serialization format is stable. New estimators land on minor versions. Method additions to existing estimators (`predict_proba` showing up on a classifier that didn't have it) land on minor versions. Removal or rename of any of the above is a breaking change requiring a major bump.
