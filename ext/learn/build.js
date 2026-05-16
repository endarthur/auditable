#!/usr/bin/env node
// Bundle ext/learn/src/ → ext/learn/index.js (single-file ESM).
//
// Concat-and-strip pattern matching @gcu/mimic-io / @gcu/scitra / @gcu/iso9660:
// read each module in dependency order, strip relative imports and bare
// `export { … }` blocks, keep `export <decl>` with the keyword removed,
// append a single final export block.
//
// External dependencies (notably @gcu/mimic-io) are imported by their bundled
// index.js path, which the concat preserves verbatim — the runtime resolves it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');

// Order matters: util/* used by everything; base.js defines BaseEstimator
// referenced everywhere; serialize.js consumes the registry; estimator
// modules come last in topological order.
const modules = [
  'util/random.js',
  'util/checks.js',
  'base.js',
  'serialize.js',
  'check_estimator.js',
  'metrics.js',
  'model_selection.js',
  'preprocessing.js',
  'tree.js',
  'compositional.js',
  'pipeline.js',
  'cluster.js',
  'decomposition.js',
  'linear_model.js',
  'ensemble.js',
  'impute.js',
  'neighbors.js',
  'mixture.js',
  'cross_decomposition.js',
  'compile.js',
];

let output = '// @gcu/learn — bundled from src/\n';
output += '// SPDX-License-Identifier: MIT\n';
output += '// Auto-generated — do not edit; edit src/ and rerun build.js.\n\n';

// Hoist imports from outside ext/learn/src/ (bare specifiers like
// "@gcu/mimic-io", or relative paths that escape with "../../") into a
// single block at the top of the bundle. Imports within src/ get stripped
// because the concat handles cross-file references.
//
// External imports from the same module get MERGED by named binding —
// otherwise multiple files importing different symbols from line/index.js
// would emit duplicate `NdArray`-style declarations and the bundle won't
// parse.
//
// Cross-package sibling imports (`../../line/index.js`) get translated to
// `@gcu/<pkg>` bare specifiers — blob URLs aren't hierarchical, so
// `../line/index.js` in the bundle fails when learn is loaded from a blob.
// auditable's module loader resolves `@gcu/<pkg>` against _installedModules
// (or dev-mode fallback) and rewrites to stable blob URLs.
const importsByPath = new Map();   // path → Set of named bindings (raw text like "x", "x as y")

const isExternalPath = (p) => !p.startsWith('.') || p.startsWith('../../');

// Translate a relative cross-package path into its @gcu/<pkg> bare
// specifier so the runtime loader can resolve it through the module
// registry instead of relying on the bundle's host URL being hierarchical.
function translateExternalPath(p) {
  if (p.startsWith('../../')) {
    const m = p.match(/^\.\.\/\.\.\/([\w-]+)\/index\.js$/);
    if (m) return '@gcu/' + m[1];
    return p.slice(3);
  }
  return p;
}

