// @gcu/build — public surface (SPEC §13.1)
//
// Phase 1: the pure core (bundleModules), the rename pass (renameCollisions),
// the node-fs adapter (bundle), and the in-memory adapter (bundleMemory).
// Phase 2 adds mergeBundles, the CLI, source maps, meta, lint, define, inline.

export { bundleModules, renameCollisions } from './core.js';
export { mergeBundles } from './merge.js';
export { bundle } from './io/node.js';
export { bundleMemory } from './io/memory.js';
export { BuildError } from './errors.js';
