# @gcu/learn

Classical machine learning for the browser, sklearn-API compatible. Part of the GCU
stack alongside [@gcu/natra](../natra) (numpy), [@gcu/sadpan](../sadpan) (pandas), and
[@gcu/mimic-io](../mimic-io) (JSON serialization).

```js
import { StandardScaler } from '@gcu/learn';

const scaler = new StandardScaler();
const X_scaled = scaler.fit_transform(X);
```

## Status — v0.1 + v0.2 complete

All v0.1 estimators per [SPEC-learn §4.1](../../spec_inbox/SPEC-learn.md) shipped (2026-05-12).
v0.2 (per §4.2 + §6.5) shipped same day: linear models, KNN, ensembles, GMM, DBSCAN,
TruncatedSVD, NMF, PLSRegression, GradientBoosting, BDLImputer, and the `.compile()`
predict tier for the tree family. 459 tests across 20 files; bundle ~355 KB.

**v0.2 progress:**
- [x] Linear models (LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression)
- [x] Ensembles (RandomForest{Classifier,Regressor}, ExtraTrees{Classifier,Regressor}, Bagging{Classifier,Regressor}) — single-threaded for now; worker-pool n_jobs > 1 deferred
- [x] Imputation (SimpleImputer, KNNImputer, BDLImputer — closes the last geo-distinctive gap from SPEC §1.2)
- [x] KNN family (KNeighborsClassifier, KNeighborsRegressor — backed by @gcu/scitra's KDTree)
- [x] GaussianMixture (full covariance, EM with k-means++ init, precision-Cholesky for fast log-density)
- [x] DBSCAN (KDTree-backed eps-neighbor BFS expansion, core/border/noise labeling)
- [x] TruncatedSVD (PCA without centering)
- [x] NMF (NNDSVD init + Frobenius multiplicative-update rules)
- [x] PLSRegression (PLS1 via NIPALS — chemometrics workhorse for collinear X)
- [x] GradientBoosting{Classifier,Regressor} (stagewise additive boosting; squared-error regression + log-loss multinomial; the "hardest piece of v0.2")
- [x] `.compile()` predict for the tree family (DecisionTree*, RandomForest*, ExtraTrees*, GradientBoostingRegressor; pragmatic JS-string emit + `new Function` rather than going through AIR's lower→emit pipeline; emits a single nested-ternary `return` expression to keep V8's inliner happy)
- [x] sadpan integration (`from_table` adapter for X/y/groups/xyz tuples with auto string-label encoding; asMatrix accepts sadpan Table / DataFrame / plain `{col: array}` at the estimator boundary; **every estimator** auto-populates `feature_names_in_` from input column names — round-trips through dump/load)

### When to use `.compile()`

The compile path emits literal-threshold branches that V8 inlines into the predict
loop. Wins are largest when the per-tree compiled function stays small enough for V8
to inline:

| Workload | Speedup |
|---|---|
| Shallow forests (max_depth ≤ 8, ≤ 100 trees) on 5k+ predictions | ~1.2-1.4× |
| Deep forests (max_depth ≥ 12) — function body exceeds V8's inlining heuristic | ~0.9-1.0× (breakeven) |
| Very small predict batches (< 100 samples) | dominated by warmup; wash |

Practical rule: `.compile()` is worth it for forests you'll predict against many times
with shallow-to-medium trees. For deep trees the interpreted `_walkTree` loop is
already extremely tight and stays competitive. Either way the predictions are
identical (16 parity tests in `learn-compile.test.mjs` enforce this).

- [x] BaseEstimator + mixins + `clone` + `check_is_fitted`
- [x] mimic-io serialization integration
- [x] check_estimator conformance harness
- [x] StandardScaler
- [x] metrics (classification + regression: accuracy/precision/recall/f1, confusion_matrix, classification_report, cohen_kappa, MCC, R²/MSE/MAE/MAPE/EV)
- [x] model_selection (train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold, cross_val_score, cross_validate)
- [x] tree (DecisionTreeClassifier, DecisionTreeRegressor — CART with Gini / squared-error, parallel-array storage, mimic-io round-trip)
- [x] pipeline (Pipeline, make_pipeline — chained transformers + final estimator, custom mimic-io codec for nested children, dotted set_params)
- [x] compositional (CLR, ILR, ALR — Aitchison log-ratio transforms with multiplicative zero replacement, Helmert-basis ILR for orthonormal coordinates)
- [x] Full preprocessing (MinMaxScaler, MaxAbsScaler, RobustScaler, LabelEncoder, OrdinalEncoder, OneHotEncoder, KBinsDiscretizer, PowerTransformer)
- [x] cluster (KMeans with k-means++ init, AgglomerativeClustering with Ward / single / complete / average linkage via Lance-Williams)
- [x] decomposition (PCA via @gcu/line's SVD; components_, explained_variance_, whitening, sklearn sign convention)
- [x] ColumnTransformer + make_column_transformer (heterogeneous-column routing, supports mixed numeric/categorical X)
- [x] adder bridge (`learn` namespace for adder cells: `from learn.tree import DecisionTreeClassifier`)
- [ ] adder bridge (`learn` namespace for adder cells)
- [ ] cluster (KMeans, AgglomerativeClustering)
- [ ] decomposition (PCA via alpack)
- [ ] compositional (CLR, ILR, ALR)
- [ ] pipeline (Pipeline, ColumnTransformer)
- [ ] adder bridge (`learn` namespace for adder cells)

See [SPEC-learn.md](../../spec_inbox/SPEC-learn.md) for the full v0.1/v0.2/v0.3 cuts and
the design rationale.

## Conventions

- **Namespace:** `learn`, not `sklearn`. Drop-in source compatibility with scikit-learn at
  the import-statement level (`s/sklearn/learn/`), but an adder-native implementation, not
  a faithful Python wrapper.
- **API contract:** scikit-learn to the letter, with documented JS-imposed deviations
  (see § "API compatibility" below).
- **Serialization:** every fitted estimator round-trips through [@gcu/mimic-io](../mimic-io).

## API compatibility — what matches sklearn and what doesn't

### What matches

- **Parameter names + defaults** for every hyperparameter `@gcu/learn` implements. Code
  that uses the supported subset runs unchanged after `s/sklearn/learn/`.
- **Fitted-attribute names + trailing underscore convention** (`mean_`, `scale_`, `var_`,
  `coef_`, `tree_`, `cluster_centers_`, `labels_`, `inertia_`, `components_`,
  `explained_variance_`, `n_features_in_`, `n_samples_seen_`, etc.).
- **Method shapes**: `fit(X, y)` returns `this`; `predict(X)` / `predict_proba(X)` /
  `transform(X)` / `inverse_transform(Z)` / `score(X, y)` / `fit_transform(X, y)`.
- **Dotted nested set_params**: `pipe.set_params({'forest__n_estimators': 200})`.
- **Cloning + introspection**: `clone(est)`, `est.get_params(deep=true)`,
  `est.__sklearn_tags__()`, `est.__sklearn_clone__()` override hook,
  `check_is_fitted(est)`, `__sklearn_is_fitted__()` override hook,
  `est.constructor._estimator_type`.
- **Class registry shape**: closed-registry per-consumer (mimic-io's design).
- **`__sklearn_tags__()`** returns the documented sklearn-1.6+ shape (requires_y,
  allow_nan, binary_only, multioutput, pairwise, requires_positive_X,
  requires_positive_y, non_deterministic, poor_score, no_validation, stateless,
  estimator_type).

### Documented JS-imposed deviations (per SPEC-learn §3.6)

1. **No keyword arguments — options object instead.** sklearn's
   `fit(X, y, sample_weight=w)` becomes `fit(X, y, { sample_weight: w })`. Same semantics,
   different syntax. The adder bridge re-rehydrates Python kwargs from the trailing object,
   so Python notebook code in adder cells looks unchanged.

   ```python
   # sklearn
   StandardScaler(with_mean=True, with_std=False)
   ```
   ```js
   // @gcu/learn (in JS)
   new StandardScaler({ with_mean: true, with_std: false })
   ```
   ```python
   # @gcu/learn from inside an adder cell — no syntactic difference from sklearn
   StandardScaler(with_mean=True, with_std=False)
   ```

2. **No pickle — mimic-io JSON instead.** `dump(estimator)` returns a v2 mimic-io JSON
   dict; `load(json)` reconstructs the estimator with bit-identical predictions. Plain
   text, language-independent, security-bounded by the closed class registry. See
   [@gcu/mimic-io](../mimic-io).

3. **No `scipy.sparse` matrices.** Estimators that benefit from sparsity in sklearn
   (large `OneHotEncoder` outputs, text vectorizers) operate on dense ndarrays only.

4. **`random_state` accepts integer or `null` only.** sklearn additionally accepts
   `np.random.RandomState` and `np.random.Generator` instances. We use mulberry32
   internally (matches arborist's seed convention). Pass an integer.

### Hyperparameter coverage — subset of sklearn

`@gcu/learn` implements the most-used hyperparameters per estimator and defers
infrequently-used ones to later versions. Where you ask for an unsupported value,
the constructor or `fit()` throws a clear error like `criterion='entropy' not
supported in v0.1 (use 'gini')` rather than silently mis-behaving.

| Estimator | sklearn params | `@gcu/learn` v0.1 | Deferred |
|---|---|---|---|
| StandardScaler | `copy`, `with_mean`, `with_std` | `with_mean`, `with_std` | `copy` (always copies) |
| MinMaxScaler | `feature_range`, `copy`, `clip` | `feature_range` | `copy`, `clip` |
| MaxAbsScaler | `copy` | — | `copy` (always copies) |
| RobustScaler | `with_centering`, `with_scaling`, `quantile_range`, `copy`, `unit_variance` | first 3 | `copy`, `unit_variance` |
| OneHotEncoder | `categories`, `drop`, `sparse_output`, `dtype`, `handle_unknown`, `min_frequency`, `max_categories`, `feature_name_combiner` | `categories`, `drop`, `handle_unknown` | `sparse_output` (always dense per dev #3), `dtype`, `min_frequency`, `max_categories`, `feature_name_combiner` |
| KBinsDiscretizer | `n_bins`, `encode`, `strategy`, `dtype`, `subsample`, `random_state` | `n_bins`, `strategy`, `encode='ordinal'` | `encode='onehot'`, `dtype`, `subsample`, `random_state` |
| PowerTransformer | `method`, `standardize`, `copy` | `method='yeo-johnson'`, `standardize` | `method='box-cox'` (needs strictly positive input), `copy` |
| DecisionTree{Classifier,Regressor} | criterion, splitter, max_depth, min_samples_split, min_samples_leaf, min_weight_fraction_leaf, max_features, random_state, max_leaf_nodes, min_impurity_decrease, class_weight, ccp_alpha, monotonic_cst | `criterion='gini'\|'squared_error'`, `max_depth`, `min_samples_split`, `min_samples_leaf`, `max_features`, `random_state` | `splitter`, `min_weight_fraction_leaf`, `max_leaf_nodes`, `min_impurity_decrease`, `class_weight`, `ccp_alpha`, `monotonic_cst` |
| KMeans | n_clusters, init, n_init, max_iter, tol, verbose, random_state, copy_x, algorithm | `n_clusters`, `init`, `n_init`, `max_iter`, `tol`, `random_state` | `verbose`, `copy_x`, `algorithm` (always Lloyd) |
| AgglomerativeClustering | n_clusters, metric, memory, connectivity, compute_full_tree, linkage, distance_threshold, compute_distances | `n_clusters`, `metric='euclidean'`, `linkage` | `memory`, `connectivity`, `compute_full_tree`, `distance_threshold`, `compute_distances` |
| PCA | n_components, copy, whiten, svd_solver, tol, iterated_power, n_oversamples, power_iteration_normalizer, random_state | `n_components`, `whiten` | rest (we always use full SVD via line) |
| Pipeline | steps, memory, verbose, transform_input | `steps` | `memory`, `verbose`, `transform_input` |
| ColumnTransformer | transformers, remainder, sparse_threshold, n_jobs, transformer_weights, verbose, verbose_feature_names_out, force_int_remainder_cols | `transformers`, `remainder='drop'\|'passthrough'` | rest |
| KFold / StratifiedKFold | n_splits, shuffle, random_state | all 3 | — |
| GroupKFold | n_splits | `n_splits` | — |
| train_test_split | test_size, train_size, random_state, shuffle, stratify | all | — |

Estimators not in this table (CLR, ILR, ALR, SpatialKFold, BDLImputer, etc.) are
`@gcu/learn`-specific and have no sklearn equivalent. See [SPEC-learn §5](../../spec_inbox/SPEC-learn.md)
for the geo-distinctive primitives.

### Implementation conventions worth knowing

- **`_module` is set as an instance attribute in each estimator's constructor**
  (e.g. `this._module = '@gcu/learn.preprocessing'`). sklearn would put per-class
  metadata like this on the class (as a class attribute). Functionally equivalent —
  mimic-io's dump reads `est._module` first either way. May tighten in a future PR.
- **Hyperparameter discovery is convention-based**, not constructor-introspection.
  `get_params()` scans `Object.keys(this)` and filters out anything with a leading or
  trailing underscore. Estimators that need explicit control set
  `static _param_keys = [...]` on the class.
- **Matrix shape envelope**: estimator outputs are `Float64Array` with `.shape` set
  as an own property `[n, m]` (or `{ data: Float64Array, shape: [n, m] }` from
  asMatrix). Both forms are accepted at every input boundary, so estimator outputs
  flow into other estimator inputs without a copy.
- **Custom mimic-io codec extension point**: classes with nested estimator state
  (Pipeline, ColumnTransformer) implement instance `_toMimicIo(opts)` and
  static `_fromMimicIo(json, opts)`. The default mimic-io walker can't preserve
  nested estimator class identity through `params`, so these classes own their
  serialization round-trip directly.

## License

MIT — Arthur Endlein Correia, Geoscientific Chaos Union, 2026.
