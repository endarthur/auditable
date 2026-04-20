// @gcu/adder/vfs — explicit opt-in access to adder's VFS plumbing.
// Most consumers should pass a vfs to run()/compile() in opts instead; these
// setters are exposed for cases where global-scope configuration is desired
// (e.g. Auditable's cell-runtime integration) or inspection of the active VFS.

export { setAdderVFS, getAdderVFS } from './builtins.js';
