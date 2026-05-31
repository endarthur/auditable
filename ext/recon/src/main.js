// @gcu/recon — reconnaissance for data: a general, heuristic-driven sniffer.
//
// Scouts a sample of tabular data (and, for geometry, a coord scan) and produces
// an annotated manifest — delimiter, header, types, semantic roles, units,
// analytes, spatial facet — via a registry of heuristics. Geoscience detection is
// one registerable pack, not hardcoded. Inference only: no mutation, no reorder,
// no format reading (sources are sluice/archive/omf). Zero-dep.
//
// Module manifest (build concat order):
//   detect.js     — delimiter, base types, the sniff context, NULL_SENTINELS
//   naming.js     — column-name analysis: coords, units, analytes (standalone detectors)
//   geometry.js   — geometryAccumulator (sluice-protocol) + inferGeometry
//   heuristics.js — corePack + geoPack
//   recon.js      — registry + sniff() runner + manifest assembly

export * from './detect.js';
export * from './naming.js';
export * from './geometry.js';
export * from './heuristics.js';
export * from './recon.js';
