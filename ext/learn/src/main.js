// @gcu/learn — top-level barrel.
// Re-exports the v0.1 API surface. Submodules expose themselves both as
// named imports and as namespaced barrels (`tree`, `preprocessing`, …) so
// users can write either style:
//
//   import { StandardScaler } from '@gcu/learn';
//   import { preprocessing } from '@gcu/learn';
//   const scaler = new preprocessing.StandardScaler();

import {
  BaseEstimator,
  ClassifierMixin, RegressorMixin, TransformerMixin, ClusterMixin,
  clone, check_is_fitted, NotFittedError,
} from './base.js';
import { dump, load, learnRegistry } from './serialize.js';
import { check_estimator } from './check_estimator.js';
import { mulberry32, makeRng, makeNormalSampler } from './util/random.js';
import {
  accuracy_score, balanced_accuracy_score,
  precision_score, recall_score, f1_score,
  confusion_matrix, classification_report,
  cohen_kappa_score, matthews_corrcoef,
  r2_score, mean_squared_error, root_mean_squared_error,
  mean_absolute_error, mean_absolute_percentage_error,
  explained_variance_score,
} from './metrics.js';
import {
  train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold,
  cross_val_score, cross_validate,
} from './model_selection.js';
import {
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
} from './preprocessing.js';
import { DecisionTreeClassifier, DecisionTreeRegressor } from './tree.js';
import {
  Pipeline, make_pipeline,
  ColumnTransformer, make_column_transformer,
} from './pipeline.js';
import { CLR, ILR, ALR } from './compositional.js';
import { KMeans, AgglomerativeClustering, DBSCAN } from './cluster.js';
import { PCA, TruncatedSVD, NMF } from './decomposition.js';
import {
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
} from './linear_model.js';
import {
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  GradientBoostingClassifier, GradientBoostingRegressor,
} from './ensemble.js';
import { SimpleImputer, KNNImputer, BDLImputer } from './impute.js';
import { KNeighborsClassifier, KNeighborsRegressor } from './neighbors.js';
import { GaussianMixture } from './mixture.js';
import { PLSRegression } from './cross_decomposition.js';
import { installCompile, compileTreeValue, compileTreeClass, compileTreeLeaf } from './compile.js';

// Wire up the .compile() override for the tree family. BaseEstimator's
// default is a no-op; this swaps in the JIT-emit version (SPEC §6.5).
installCompile({
  DecisionTreeClassifier, DecisionTreeRegressor,
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  GradientBoostingRegressor,
});

// Direct re-exports for tree-shaking / convenience.
export {
  BaseEstimator,
  ClassifierMixin, RegressorMixin, TransformerMixin, ClusterMixin,
  clone, check_is_fitted, NotFittedError,
  dump, load, learnRegistry,
  check_estimator,
  mulberry32, makeRng, makeNormalSampler,
  // metrics
  accuracy_score, balanced_accuracy_score,
  precision_score, recall_score, f1_score,
  confusion_matrix, classification_report,
  cohen_kappa_score, matthews_corrcoef,
  r2_score, mean_squared_error, root_mean_squared_error,
  mean_absolute_error, mean_absolute_percentage_error,
  explained_variance_score,
  // model_selection
  train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold,
  cross_val_score, cross_validate,
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
  DecisionTreeClassifier, DecisionTreeRegressor,
  Pipeline, make_pipeline,
  ColumnTransformer, make_column_transformer,
  CLR, ILR, ALR,
  KMeans, AgglomerativeClustering, DBSCAN,
  PCA, TruncatedSVD, NMF,
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  GradientBoostingClassifier, GradientBoostingRegressor,
  SimpleImputer, KNNImputer, BDLImputer,
  KNeighborsClassifier, KNeighborsRegressor,
  GaussianMixture,
  PLSRegression,
  compileTreeValue, compileTreeClass, compileTreeLeaf,
};

// Namespaced barrels (sklearn-shaped).
export const base = {
  BaseEstimator,
  ClassifierMixin, RegressorMixin, TransformerMixin, ClusterMixin,
  clone, check_is_fitted, NotFittedError,
};

export const preprocessing = {
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
};

export const tree = {
  DecisionTreeClassifier, DecisionTreeRegressor,
};

export const pipeline = {
  Pipeline, make_pipeline,
};

export const compose = {
  ColumnTransformer, make_column_transformer,
};

export const compositional = {
  CLR, ILR, ALR,
};

export const cluster = {
  KMeans, AgglomerativeClustering, DBSCAN,
};

export const decomposition = {
  PCA, TruncatedSVD, NMF,
};

export const linear_model = {
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
};

export const ensemble = {
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  GradientBoostingClassifier, GradientBoostingRegressor,
};

export const impute = {
  SimpleImputer, KNNImputer, BDLImputer,
};

export const neighbors = {
  KNeighborsClassifier, KNeighborsRegressor,
};

export const mixture = {
  GaussianMixture,
};

export const cross_decomposition = {
  PLSRegression,
};

export const metrics = {
  accuracy_score, balanced_accuracy_score,
  precision_score, recall_score, f1_score,
  confusion_matrix, classification_report,
  cohen_kappa_score, matthews_corrcoef,
  r2_score, mean_squared_error, root_mean_squared_error,
  mean_absolute_error, mean_absolute_percentage_error,
  explained_variance_score,
};

export const model_selection = {
  train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold,
  cross_val_score, cross_validate,
};

export const utils = {
  check_estimator,
  random: { mulberry32, makeRng, makeNormalSampler },
  // Tree-compile helpers (SPEC §6.5). For most users, est.compile() is
  // the entry point; these are exposed for power users compiling
  // custom tree-shaped estimators not in the registered set.
  compile: { compileTreeValue, compileTreeClass, compileTreeLeaf },
  // Validation helpers (sklearn parity: `from sklearn.utils.validation
  // import check_is_fitted`).
  validation: { check_is_fitted, NotFittedError },
};
