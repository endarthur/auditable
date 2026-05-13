// mcp-adapter.js — Auditable-specific MCP tool registrations
// Registers tools with navigator.modelContext (set up by shim.js).
// All function names prefixed with _mcp to avoid IIFE collisions.
//
// Access control:
//   - No directive: cell hidden from MCP (listed with minimal metadata only)
//   - // %mcp: cell output readable via getCellOutput, source via getCellSource
//   - // %mcp rw: source readable AND writable via updateCellSource
//   - // %private: hard opt-out, overrides everything (invisible unless %mcp describe)

import { S } from './state.js';
import * as hooks from './hooks.js';
import { buildDAG, isManual, isNorun, parseCellName, isPrivate, isMcp, isMcpRw, parseMcpDescribe, isMcpManifest, parseMcpFs } from './dag.js';
import { runDAG, runAll, renderMdCell, renderHtmlCell } from './exec.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable } from './cell-types.js';
import { notifyDirty } from './editor.js';

import { setMsg } from './ui.js';
import { fsWrite, fsRead, validatePath } from './fs.js';
import { setCellCode } from './cell-ops.js';
import { cryptoIsLocked } from './crypto.js';
import { BUILTIN_HELP } from './complete.js';
import { Dialog } from '#dialog';

// ── Locked notebook gating ──

function _mcpRequireUnlocked() {
  if (typeof cryptoIsLocked === 'function' && cryptoIsLocked()) {
    throw new Error('Notebook is encrypted and locked. Enter the passphrase in the browser.');
  }
}

// ── User interaction / confirmation ──

// Per-category auto-accept: 'code' | 'widget' | 'cell' | 'fs'
const _mcpAutoAccept = new Set();

function _mcpConfirm(title, body, category) {
  if (_mcpAutoAccept.has(category)) return Promise.resolve(true);

  return new Dialog({
    title,
    width: 560,
    closable: true,
    backdropDismiss: false,  // explicit reject required
    render(rootBody, ctx) {
      const pre = document.createElement('pre');
      pre.className = 'mcp-confirm-body';
      if (typeof body === 'string') {
        pre.textContent = body;
      } else {
        // DOM fragment (for diff display)
        pre.appendChild(body);
      }
      const actions = document.createElement('div');
      actions.className = 'export-actions';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accent';
      acceptBtn.textContent = 'accept';
      acceptBtn.dataset.default = 'true';
      acceptBtn.onclick = () => ctx.close('accept');

      const acceptAllBtn = document.createElement('button');
      acceptAllBtn.textContent = category ? `accept all ${category}` : 'accept all';
      acceptAllBtn.onclick = () => ctx.close('accept-all');

      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'reject';
      rejectBtn.onclick = () => ctx.close('reject');

      actions.append(acceptBtn, acceptAllBtn, rejectBtn);
      rootBody.append(pre, actions);
    },
  }).show().then((result) => {
    if (result === 'accept') return true;
    if (result === 'accept-all') {
      if (category) _mcpAutoAccept.add(category);
      return true;
    }
    return false;  // 'reject' or null (Esc / × dismiss)
  });
}

function _mcpSimpleDiff(oldText, newText) {
  // Myers-like line diff via LCS edit script
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const frag = document.createDocumentFragment();

  // strip common prefix/suffix to reduce LCS work
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre &&
         oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;

  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);

  // LCS table (only needed for the changed middle)
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // backtrack to build edit ops
  const ops = []; // 'keep'|'del'|'add'
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { i--; j--; ops.push({ op: 'keep', line: a[i] }); }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.push({ op: 'add', line: b[--j] }); }
    else { ops.push({ op: 'del', line: a[--i] }); }
  }
  ops.reverse();

  function addLine(text, cls) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\n';
    frag.appendChild(span);
  }

  // collect hunks with 3-line context
  const CTX = 3;
  const changed = ops.map((o, k) => o.op !== 'keep' ? k : -1).filter(k => k >= 0);
  if (changed.length === 0 && pre === oldLines.length) return frag; // identical

  // merge into hunk ranges
  const hunks = [];
  let hStart = changed[0] ?? 0, hEnd = hStart;
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - hEnd <= CTX * 2) { hEnd = changed[k]; }
    else { hunks.push([hStart, hEnd]); hStart = changed[k]; hEnd = hStart; }
  }
  hunks.push([hStart, hEnd]);

  // context before prefix (show last few unchanged prefix lines)
  const prefixCtxStart = Math.max(0, pre - CTX);
  if (prefixCtxStart > 0 && hunks[0][0] <= CTX) addLine('...', '');
  if (hunks[0][0] <= CTX) {
    for (let k = prefixCtxStart; k < pre; k++) addLine('  ' + oldLines[k], '');
  }

  for (let h = 0; h < hunks.length; h++) {
    const [hs, he] = hunks[h];
    const ctxBefore = Math.max(0, hs - CTX);
    if (h > 0 || hunks[0][0] > CTX) {
      if (ctxBefore > 0) addLine('...', '');
      for (let k = ctxBefore; k < hs; k++) addLine('  ' + ops[k].line, '');
    }
    for (let k = hs; k <= he; k++) {
      if (ops[k].op === 'del') addLine('- ' + ops[k].line, 'mcp-diff-del');
      else if (ops[k].op === 'add') addLine('+ ' + ops[k].line, 'mcp-diff-add');
      else addLine('  ' + ops[k].line, '');
    }
    const ctxAfter = Math.min(ops.length, he + CTX + 1);
    for (let k = he + 1; k < ctxAfter; k++) addLine('  ' + ops[k].line, '');
  }

  // context into suffix
  const lastHunkEnd = hunks[hunks.length - 1][1];
  if (lastHunkEnd >= ops.length - CTX && suf > 0) {
    const suffEnd = Math.min(suf, CTX);
    for (let k = 0; k < suffEnd; k++) addLine('  ' + oldLines[oldLines.length - suf + k], '');
    if (suf > CTX) addLine('...', '');
  }

  return frag;
}

// Reset auto-accept on disconnect + panel refresh handled by onStateChange at bottom

// ── Audit log ──

const _mcpAuditLog = [];
const _MCP_AUDIT_MAX = 100;

function _mcpLogCall(tool, input, result, duration) {
  _mcpAuditLog.push({
    timestamp: new Date().toISOString(),
    tool,
    input,
    result,
    duration,
  });
  if (_mcpAuditLog.length > _MCP_AUDIT_MAX) _mcpAuditLog.shift();
  _mcpRefreshPanel();
}

// Wrap a tool execute to add audit logging + locked gating
function _mcpAudited(name, fn, opts) {
  const skipLockCheck = opts && opts.skipLockCheck;
  return async function(input, client) {
    if (!skipLockCheck) _mcpRequireUnlocked();
    const start = performance.now();
    try {
      const result = await fn(input, client);
      _mcpLogCall(name, input, result, Math.round(performance.now() - start));
      return result;
    } catch (e) {
      _mcpLogCall(name, input, { error: e.message }, Math.round(performance.now() - start));
      throw e;
    }
  };
}

