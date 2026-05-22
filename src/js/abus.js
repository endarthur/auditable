// Re-export stub for @gcu/abus — used by the notebook's Works surface
// adapter at dev/test time. At build time, processModulesAsRegistry rewrites
// './abus.js' → '#abus', and the actual abus bundle (ext/abus/index.js) is
// loaded via the import map (added to the registry by build.js).
export { connect, AbusError } from '../../ext/abus/index.js';
