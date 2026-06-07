// mcp-access.js — the pure access-level decision for the MCP adapter.
//
// Extracted from mcp-adapter.js so the directive/manifest precedence logic is
// unit-testable without a DOM. The adapter (_mcpCellAccess) supplies the impure
// inputs: the parsed manifest, the cell's index, and its name. Everything here
// is a pure function of those inputs.
//
// Posture: "open to read, gated to act" — reads are open by default; mutation
// and execution are gated by the adapter (see mcp-adapter.js header).

import { isPrivate, isMcp, isMcpRw, isMcpManifest } from './dag.js';

/**
 * Resolve a cell's MCP access level.
 * @param {string} code        the cell's source
 * @param {object|null} manifest  parsed `// %mcp manifest` object (or null)
 * @param {number} cellIndex   the cell's index (for manifest tool-level `cell: N`)
 * @param {string|null} cellName  the cell's %cellName (for tool-level `cell: "name"`)
 * @returns {'private'|'rw'|'read'|'open'|'none'}
 *   private = hidden; read = read-only source; rw = pre-approved edits/exec;
 *   open = readable + edits/exec confirm (the default); none = strict-mode hidden.
 *
 * Precedence: explicit cell directive > manifest tool-level > manifest defaults > open.
 */
export function resolveAccess(code, manifest, cellIndex, cellName) {
  code = code || '';

  // 1. Explicit cell directives (highest precedence). Order matters: %mcp rw
  //    before %mcp; the manifest cell itself is private.
  if (isPrivate(code)) return 'private';
  if (isMcpRw(code)) return 'rw';
  if (isMcp(code)) return 'read';
  if (isMcpManifest(code)) return 'private';

  // 2. Manifest.
  if (manifest) {
    // 2a. Tool-level access — a manifest tool bound to this cell by index or name.
    if (manifest.tools) {
      for (const def of Object.values(manifest.tools)) {
        if ((typeof def.cell === 'number' && def.cell === cellIndex) ||
            (typeof def.cell === 'string' && def.cell === cellName)) {
          if (def.access === 'rw') return 'rw';
          if (def.access === 'read' || def.access === 'r') return 'read';
          if (def.access === 'private') return 'private';
          break;
        }
      }
    }
    // 2b. Baseline posture set by the manifest's `defaults`.
    const d = manifest.defaults;
    if (d === 'rw') return 'rw';
    if (d === 'read' || d === 'r') return 'read';
    if (d === 'open') return 'open';
    // "private"/"strict"/"none" restore the old opt-in posture (hidden until annotated).
    if (d === 'private' || d === 'strict' || d === 'none') return 'none';
  }

  // 3. Default posture: read-open.
  return 'open';
}

// Is this cell's content visible to the agent? (read / rw / open — anything but
// private or strict-mode 'none'.)
export function readable(access) {
  return access === 'read' || access === 'rw' || access === 'open';
}