// ── Manifest (Layer 3) ──

let _mcpManifestCode = null;
let _mcpManifestCache = null;
const _mcpManifestToolNames = new Set();

function _mcpGetManifest() {
  const cell = S.cells.find(c => isMcpManifest(c.code));
  if (!cell) {
    _mcpManifestCache = null;
    _mcpManifestCode = null;
    return null;
  }
  if (cell.code === _mcpManifestCode) return _mcpManifestCache;
  _mcpManifestCode = cell.code;
  const body = cell.code.replace(/^\s*\/\/\s*%mcp\s+manifest\b[^\n]*/m, '').trim();
  try {
    _mcpManifestCache = new Function('return (' + body + ')')();
  } catch (e) {
    console.error('[mcp] manifest eval error:', e);
    _mcpManifestCache = null;
  }
  return _mcpManifestCache;
}

function _mcpResolveManifestCell(ref) {
  if (typeof ref === 'number') {
    if (ref < 0 || ref >= S.cells.length) return null;
    return { cell: S.cells[ref], index: ref };
  }
  if (typeof ref === 'string') {
    for (let i = 0; i < S.cells.length; i++) {
      const name = parseCellName(S.cells[i].code);
      if (name === ref) return { cell: S.cells[i], index: i };
    }
  }
  return null;
}

// ── Access control helpers ──

function _mcpCellAccess(cell) {
  // Returns: 'private' | 'rw' | 'read' | 'none'
  // Precedence: cell directives > manifest tool-level > manifest defaults > none
  const code = cell.code || '';

  // 1. Explicit cell directives (highest priority)
  if (isPrivate(code)) return 'private';
  if (isMcpRw(code)) return 'rw';
  if (isMcp(code)) return 'read';
  if (isMcpManifest(code)) return 'private'; // manifest cell itself

  // 2. Manifest overrides
  const manifest = _mcpGetManifest();
  if (manifest) {
    // 2a. Tool-level access
    if (manifest.tools) {
      const idx = S.cells.indexOf(cell);
      const name = parseCellName(code);
      for (const def of Object.values(manifest.tools)) {
        if ((typeof def.cell === 'number' && def.cell === idx) ||
            (typeof def.cell === 'string' && def.cell === name)) {
          if (def.access === 'rw') return 'rw';
          if (def.access === 'read' || def.access === 'r') return 'read';
          if (def.access === 'private') return 'private';
          break;
        }
      }
    }
    // 2b. Default access level
    const d = manifest.defaults;
    if (d === 'rw') return 'rw';
    if (d === 'read' || d === 'r') return 'read';
    if (d === 'private') return 'private';
  }

  return 'none';
}

function _mcpRequireRead(input) {
  const { cell, index } = _mcpResolveCell(input);
  const access = _mcpCellAccess(cell);
  if (access === 'private') {
    throw new Error(`Cell ${index} is marked // %private and cannot be accessed via MCP.`);
  }
  if (access === 'none') {
    throw new Error(`Cell ${index} is not exposed to MCP. Add // %mcp to the cell, or use a manifest cell with defaults: "read". Use listCells to see accessible cells.`);
  }
  return { cell, index, access };
}

function _mcpRequireWrite(input) {
  const { cell, index } = _mcpResolveCell(input);
  const access = _mcpCellAccess(cell);
  if (access === 'private') {
    throw new Error(`Cell ${index} is marked // %private and cannot be modified via MCP.`);
  }
  if (access === 'none') {
    throw new Error(`Cell ${index} is not exposed to MCP. Add // %mcp rw to the cell, or use a manifest cell with defaults: "rw". Use listCells to see accessible cells.`);
  }
  if (access === 'read') {
    throw new Error(`Cell ${index} is marked // %mcp (read-only). Change to // %mcp rw to allow source editing. Use listCells to see access levels.`);
  }
  return { cell, index, access };
}

// ── Manifest custom tools ──

async function _mcpManifestToolExecute(toolDef, input) {
  const resolved = _mcpResolveManifestCell(toolDef.cell);
  if (!resolved) throw new Error(`Manifest tool: cell "${toolDef.cell}" not found`);
  const { cell, index } = resolved;
  const access = _mcpCellAccess(cell);

  if (access === 'private' || access === 'none') {
    throw new Error(`Cell ${index} is not accessible via MCP (access: ${access})`);
  }

  // Optional source update (requires rw)
  if (input.code !== undefined) {
    if (access !== 'rw') throw new Error(`Cell ${index} is read-only. Cannot update source.`);
    const accepted = await _mcpConfirm(
      `Update cell ${index}`,
      _mcpSimpleDiff(cell.code || '', input.code),
      'code'
    );
    if (!accepted) throw new Error('User rejected the change.');
    setCellCode(cell, input.code);
    clearTimeout(S.editTimer);
    notifyDirty();
  }

  // Run the cell
  await runDAG([cell.id], true);

  // Return output
  return _mcpGetCellOutput({ index: index, format: input.format, path: input.path });
}

function _mcpRegisterManifestTools() {
  if (!navigator.modelContext) return;
  // Unregister previous manifest tools
  for (const name of _mcpManifestToolNames) {
    navigator.modelContext.unregisterTool(name);
  }
  _mcpManifestToolNames.clear();

  const manifest = _mcpGetManifest();
  if (!manifest || !manifest.tools) return;

  for (const [name, def] of Object.entries(manifest.tools)) {
    if (!def.cell && def.cell !== 0) continue;
    const resolved = _mcpResolveManifestCell(def.cell);
    const access = resolved ? _mcpCellAccess(resolved.cell) : 'none';
    const writable = access === 'rw';

    const props = {
      format: { type: 'string', enum: ['summary', 'full', 'schema'], description: 'Output detail level (default: summary)' },
      path: { type: 'string', description: 'Dot-notation path into output' },
    };
    if (writable) {
      props.code = { type: 'string', description: 'Optional: update cell source before running' };
    }

    navigator.modelContext.registerTool({
      name,
      description: def.describe || `Run cell "${def.cell}" and return its output`,
      inputSchema: { type: 'object', properties: props },
      annotations: writable
        ? { title: name }
        : { readOnlyHint: true, idempotentHint: true, title: name },
      execute: _mcpAudited(name, (input) => _mcpManifestToolExecute(def, input)),
    });
    _mcpManifestToolNames.add(name);
  }
}

// ── FS access policy ──