for (const mod of modules) {
  let src = readFileSync(join(srcDir, mod), 'utf8');
  src = src.replace(
    /^import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
    (_line, named, path) => {
      if (!isExternalPath(path)) return '';
      const finalPath = translateExternalPath(path);
      if (!importsByPath.has(finalPath)) importsByPath.set(finalPath, new Set());
      const bindings = importsByPath.get(finalPath);
      for (const b of named.split(',')) {
        const t = b.trim();
        if (t) bindings.add(t);
      }
      return '';
    },
  );
  // Also strip default / namespace imports from external paths (none expected
  // currently, but keep the safety net).
  src = src.replace(
    /^import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,
    (line, path) => {
      if (isExternalPath(path)) {
        const finalPath = translateExternalPath(path);
        const rewritten = line.replace(path, finalPath);
        if (!importsByPath.has(finalPath)) importsByPath.set(finalPath, new Set());
        importsByPath.get(finalPath).add(`__RAW__${rewritten.trim()}`);
      }
      return '';
    },
  );
  // Strip bare `export { … }` blocks (single block at the end).
  src = src.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  // Convert `export <decl>` into `<decl>` for top-level declarations.
  src = src.replace(/^export\s+(function|async\s+function|const|let|var|class)\s/gm, '$1 ');
  // Uniqueify top-level `_foo` declarations per file so cross-module
  // collisions in the concat'd bundle (e.g. _encodeClasses, _gatherCols)
  // don't blow up. Word-boundary regex preserves substring matches.
  const suffix = mod.replace(/\.js$/, '').replace(/.*\//, '');
  src = _uniqueifyPrivates(src, suffix);
  output += `// ── ${mod} ──\n\n${src.trim()}\n\n`;
}

function _uniqueifyPrivates(src, suffix) {
  const lines = src.split('\n');
  const names = new Set();
  for (const line of lines) {
    let m;
    if ((m = line.match(/^function\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
    else if ((m = line.match(/^async\s+function\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
    else if ((m = line.match(/^const\s+(_[A-Za-z0-9_]+)\s*=/))) names.add(m[1]);
    else if ((m = line.match(/^let\s+(_[A-Za-z0-9_]+)\s*=/))) names.add(m[1]);
    else if ((m = line.match(/^class\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
  }
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    src = src.replace(re, `${name}_${suffix}`);
  }
  return src;
}

// Hoist deduped external imports to the top, one merged statement per path.
if (importsByPath.size > 0) {
  const lines = [];
  for (const [path, bindings] of [...importsByPath].sort(([a], [b]) => a.localeCompare(b))) {
    const named = [];
    for (const b of bindings) {
      if (b.startsWith('__RAW__')) lines.push(b.slice('__RAW__'.length));
      else named.push(b);
    }
    if (named.length) {
      lines.push(`import { ${[...named].sort().join(', ')} } from '${path}';`);
    }
  }
  output = output.replace(/(^[\s\S]*?\n\n)/, `$1${lines.join('\n')}\n\n`);
}

output += `// ── namespace barrels (sklearn-shaped) ──
const base = {
  BaseEstimator,
  ClassifierMixin, RegressorMixin, TransformerMixin, ClusterMixin,
  clone, check_is_fitted, NotFittedError,
};
const preprocessing = {
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
};
const tree = { DecisionTreeClassifier, DecisionTreeRegressor };
const cluster = { KMeans, AgglomerativeClustering, DBSCAN };
const decomposition = { PCA, TruncatedSVD, NMF };
const compositional = { CLR, ILR, ALR };
const pipeline = { Pipeline, make_pipeline };
const compose = { ColumnTransformer, make_column_transformer };
const model_selection = {
  train_test_split, KFold, StratifiedKFold, GroupKFold, SpatialKFold,
  cross_val_score, cross_validate, from_table,
};
const metrics = {
  accuracy_score, balanced_accuracy_score,
  precision_score, recall_score, f1_score,
  confusion_matrix, classification_report,
  cohen_kappa_score, matthews_corrcoef,
  r2_score, mean_squared_error, root_mean_squared_error,
  mean_absolute_error, mean_absolute_percentage_error,
  explained_variance_score,
};
const utils = {
  check_estimator,
  random: { mulberry32, makeRng, makeNormalSampler },
  compile: { compileTreeValue, compileTreeClass, compileTreeLeaf },
  validation: { check_is_fitted, NotFittedError },
};
const linear_model = {
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
};
const ensemble = {
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  GradientBoostingClassifier, GradientBoostingRegressor,
};
const impute = {
  SimpleImputer, KNNImputer, BDLImputer,
};
const neighbors = {
  KNeighborsClassifier, KNeighborsRegressor,
};
const mixture = { GaussianMixture };
const cross_decomposition = { PLSRegression };

// ── exports ──
export {
  // base
  BaseEstimator,
  ClassifierMixin, RegressorMixin, TransformerMixin, ClusterMixin,
  clone, check_is_fitted, NotFittedError,
  // serialize
  dump, load, learnRegistry,
  // check_estimator
  check_estimator,
  // util/random
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
  cross_val_score, cross_validate, from_table,
  // preprocessing
  StandardScaler, MinMaxScaler, MaxAbsScaler, RobustScaler,
  LabelEncoder, OrdinalEncoder, OneHotEncoder,
  KBinsDiscretizer, PowerTransformer,
  // tree
  DecisionTreeClassifier, DecisionTreeRegressor,
  // compositional
  CLR, ILR, ALR,
  // pipeline + compose
  Pipeline, make_pipeline,
  ColumnTransformer, make_column_transformer,
  // cluster
  KMeans, AgglomerativeClustering, DBSCAN,
  // decomposition
  PCA, TruncatedSVD, NMF,
  // linear_model
  LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression,
  // ensemble
  RandomForestClassifier, RandomForestRegressor,
  ExtraTreesClassifier, ExtraTreesRegressor,
  BaggingClassifier, BaggingRegressor,
  GradientBoostingClassifier, GradientBoostingRegressor,
  // impute
  SimpleImputer, KNNImputer, BDLImputer,
  // neighbors
  KNeighborsClassifier, KNeighborsRegressor,
  // mixture
  GaussianMixture,
  // cross_decomposition
  PLSRegression,
  // compile
  installCompile, compileTreeValue, compileTreeClass, compileTreeLeaf,
  // namespace barrels
  base, preprocessing, tree, cluster, decomposition, compositional,
  pipeline, compose, model_selection, metrics, utils, linear_model, ensemble,
  impute, neighbors, mixture, cross_decomposition,
};
`;

const outPath = join(__dirname, 'index.js');
writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
