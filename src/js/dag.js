import { S } from './state.js';

// ── REACTIVE DAG ──
// Thin wrapper over dag-core.js — re-exports all pure functions,
// provides S.cells-based buildDAG/topoSort for the browser.

import {
  isManual, isHidden, isNorun, isCollapsed, isBare,
  parseCellName, parseOutputId, parseOutputClass,
  isPrivate, isMcp, isMcpRw, parseMcpDescribe, isMcpManifest, parseMcpFs,
  parseNames, findUses, findHtmlUses, parseHtmlDefines,
  buildDAG as _buildDAG,
  topoSort as _topoSort,
} from './dag-core.js';

export {
  isManual, isHidden, isNorun, isCollapsed, isBare,
  parseCellName, parseOutputId, parseOutputClass,
  isPrivate, isMcp, isMcpRw, parseMcpDescribe, isMcpManifest, parseMcpFs,
  parseNames, findUses, findHtmlUses, parseHtmlDefines,
};

// S.cells wrappers — preserve existing API
export function buildDAG() {
  return _buildDAG(
    S.cells,
    window._cellTypes,
    window._airAnalyzer || null,
    window._airRePropagate || null,
  );
}

export function topoSort(dirtyIds) {
  return _topoSort(S.cells, dirtyIds);
}
