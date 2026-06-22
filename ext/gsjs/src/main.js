// @gcu/gsjs — module manifest. Its re-exports ARE the @gcu/build manifest (the
// bundler walks them); every public src module is listed so the bundle's surface
// is the full union of the package's exports. Build order derives from the actual
// import graph, so the order here is just for reading.
//
// _wasm.js (the generated atra→wasm module) is intentionally NOT listed — its
// runtime helpers stay internal; api.js imports them, so @gcu/build still folds
// _wasm.js into the bundle, it just isn't re-exported publicly.

export * from './realize.js';     // STATUS, makeTransform, realize
export * from './aggregate.js';   // stats, histogram, swath, gradeTonnage
export * from './backend.js';     // cpuBackend, getBackend, setBackend
export * from './orient.js';      // setrot, sqdist, applyAnis, toRotmat, leapfrogToRotmat, GSLIB_PI
export * from './neigh.js';       // createNeighborhood, indexSamples, select
export * from './krige.js';       // krige (pure-JS kriging driver, neighbourhood-fed) + qknaSummary, crossValidate
export * from './decluster.js';   // declusterCell, declusterSweep, declusterWeights
export * from './variogram.js';   // experimental, ESTIMATORS, GAMV_PI
export * from './recipe.js';      // recipe, variogram, search, ok/sk/sk_lvm, none/topcut/hgr, fromJSON, run/estimate/evaluate
