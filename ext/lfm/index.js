// @gcu/lfm — single-file ESM. index.js is a re-export so consumers can
// `import { readLFM } from '@gcu/lfm'` regardless of which entry the
// package manifest points at. The implementation lives in lfm.js.
export { readLFM, writeLFM, LFMError } from './lfm.js';
