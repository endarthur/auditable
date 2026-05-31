// @gcu/flowsheet — lazy, content-addressed pipeline (lineage) engine.
//
// A flowsheet: the network of unit operations a processing plant runs material
// through. The L2 spine of the geoscience/tabular workbench — an explicit
// dataflow graph of heavy operations over named datasets, evaluated lazily with
// a content-addressed cache, so editing a parameter recomputes only what it
// changed. Ties @gcu/sluice (streaming) + @gcu/recon (sniffing) into reactive
// node graphs. Host-agnostic: compute runs through a swappable execution backend
// (inline now; @gcu/proc worker / shell service later, per the §7a runtime
// model). Zero-dep, pure/headless. (recon scouts → sluice concentrates →
// flowsheet runs the circuit.)
//
// Module manifest (build concat order):
//   hash.js     — canonicalJson + deterministic content hashing (lineage keys)
//   registry.js — defineNode, createRegistry, compatibleKinds
//   cache.js    — createMemoryCache (LRU) + createNullCache
//   engine.js   — createEngine: pull (lazy + cached), validate, hashOf, inlineBackend

export * from './hash.js';
export * from './registry.js';
export * from './cache.js';
export * from './engine.js';