function _mcpGetFsPolicy() {
  // Collect allowed prefixes from %mcp fs directives across all cells
  const rules = [];
  for (const c of S.cells) {
    const fs = parseMcpFs(c.code);
    if (fs) rules.push(fs);
  }
  // Also check manifest
  const manifest = _mcpGetManifest();
  if (manifest && manifest.fs) {
    if (typeof manifest.fs === 'string') {
      rules.push({ prefix: manifest.fs === '*' ? '' : manifest.fs, readOnly: false });
    } else if (manifest.fs.prefix !== undefined) {
      rules.push({ prefix: manifest.fs.prefix === '*' ? '' : manifest.fs.prefix, readOnly: !!manifest.fs.readOnly });
    }
  }
  return rules;
}

function _mcpCheckFsRead(path) {
  const rules = _mcpGetFsPolicy();
  if (rules.length === 0) {
    throw new Error('No // %mcp fs directive found. Add // %mcp fs <prefix> to a cell, or fs config to a manifest cell, to allow filesystem access.');
  }
  const ok = rules.some(r => path.startsWith(r.prefix));
  if (!ok) {
    throw new Error(`Path "${path}" is outside allowed prefixes: ${rules.map(r => r.prefix || '*').join(', ')}`);
  }
}

function _mcpCheckFsWrite(path) {
  const rules = _mcpGetFsPolicy();
  if (rules.length === 0) {
    throw new Error('No // %mcp fs directive found. Add // %mcp fs <prefix> to a cell, or fs config to a manifest cell, to allow filesystem access.');
  }
  const matching = rules.filter(r => path.startsWith(r.prefix));
  if (matching.length === 0) {
    throw new Error(`Path "${path}" is outside allowed prefixes: ${rules.map(r => r.prefix || '*').join(', ')}`);
  }
  if (matching.every(r => r.readOnly)) {
    throw new Error(`Path "${path}" is under a read-only prefix. Use // %mcp fs (without :read) to allow writes.`);
  }
}

// ── General helpers ──

function _mcpCollectErrors() {
  const errors = [];
  for (let i = 0; i < S.cells.length; i++) {
    const c = S.cells[i];
    if (!c.error) continue;
    const access = _mcpCellAccess(c);
    // Don't leak error details from private/none cells
    if (access === 'private' || access === 'none') {
      errors.push({ index: i, message: 'cell has an error (details hidden — cell is not MCP-accessible)' });
    } else {
      errors.push({
        index: i,
        cellName: parseCellName(c.code) || undefined,
        message: c.error,
      });
    }
  }
  return errors;
}

// Apply search-and-replace patches to source code. Pure function, testable.
function _mcpApplyPatches(source, patches) {
  let result = source;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (typeof p.old !== 'string' || typeof p.new !== 'string') {
      throw new Error(`Patch ${i}: old and new must be strings`);
    }
    const pos = result.indexOf(p.old);
    if (pos === -1) throw new Error(`Patch ${i}: old string not found in cell source`);
    result = result.slice(0, pos) + p.new + result.slice(pos + p.old.length);
  }
  return result;
}

function _mcpResolveCell(input) {
  const idx = Number(input.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= S.cells.length) {
    throw new Error(`Invalid index: ${input.index}. Notebook has ${S.cells.length} cells (0-based).`);
  }
  return { cell: S.cells[idx], index: idx };
}

function _mcpDrillPath(obj, path) {
  if (!path) return obj;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function _mcpSerialize(value, format, opts) {
  format = format || 'summary';
  opts = opts || {};

  if (value === undefined) return { type: 'undefined', value: undefined };
  if (value === null) return { type: 'null', value: null };

  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') {
    if (t === 'string' && format === 'summary' && value.length > 500) {
      return { type: 'string', length: value.length, preview: value.slice(0, 500) + '...' };
    }
    return { type: t, value: value };
  }

  if (t === 'function') return { type: 'function', name: value.name || '(anonymous)' };

  // TypedArrays
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const typeName = value.constructor.name;
    if (format === 'schema') return { type: typeName, length: value.length };
    const arr = Array.from(value);
    return _mcpSerializeArray(arr, typeName, format, opts);
  }

  // Arrays
  if (Array.isArray(value)) {
    return _mcpSerializeArray(value, 'Array', format, opts);
  }

  // DOM elements
  if (value instanceof Element || (value && value.nodeType === 1)) {
    return { type: 'Element', tag: value.tagName?.toLowerCase(), textContent: (value.textContent || '').slice(0, 200) };
  }

  // Objects (plain-ish)
  if (t === 'object') {
    return _mcpSerializeObject(value, format, opts);
  }

  return { type: t, value: String(value) };
}

function _mcpSerializeArray(arr, typeName, format, opts) {
  const len = arr.length;
  const offset = opts.offset || 0;
  const limit = opts.limit || (format === 'full' ? len : undefined);

  if (format === 'schema') return { type: typeName, length: len };

  if (format === 'summary') {
    const preview = {};
    preview.type = typeName;
    preview.length = len;
    if (len <= 10) {
      preview.data = arr;
    } else {
      preview.first5 = arr.slice(0, 5);
      preview.last5 = arr.slice(-5);
    }
    return preview;
  }

  // full
  const sliced = limit ? arr.slice(offset, offset + limit) : arr.slice(offset);
  const result = { type: typeName, length: len, offset: offset, data: sliced };
  // cap at ~64KB
  const json = JSON.stringify(result);
  if (json && json.length > 65536) {
    const perItem = json.length / sliced.length;
    const maxItems = Math.floor(65536 / perItem);
    result.data = sliced.slice(0, Math.max(1, maxItems));
    result.truncated = true;
    result.message = `Output truncated to ${result.data.length} of ${len} items (64KB limit)`;
  }
  return result;
}

function _mcpSerializeObject(obj, format, opts) {
  const keys = Object.keys(obj);

  if (format === 'schema') {
    const schema = {};
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) schema[k] = { type: 'Array', length: v.length };
      else if (ArrayBuffer.isView(v)) schema[k] = { type: v.constructor.name, length: v.length };
      else schema[k] = { type: typeof v };
    }
    return { type: 'object', keys: keys.length, schema };
  }

  if (format === 'summary') {
    const summary = {};
    for (const k of keys.slice(0, 20)) {
      summary[k] = _mcpSerialize(obj[k], 'summary', {});
    }
    if (keys.length > 20) summary['...'] = `${keys.length - 20} more keys`;
    return { type: 'object', keys: keys.length, data: summary };
  }

  // full — try JSON.stringify with circular ref protection
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(obj, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
      return val;
    });
    if (json && json.length > 65536) {
      return { type: 'object', keys: keys.length, message: 'Object too large for full format. Use format:"summary" or path parameter.', preview: json.slice(0, 500) };
    }
    return JSON.parse(json);
  } catch (e) {
    return { type: 'object', keys: keys.length, error: 'Cannot serialize: ' + e.message };
  }
}

// ── Tool: listCells ──

