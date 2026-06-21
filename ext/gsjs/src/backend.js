// @gcu/gsjs — the swappable compute backend.
//
// realize + the aggregations are the contract; the implementation is
// selectable. The CPU (pure-JS) backend is the default — and the oracle every
// other backend validates against bit-for-bit (selection) / to tolerance
// (float estimates, widest on GPU f32). A WebGPU backend (later) implements the
// same interface; an atra/WASM backend can replace any kernel measured faster.
//
// This is the seam that keeps GPU off the critical path: the whole usable v1
// runs on `cpuBackend`; GPU is a drop-in added once the CPU path is complete.
// Spec: spec_inbox/gsjs-SPEC.md §"Initial implementation order" (GPU last) +
// SPEC-neigh §8 (per-kernel measured backend choice).

import { realize } from './realize.js';
import { stats, histogram, swath, gradeTonnage } from './aggregate.js';

export const cpuBackend = {
  name: 'cpu',
  realize,
  stats,
  histogram,
  swath,
  gradeTonnage,
};

let _backend = cpuBackend;

// Select the active backend (a future WebGPU / atra backend object). Passing a
// falsy value resets to CPU.
export function setBackend(b) {
  _backend = b || cpuBackend;
}

export function getBackend() {
  return _backend;
}
