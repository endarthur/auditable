// @gcu/msh — single-file ESM. index.js is a re-export so consumers can
// `import { readMSH } from '@gcu/msh'` regardless of which entry the
// package manifest points at. Implementation lives in msh.js.
export { readMSH, writeMSH, MSHError } from './msh.js';