function _mcpListCells() {
  // Invalidate manifest cache so edits take effect
  _mcpManifestCode = null;

  const manifest = _mcpGetManifest();
  const hasMcpCells = S.cells.some(c => {
    const a = _mcpCellAccess(c);
    return a === 'read' || a === 'rw';
  });

  const cells = S.cells.map((c, i) => {
    const access = _mcpCellAccess(c);
    const entry = {
      index: i,
      type: c.type,
      access: access,
    };

    // manifest cell: mark it
    if (isMcpManifest(c.code)) {
      entry.manifest = true;
      return entry;
    }

    // private: only show %mcp describe metadata
    if (access === 'private') {
      const desc = parseMcpDescribe(c.code);
      if (desc) entry.description = desc;
      return entry;
    }

    // no directives and no manifest defaults: effectively private
    if (access === 'none') {
      return entry;
    }

    // readable or writable: full info
    const name = parseCellName(c.code);
    if (name) entry.name = name;
    const desc = parseMcpDescribe(c.code);
    if (desc) entry.description = desc;
    entry.collapsed = c.collapsed || false;
    if (c.type === 'code') {
      if (isManual(c.code)) entry.manual = true;
      if (isNorun(c.code)) entry.norun = true;
    }
    if (c.defines && c.defines.size > 0) entry.defines = [...c.defines];
    if (c.error) entry.error = c.error;
    return entry;
  });

  const result = { cells };

  if (manifest) {
    result.manifest = {
      defaults: manifest.defaults || null,
      customTools: manifest.tools ? Object.keys(manifest.tools) : [],
    };
  } else if (!hasMcpCells) {
    result.hint = 'No cells have // %mcp directives and no manifest cell found. Add // %mcp (read-only) or // %mcp rw (read-write) to cells, or create a manifest cell with // %mcp manifest.';
  }

  // Re-register manifest tools in case manifest changed
  _mcpRegisterManifestTools();

  return result;
}

// ── Tool: getCellOutput ──

function _mcpGetCellOutput(input) {
  const { cell, index } = _mcpRequireRead(input);
  const format = input.format || 'summary';

  let value;
  if (cell.type === 'code') {
    if (cell._lastResult && Object.keys(cell._lastResult).length > 0) {
      value = Object.keys(cell._lastResult).length === 1
        ? Object.values(cell._lastResult)[0]
        : cell._lastResult;
    } else {
      const outEl = cell.el?.querySelector('.cell-output');
      value = outEl ? outEl.textContent : null;
    }
  } else if (cell.type === 'html') {
    value = cell._inputs ? { ...cell._inputs } : null;
  } else if (cell.type === 'md') {
    const viewEl = cell.el?.querySelector('.cell-md-view');
    value = viewEl ? viewEl.textContent : null;
  } else if (cell.type === 'css') {
    value = cell.code;
  } else {
    // plugin cell type
    if (cell._lastResult && Object.keys(cell._lastResult).length > 0) {
      value = Object.keys(cell._lastResult).length === 1
        ? Object.values(cell._lastResult)[0]
        : cell._lastResult;
    } else {
      const outEl = cell.el?.querySelector('.cell-output');
      value = outEl ? outEl.textContent : null;
    }
  }

  if (input.path) {
    value = _mcpDrillPath(value, input.path);
  }

  return _mcpSerialize(value, format, { offset: input.offset, limit: input.limit });
}

// ── Tool: getCellSource ──

function _mcpGetCellSource(input) {
  const { cell } = _mcpRequireRead(input);
  return { source: cell.code, type: cell.type };
}

// ── Tool: getCellScreenshot ──

async function _mcpGetCellScreenshot(input) {
  const { cell } = _mcpRequireRead(input);
  const maxW = input.maxWidth || 800;
  const maxH = input.maxHeight || 600;

  // try canvas first
  const canvas = cell.el?.querySelector('.cell-output canvas');
  if (canvas) {
    let w = canvas.width, h = canvas.height;
    if (w > maxW || h > maxH) {
      const scale = Math.min(maxW / w, maxH / h);
      const resized = document.createElement('canvas');
      resized.width = Math.round(w * scale);
      resized.height = Math.round(h * scale);
      const ctx = resized.getContext('2d');
      ctx.drawImage(canvas, 0, 0, resized.width, resized.height);
      return { image: resized.toDataURL('image/png'), width: resized.width, height: resized.height };
    }
    return { image: canvas.toDataURL('image/png'), width: w, height: h };
  }

  // fallback: text content of output
  const outEl = cell.el?.querySelector('.cell-output') || cell.el?.querySelector('.cell-html-view') || cell.el?.querySelector('.cell-md-view');
  if (outEl) {
    return { text: (outEl.textContent || '').slice(0, 2000), message: 'No canvas found. Returning text content instead.' };
  }

  return { error: 'No visible output for this cell.' };
}

// ── Tool: updateCellSource ──

async function _mcpUpdateCellSource(input, client) {
  const { cell, index } = _mcpRequireWrite(input);

  let newCode;
  if (input.patches) {
    // Patch mode: apply search-and-replace pairs
    let patches = input.patches;
    if (typeof patches === 'string') { try { patches = JSON.parse(patches); } catch (e) { throw new Error('patches must be a JSON array of {old, new} objects'); } }
    if (!Array.isArray(patches)) throw new Error('patches must be an array of {old, new} objects');
    input.patches = patches;
    newCode = _mcpApplyPatches(cell.code || '', input.patches);
  } else if (typeof input.code === 'string') {
    // Full replacement mode
    newCode = input.code;
  } else {
    throw new Error('Provide either code (full replacement) or patches (array of {old, new})');
  }

  // Show diff confirmation
  const oldCode = cell.code || '';
  const accepted = await _mcpConfirm(
    `Update cell ${index}` + (parseCellName(cell.code) ? ` (${parseCellName(cell.code)})` : ''),
    _mcpSimpleDiff(oldCode, newCode),
    'code'
  );
  if (!accepted) throw new Error('User rejected the change.');

  setCellCode(cell, newCode);

  // bypass the 400ms debounce — run immediately
  clearTimeout(S.editTimer);
  notifyDirty();

  if (S.autorun && (cell.type === 'md' || _ctIsExecutable(cell.type))) {
    await runDAG([cell.id], false);
  }

  return {
    ok: true,
    autorun: S.autorun,
    errors: _mcpCollectErrors(),
  };
}

// ── Tool: addCell ──

