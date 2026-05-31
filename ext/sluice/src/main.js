// @gcu/sluice — online / streaming statistics nucleus.
//
// A sluice box: feed it a flow of rows, retain the valuable fraction (the
// statistics), let the bulk pass. Mergeable, never-resident accumulators over
// unbounded row streams + a cold-recipe scan runner. The streaming complement
// to @gcu/scitra (batch) and @gcu/line (BLAS).
//
// Module manifest (build concat order):
//   accumulator.js — the Accumulator protocol + count/sum/extent/welford/weightedStats
//   tdigest.js     — t-digest quantiles (mergeable) + quantileFromCentroids
//   categorical.js — topK / cardinality (exact-with-cap)
//   histogram.js   — fixed-bin weighted histogram + cumulativeFromTop
//   combinators.js — collect / groupBy / binned (row-level fan-out)
//   gradetonnage.js— gradeTonnage (cumulative grade-tonnage curve; mining-domain)
//   spec.js        — accumulatorFromSpec (serializable accumulator specs, cross-realm op contract)
//   runner.js      — sources, lines, sample, parseCsv, filter/map/select, recipe, scan, chunks

export * from './accumulator.js';
export * from './tdigest.js';
export * from './categorical.js';
export * from './histogram.js';
export * from './combinators.js';
export * from './gradetonnage.js';
export * from './spec.js';
export * from './runner.js';
