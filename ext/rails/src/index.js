// @gcu/rails — npm entry (public API)
//
// Layout engine for docked tab-based workspaces.
// See SPEC-rails.md for the full design.

export { createRails } from './api.js';
export {
  findTab,
  findStack,
  findRail,
  emptyState,
  validateState,
  freshId,
} from './state.js';