async function _mcpAddCell(input) {
  const type = input.type;
  const validTypes = ['code', 'md', 'css', 'html', ...Object.keys(window._cellTypes || {})];
  if (!validTypes.includes(type)) {
    throw new Error('type must be one of: ' + validTypes.join(', '));
  }
  const code = input.code || '';
  const pos = input.position;

  // Show confirmation
  const posLabel = typeof pos === 'number' ? `at index ${pos}` : 'at end';
  const preview = code.length > 200 ? code.slice(0, 200) + '...' : code;
  const accepted = await _mcpConfirm(
    `Add ${type} cell ${posLabel}`,
    preview || '(empty cell)',
    'cell'
  );
  if (!accepted) throw new Error('User rejected cell creation.');

  let afterId = null;
  if (typeof pos === 'number' && pos >= 0 && pos < S.cells.length) {
    if (pos > 0) afterId = S.cells[pos - 1].id;
    else {
      const cell = addCell(type, code, null, S.cells[0]?.id ?? null);
      return { index: 0, type: cell.type };
    }
  } else if (S.cells.length > 0) {
    afterId = S.cells[S.cells.length - 1].id;
  }

  const cell = addCell(type, code, afterId);
  const newIndex = S.cells.findIndex(c => c.id === cell.id);
  return { index: newIndex, type: cell.type };
}

// ── Tool: getDAG ──

function _mcpGetDAG() {
  const allDefined = buildDAG();
  const edges = [];
  for (const c of S.cells) {
    if (!c.uses) continue;
    for (const name of c.uses) {
      const sourceId = allDefined.get(name);
      if (sourceId === undefined) continue;
      const fromIdx = S.cells.findIndex(x => x.id === sourceId);
      const toIdx = S.cells.indexOf(c);
      if (fromIdx >= 0 && toIdx >= 0) {
        edges.push({ from: fromIdx, to: toIdx, variable: name });
      }
    }
  }

  return {
    cells: S.cells.map((c, i) => {
      const access = _mcpCellAccess(c);
      const entry = { index: i, type: c.type };
      // Only expose defines/uses for accessible cells
      if (access === 'read' || access === 'rw') {
        entry.defines = c.defines?.size > 0 ? [...c.defines] : [];
        entry.uses = c.uses?.size > 0 ? [...c.uses] : [];
      }
      return entry;
    }),
    edges: edges.filter(e => {
      // Only show edges where both endpoints are accessible
      const fromAccess = _mcpCellAccess(S.cells[e.from]);
      const toAccess = _mcpCellAccess(S.cells[e.to]);
      return (fromAccess === 'read' || fromAccess === 'rw') &&
             (toAccess === 'read' || toAccess === 'rw');
    }),
  };
}

// ── Tool: getNotebookStatus ──

function _mcpGetNotebookStatus() {
  const locked = typeof cryptoIsLocked === 'function' && cryptoIsLocked();
  return {
    title: document.getElementById('docTitle')?.value || 'untitled',
    cellCount: S.cells.length,
    autorun: S.autorun,
    locked,
    errorCount: S.cells.filter(c => c.error).length,
    errors: _mcpCollectErrors(),
  };
}

// ── Tool: getNotebookContext ──

function _mcpGetNotebookContext() {
  buildDAG();
  const cellList = _mcpListCells();

  // Include source for accessible cells, filter defines to non-private
  const accessibleDefines = [];
  for (const entry of cellList.cells) {
    const access = entry.access;
    if (access === 'read' || access === 'rw') {
      const cell = S.cells[entry.index];
      entry.source = cell.code;
      if (entry.defines) {
        for (const d of entry.defines) accessibleDefines.push(d);
      }
    }
  }

  return {
    title: document.getElementById('docTitle')?.value || 'untitled',
    cellCount: S.cells.length,
    autorun: S.autorun,
    cells: cellList,
    defines: accessibleDefines,
    errors: _mcpCollectErrors(),
  };
}

// ── Tool: getDocumentation ──

function _mcpGetDocumentation(input) {
  const topics = {};
  // Builtins help (injected at build time)
  for (const [k, v] of Object.entries(BUILTIN_HELP)) topics[k] = v;
  // Tagged language extensions
  if (window._taggedLanguages) {
    for (const [lang, ext] of Object.entries(window._taggedLanguages)) {
      topics[`lang:${lang}`] = {
        syntax: `Tagged language extension: ${lang}`,
        description: ext.description || `Use \`${lang}\` tagged template literals`,
      };
    }
  }
  // notebook.fs
  topics['notebook.fs'] = {
    syntax: 'notebook.fs.write(path, content) / notebook.fs.read(path) / notebook.fs.list()',
    description: 'Embedded filesystem stored in the notebook HTML. Files persist across saves. Supports text, binary, JSON, canvas, and ImageData. Auto-compresses with gzip. Use fs: scheme with load() to import JS modules from the filesystem.',
  };

  if (input.topic) {
    const entry = topics[input.topic];
    return entry ? { topic: input.topic, ...entry } : { error: `No documentation for "${input.topic}"` };
  }
  return { topics: Object.keys(topics) };
}

// ── Registration ──

