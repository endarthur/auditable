// @gcu/gsjs — modern geostatistics, the evolving sibling to the frozen
// @gcu/gslib oracle. See spec_inbox/gsjs-SPEC.md + SPEC-neigh.md.
//
// SHIPPED:
//   realize(), makeTransform(), STATUS — the realization oracle (pure JS).
//
// IN PROGRESS (M1):
//   kriging() — the forked per-block loop (gsjs.atra), emitting the
//   BlockEstimateTensor (weights + indices + kv + status). Lands with the
//   atra build; until then this re-exports the realization layer so the
//   oracle + tests are usable standalone.
//
// LATER:
//   WebGPU realization + aggregation kernels; the decoupled neighborhood
//   module (SPEC-neigh).

export { realize, makeTransform, STATUS } from './realize.js';
