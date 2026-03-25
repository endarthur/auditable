// Re-export stub for sideact — at dev/test time, resolves via relative path.
// At build time, processModulesAsRegistry rewrites './sideact.js' → '#sideact',
// and the actual bundle (ext/sideact/index.js) is loaded via the import map.
export { signal, computed, effect, batch, h, each, render } from '../../ext/sideact/index.js';