// Only register MCP tools when connected via our shim (bridge mode).
// Native browser WebMCP (navigator.modelContext without our shim) is gated
// behind a future settings flag to prevent unintended tool exposure.
if (navigator.modelContext && window.__auditable_mcp) {
  const ro = { readOnlyHint: true, idempotentHint: true };

  navigator.modelContext.registerTool({
    name: 'listCells',
    description: 'List all cells in the notebook with their index, type, name, MCP access level, and error state. Cells without // %mcp directives are listed with minimal metadata. Cells with // %private show only if they have // %mcp describe.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...ro, title: 'List cells' },
    execute: _mcpAudited('listCells', async () => _mcpListCells()),
  });

  navigator.modelContext.registerTool({
    name: 'getCellSource',
    description: 'Get the source code of a cell. Only works on cells with // %mcp or // %mcp rw directives. Use listCells to see which cells are accessible.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index (use listCells to find)' },
      },
      required: ['index'],
    },
    annotations: { ...ro, title: 'Get cell source' },
    execute: _mcpAudited('getCellSource', async (input) => _mcpGetCellSource(input)),
  });

  navigator.modelContext.registerTool({
    name: 'getCellOutput',
    description: 'Get the output/result of a cell. Only works on cells with // %mcp or // %mcp rw. For code cells returns structured scope values. Supports format (summary/full/schema), dot-notation path for nested data, and offset/limit for array slicing.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index' },
        format: { type: 'string', enum: ['summary', 'full', 'schema'], description: 'Output detail level (default: summary)' },
        path: { type: 'string', description: 'Dot-notation path to drill into output (e.g. "data.0.grade")' },
        offset: { type: 'integer', description: 'Start index for array slicing' },
        limit: { type: 'integer', description: 'Max items for array slicing' },
      },
      required: ['index'],
    },
    annotations: { ...ro, title: 'Get cell output' },
    execute: _mcpAudited('getCellOutput', async (input) => _mcpGetCellOutput(input)),
  });

  navigator.modelContext.registerTool({
    name: 'updateCellSource',
    description: 'Update a cell\'s source code. Two modes: (1) full replacement with "code", (2) surgical edits with "patches" — an array of {old, new} search-and-replace pairs. Prefer patches for small changes to save tokens. Only works on cells with // %mcp rw.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index' },
        code: { type: 'string', description: 'Full replacement source code' },
        patches: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] }, description: 'Array of {old, new} search-and-replace pairs (applied in order)' },
      },
      required: ['index'],
    },
    annotations: { destructiveHint: true, title: 'Update cell source' },
    execute: _mcpAudited('updateCellSource', _mcpUpdateCellSource),
  });

  navigator.modelContext.registerTool({
    name: 'addCell',
    description: 'Add a new cell to the notebook. Requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['code', 'md', 'css', 'html'], description: 'Cell type' },
        code: { type: 'string', description: 'Initial source code (default: empty)' },
        position: { type: 'integer', description: 'Insert at this index (default: end)' },
      },
      required: ['type'],
    },
    annotations: { destructiveHint: true, title: 'Add cell' },
    execute: _mcpAudited('addCell', _mcpAddCell),
  });

  navigator.modelContext.registerTool({
    name: 'getCellScreenshot',
    description: 'Capture a cell\'s visual output. For canvas elements returns a PNG image. For other output returns text content. Only works on cells with // %mcp or // %mcp rw.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index' },
        maxWidth: { type: 'integer', description: 'Max width in pixels (default 800)' },
        maxHeight: { type: 'integer', description: 'Max height in pixels (default 600)' },
      },
      required: ['index'],
    },
    annotations: { ...ro, title: 'Capture cell output' },
    execute: _mcpAudited('getCellScreenshot', async (input) => _mcpGetCellScreenshot(input)),
  });

  navigator.modelContext.registerTool({
    name: 'runCell',
    description: 'Execute a specific cell and its downstream dependents.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index' },
      },
      required: ['index'],
    },
    annotations: { title: 'Run cell' },
    execute: _mcpAudited('runCell', async (input) => {
      const { cell } = _mcpRequireRead(input);
      await runDAG([cell.id], true);
      return { ok: true, errors: _mcpCollectErrors() };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'setWidgetValue',
    description: 'Set the value of a widget (slider, dropdown, checkbox, text-input) in a cell. Triggers reactive re-execution or callback, same as user interaction. Requires user confirmation. Use getCellOutput to read current widget values.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0-based cell index' },
        name: { type: 'string', description: 'Widget name attribute' },
        value: { description: 'New value (number for sliders, string for dropdowns/text, boolean for checkboxes)' },
      },
      required: ['index', 'name', 'value'],
    },
    annotations: { destructiveHint: true, title: 'Set widget value' },
    execute: _mcpAudited('setWidgetValue', async (input) => {
      const { cell } = _mcpRequireWrite(input);
      const widget = cell.el?.querySelector(`audit-slider[name="${input.name}"], audit-dropdown[name="${input.name}"], audit-checkbox[name="${input.name}"], audit-text-input[name="${input.name}"]`);
      if (!widget) throw new Error(`Widget "${input.name}" not found in cell ${S.cells.indexOf(cell)}`);

      const oldValue = widget.value;
      const accepted = await _mcpConfirm(
        `Set widget "${input.name}"`,
        `${oldValue} \u2192 ${input.value}`,
        'widget'
      );
      if (!accepted) throw new Error('User rejected the change.');

      widget.value = input.value;
      // Dispatch events to trigger reactive system / callbacks
      widget.dispatchEvent(new Event('input', { bubbles: true }));
      widget.dispatchEvent(new Event('change', { bubbles: true }));

      return { ok: true, name: input.name, oldValue, newValue: widget.value };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'runAll',
    description: 'Execute all cells in the notebook.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Run all cells' },
    execute: _mcpAudited('runAll', async () => {
      await runAll();
      return { ok: true, errors: _mcpCollectErrors() };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'getDAG',
    description: 'Get the dependency graph: which cells define and use which variables, and the edges between them.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...ro, title: 'Get dependency graph' },
    execute: _mcpAudited('getDAG', async () => _mcpGetDAG()),
  });

  navigator.modelContext.registerTool({
    name: 'getNotebookStatus',
    description: 'Get notebook status: title, cell count, autorun mode, and all errors.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...ro, title: 'Get notebook status' },
    execute: _mcpAudited('getNotebookStatus', async () => _mcpGetNotebookStatus(), { skipLockCheck: true }),
  });

  navigator.modelContext.registerTool({
    name: 'pauseAutorun',
    description: 'Pause reactive execution. Use before making multiple cell edits to avoid intermediate re-runs. Call resumeAutorun when done.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Pause autorun' },
    execute: _mcpAudited('pauseAutorun', async () => {
      S.autorun = false;
      const btn = document.getElementById('autorunBtn');
      if (btn) { btn.textContent = '\u2016'; btn.className = 'autorun-off'; }
      const btnMobile = document.getElementById('autorunBtnMobile');
      if (btnMobile) { btnMobile.textContent = '\u2016'; btnMobile.className = 'autorun-off'; }
      window.auditable?.hooks?.emit("notebook:dirty");
      return { autorun: false };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'resumeAutorun',
    description: 'Resume reactive execution and run all cells to flush accumulated changes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Resume autorun' },
    execute: _mcpAudited('resumeAutorun', async () => {
      S.autorun = true;
      const btn = document.getElementById('autorunBtn');
      if (btn) { btn.textContent = '\u25b6'; btn.className = 'autorun-on'; }
      const btnMobile = document.getElementById('autorunBtnMobile');
      if (btnMobile) { btnMobile.textContent = '\u25b6'; btnMobile.className = 'autorun-on'; }
      window.auditable?.hooks?.emit("notebook:dirty");
      await runAll();
      return { autorun: true, errors: _mcpCollectErrors() };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'getDocumentation',
    description: 'Get documentation for Auditable builtins (ui, std, load, install, etc.). Call without topic to list all available topics.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Specific builtin name (e.g. "ui.canvas", "std.csv", "load"). Omit to list all topics.' },
      },
    },
    annotations: { ...ro, title: 'Get documentation' },
    execute: _mcpAudited('getDocumentation', async (input) => _mcpGetDocumentation(input), { skipLockCheck: true }),
  });

  navigator.modelContext.registerTool({
    name: 'getNotebookContext',
    description: 'Quick orientation: returns title, cell count, all cells with their MCP access levels, all scope variables, and autorun state. Use as your first call to understand a notebook.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...ro, title: 'Get notebook context' },
    execute: _mcpAudited('getNotebookContext', async () => _mcpGetNotebookContext()),
  });

  navigator.modelContext.registerTool({
    name: 'getAuditLog',
    description: 'Get the recent MCP tool call audit log. Returns the last 100 tool invocations with timestamps, inputs, results, and duration.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max entries to return (default: 20, max: 100)' },
      },
    },
    annotations: { ...ro, title: 'Get audit log' },
    execute: _mcpAudited('getAuditLog', async (input) => {
      const n = Math.min(input.limit || 20, _MCP_AUDIT_MAX);
      return { entries: _mcpAuditLog.slice(-n) };
    }),
  });

  // ── notebook.fs tools ──

  navigator.modelContext.registerTool({
    name: 'fsList',
    description: 'List files in the notebook embedded filesystem. Supports glob patterns (*.csv, data/**), prefix matching (data/), or no argument for all files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, prefix (ending with /), or omit for all files' },
      },
    },
    annotations: { ...ro, title: 'List embedded files' },
    execute: _mcpAudited('fsList', async (input) => {
      const rules = _mcpGetFsPolicy();
      if (rules.length === 0) throw new Error('No // %mcp fs directive found. Add // %mcp fs <prefix> to a cell to allow filesystem access.');
      const fs = window._notebookFS;
      if (!fs || fs.size === 0) return { files: [], totalSize: 0 };
      const nfs = window._notebook?.fs;
      if (!nfs) return { error: 'notebook.fs not available' };
      // Filter results to allowed prefixes
      let files = nfs.list(input.pattern);
      files = files.filter(f => rules.some(r => f.path.startsWith(r.prefix)));
      return { files, totalSize: nfs.size };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'fsRead',
    description: 'Read a file from the notebook embedded filesystem. Returns text for text files, base64 for binary. Use fsList to see available files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path in the embedded filesystem' },
        format: { type: 'string', enum: ['text', 'json', 'binary'], description: 'Output format (default: auto based on MIME type)' },
      },
      required: ['path'],
    },
    annotations: { ...ro, title: 'Read embedded file' },
    execute: _mcpAudited('fsRead', async (input) => {
      _mcpCheckFsRead(input.path);
      const fmt = input.format || undefined;
      const result = await fsRead(input.path, fmt);
      if (result instanceof Uint8Array) {
        // binary: return base64
        const b64 = btoa(String.fromCharCode(...result));
        return { format: 'base64', data: b64, size: result.length };
      }
      return { format: typeof result === 'object' ? 'json' : 'text', data: result };
    }),
  });

  navigator.modelContext.registerTool({
    name: 'fsWrite',
    description: 'Write a file to the notebook embedded filesystem. Requires user confirmation. Content is a string (text) or base64 (binary, set binary:true).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (e.g. "data/input.csv")' },
        content: { type: 'string', description: 'File content (text or base64-encoded binary)' },
        binary: { type: 'boolean', description: 'If true, content is base64-encoded binary data' },
        type: { type: 'string', description: 'MIME type override (e.g. "text/csv")' },
      },
      required: ['path', 'content'],
    },
    annotations: { destructiveHint: true, title: 'Write embedded file' },
    execute: _mcpAudited('fsWrite', async (input) => {
      _mcpCheckFsWrite(input.path);
      validatePath(input.path);
      const preview = input.binary
        ? `[binary, ${input.content.length} chars base64]`
        : (input.content.length > 200 ? input.content.slice(0, 200) + '...' : input.content);
      const accepted = await _mcpConfirm(`Write file: ${input.path}`, preview, 'fs');
      if (!accepted) throw new Error('User rejected fs write.');

      let data = input.content;
      if (input.binary) {
        data = Uint8Array.from(atob(input.content), c => c.charCodeAt(0));
      }
      return await fsWrite(input.path, data, input.type ? { type: input.type } : {});
    }),
  });

  navigator.modelContext.registerTool({
    name: 'fsDelete',
    description: 'Delete a file or folder from the notebook embedded filesystem. Requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path or folder prefix' },
        recursive: { type: 'boolean', description: 'Required for folder deletion' },
      },
      required: ['path'],
    },
    annotations: { destructiveHint: true, title: 'Delete embedded file' },
    execute: _mcpAudited('fsDelete', async (input) => {
      _mcpCheckFsWrite(input.path);
      const accepted = await _mcpConfirm(`Delete: ${input.path}`, input.recursive ? '(recursive)' : '', 'fs');
      if (!accepted) throw new Error('User rejected fs delete.');
      const nfs = window._notebook?.fs;
      if (!nfs) throw new Error('notebook.fs not available');
      const result = await nfs.delete(input.path, { recursive: !!input.recursive });
      return { deleted: result };
    }),
  });

  // Register custom tools from manifest (if present)
  _mcpRegisterManifestTools();
}

// ── MCP panel UI ──

function _mcpShowFullLog(title, text) {
  // Create a temporary overlay (don't reuse confirm overlay — it has pending state)
  let overlay = document.getElementById('mcpLogOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'mcpLogOverlay';
    overlay.className = 'export-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  overlay.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'export-panel mcp-confirm-panel';
  const h = document.createElement('div');
  h.className = 'mcp-confirm-title';
  h.textContent = title;
  box.appendChild(h);
  const pre = document.createElement('pre');
  pre.className = 'mcp-log-full-pre';
  pre.textContent = text;
  box.appendChild(pre);
  const btns = document.createElement('div');
  btns.className = 'mcp-confirm-btns';
  const close = document.createElement('button');
  close.textContent = 'close';
  close.onclick = () => { overlay.style.display = 'none'; };
  btns.appendChild(close);
  box.appendChild(btns);
  overlay.appendChild(box);
}

function _mcpLogSection(frag, label, text, isErr) {
  const LIMIT = 2000;
  const sec = document.createElement('div');
  sec.className = 'mcp-log-section';
  const truncated = text.length > LIMIT;
  sec.innerHTML = `<span class="mcp-log-label">${label}</span>`;
  const pre = document.createElement('pre');
  pre.textContent = truncated ? text.slice(0, LIMIT) + '\u2026' : text;
  if (isErr) pre.className = 'mcp-log-err';
  sec.appendChild(pre);
  if (truncated) {
    const btn = document.createElement('button');
    btn.className = 'mcp-log-expand';
    btn.textContent = 'show full';
    btn.onclick = (e) => { e.stopPropagation(); _mcpShowFullLog(label, text); };
    sec.appendChild(btn);
  }
  frag.appendChild(sec);
}

function _mcpFormatLogDetails(entry) {
  const frag = document.createDocumentFragment();

  // input
  const inp = entry.input;
  if (inp && typeof inp === 'object' && Object.keys(inp).length > 0) {
    _mcpLogSection(frag, 'input', JSON.stringify(inp, null, 2), false);
  }

  // result
  const res = entry.result;
  if (res !== undefined) {
    const isErr = res && res.error;
    const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    _mcpLogSection(frag, isErr ? 'error' : 'result', text || '', isErr);
  }

  return frag;
}

function _mcpExportAuditLog() {
  const title = document.getElementById('docTitle')?.value || 'untitled';
  const mcp = window.__auditable_mcp;
  const data = {
    notebook: title,
    notebookId: mcp ? mcp.notebookId : null,
    exported: new Date().toISOString(),
    entries: _mcpAuditLog,
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mcp-audit-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function _mcpRefreshPanel() {
  const panel = document.getElementById('mcpPanel');
  if (!panel || !panel.classList.contains('visible')) return;

  // Status
  const statusEl = document.getElementById('mcpPanelStatus');
  const connectBtn = document.getElementById('mcpConnectBtn');
  const input = document.getElementById('mcpConnectInput');
  const infoEl = document.getElementById('mcpPanelInfo');
  if (!statusEl || !connectBtn || !input || !infoEl) return;
  const mcp = window.__auditable_mcp;
  const state = mcp ? mcp.state : 'disconnected';

  statusEl.textContent = state;
  statusEl.className = 'mcp-panel-status' + (
    state === 'connected' ? ' mcp-st-connected' :
    state === 'connecting' ? ' mcp-st-connecting' :
    state === 'error' ? ' mcp-st-error' : ''
  );

  // Name input
  const nameInput = document.getElementById('mcpNameInput');
  if (nameInput) {
    nameInput.placeholder = mcp ? mcp.derivedName : 'notebook';
    // Sync name input → shim on change
    nameInput.oninput = () => { if (mcp) mcp.name = nameInput.value.trim(); };
  }

  if (state === 'connected') {
    connectBtn.textContent = 'disconnect';
    connectBtn.onclick = () => { mcp.disconnect(); _mcpRefreshPanel(); };
    input.disabled = true;
    if (nameInput) nameInput.disabled = true;
    infoEl.textContent = 'notebook id: ' + (mcp.notebookId || 'unknown');
  } else {
    connectBtn.textContent = 'connect';
    connectBtn.onclick = () => _mcpDoConnect();
    input.disabled = false;
    if (nameInput) nameInput.disabled = false;
    infoEl.textContent = state === 'error' ? 'connection failed' : '';
  }

  // Audit log export button
  const exportBtn = document.getElementById('mcpLogExport');
  if (exportBtn) {
    exportBtn.onclick = () => _mcpExportAuditLog();
    exportBtn.style.display = _mcpAuditLog.length > 0 ? '' : 'none';
  }

  // Audit log
  const logEl = document.getElementById('mcpPanelLog');
  if (_mcpAuditLog.length === 0) {
    logEl.innerHTML = '<span class="dim">no tool calls yet</span>';
    return;
  }
  logEl.innerHTML = '';
  // show newest first
  for (let i = _mcpAuditLog.length - 1; i >= 0; i--) {
    const e = _mcpAuditLog[i];
    const div = document.createElement('div');
    div.className = 'mcp-log-entry';
    const time = e.timestamp.slice(11, 19);
    const hasErr = e.result && e.result.error;

    const header = document.createElement('div');
    header.className = 'mcp-log-header';
    header.innerHTML =
      `<span class="mcp-log-time">${time}</span>` +
      `<span class="mcp-log-tool">${e.tool}</span>` +
      `<span class="mcp-log-dur">${e.duration}ms</span>` +
      (hasErr ? `<span class="mcp-log-err"> err</span>` : '');
    div.appendChild(header);

    const details = document.createElement('div');
    details.className = 'mcp-log-details';
    details.style.display = 'none';
    details.appendChild(_mcpFormatLogDetails(e));
    div.appendChild(details);

    header.onclick = () => {
      details.style.display = details.style.display === 'none' ? 'block' : 'none';
    };
    logEl.appendChild(div);
  }
}

function _mcpDoConnect() {
  const input = document.getElementById('mcpConnectInput');
  const val = (input?.value || '').trim();
  if (!val) return;
  const mcp = window.__auditable_mcp;
  if (!mcp) return;

  // parse port:token
  const sep = val.indexOf(':');
  if (sep < 1) { setMsg('format: port:token'); return; }
  const port = parseInt(val.slice(0, sep), 10);
  const token = val.slice(sep + 1);
  if (!port || !token) { setMsg('format: port:token'); return; }

  // Set name before connecting
  const nameInput = document.getElementById('mcpNameInput');
  if (nameInput) mcp.name = nameInput.value.trim();

  mcp.connect(val); // pass port:token directly to shim
  setTimeout(_mcpRefreshPanel, 500);
}

export function toggleMcpPanel() {
  const panel = document.getElementById('mcpPanel');
  if (!panel) return;
  panel.classList.toggle('visible');
  if (panel.classList.contains('visible')) _mcpRefreshPanel();
}

export function mcpConnect() {
  _mcpDoConnect();
}

// Auto-refresh panel on state changes
if (window.__auditable_mcp) {
  const _origOnState2 = window.__auditable_mcp.onStateChange;
  window.__auditable_mcp.onStateChange = function(state, id) {
    if (state === 'disconnected') _mcpAutoAccept.clear();
    _mcpRefreshPanel();
    // Update statusbar
    const el = document.getElementById('statusMcp');
    if (el) {
      el.textContent = state === 'connected' ? 'mcp' : state === 'connecting' ? 'mcp...' : '';
      el.className = 'status-mcp' + (
        state === 'connected' ? ' mcp-connected' :
        state === 'connecting' ? ' mcp-connecting' : ''
      );
    }
    if (_origOnState2) _origOnState2(state, id);
  };
}

// ── Execution completion notification ──
// Subscribes to dag:complete on the hook bus (replaces window._mcpNotifyExecComplete).

// Subscribe via the direct hooks import — window.auditable.hooks is wired
// at globals.js's module-eval time, which runs *after* this module, so the
// window-surface check would silently skip the subscription.
hooks.on('dag:complete', () => {
  const mcp = window.__auditable_mcp;
  if (!mcp || mcp.state !== 'connected') return;
  mcp.notify('execution/complete', {
    errors: _mcpCollectErrors(),
    cellCount: S.cells.length,
    timestamp: new Date().toISOString(),
  });
  _mcpRefreshPanel(); // refresh audit log in panel
});

// Export audit log for UI panel access
window._mcpAuditLog = _mcpAuditLog;

// ── Re-lock / unlock hooks (subscribed via the auditable hook bus) ──

hooks.on('crypto:locked', () => {
  _mcpAuditLog.length = 0;
  _mcpAutoAccept.clear();
  _mcpRefreshPanel();
  if (navigator.modelContext && navigator.modelContext.notifyToolsChanged) {
    navigator.modelContext.notifyToolsChanged();
  }
});

hooks.on('crypto:unlocked', () => {
  _mcpRefreshPanel();
  if (navigator.modelContext && navigator.modelContext.notifyToolsChanged) {
    navigator.modelContext.notifyToolsChanged();
  }
});
