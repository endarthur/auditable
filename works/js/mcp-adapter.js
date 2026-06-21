// numen-for-Works — the shell's MCP endpoint (spine).
//
// An external agent (Claude Code, via the @gcu/numen bridge) drives the Works
// desktop over MCP. The agent runs NO code in any of our realms — it's a remote
// process talking over numen's transport — so there is nothing to sandbox; the
// threat is its *requests* (prompt-injectable intent), and those are constrained
// by the A-Bus capability model (works-capability-security-spec §4).
//
// So each agent is represented as a GATED A-Bus peer: a tool call is translated
// into an A-Bus call ON THAT AGENT'S PEER, which the broker authorizes against
// the agent's scoped grants. The adapter is trusted first-party shell code (same
// tier as works-service); its one discipline is to act ONLY through the agent
// peer and NEVER touch WKS.* directly — so the broker sees and gates every agent
// action. numen's multichannel identity (one channel/folder per agent) maps each
// agent to its own peer + grant set; the spine wires a single 'default' agent.

import { connect } from '#abus';
import { Dialog } from '#dialog';
import { WKS } from './state.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// base64 ↔ bytes — binary file content crosses the MCP boundary as base64 (tool
// results are JSON). Chunked to avoid call-stack limits on large buffers.
const toB64 = (buf) => {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => {
  const s = atob(String(b64 || ''));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};

// The broker denies a gated call it can't authorize with code 'Error.AccessDenied'
// (the message reads "not authorized to call …" — match the CODE, not the prose).
const isAccessDenied = (e) =>
  !!e && (e.code === 'Error.AccessDenied' || /access ?denied|not authorized/i.test(String((e && e.message) || e)));

// Fire a works.Mcp signal so the (sandboxed) Settings panel updates live.
function emitMcp(member, args) {
  try { WKS.worksBus && WKS.worksBus.signal({ path: '/', interface: 'Mcp', member }, args); } catch { /* */ }
}

// ── agent audit log ──
// A bounded record of every agent action — the observability layer that makes
// opening up more tools safe to reason about. In-memory only (not persisted):
// it's a session ledger, cleared on reload. Newest entries last.
const AUDIT_CAP = 250;
const _auditLog = [];

function logAgentAction(entry) {
  _auditLog.push({ ts: Date.now(), ...entry });
  if (_auditLog.length > AUDIT_CAP) _auditLog.splice(0, _auditLog.length - AUDIT_CAP);
  emitMcp('AuditChanged', []);
}
export function getAuditLog() { return _auditLog.map((e) => ({ ...e })); }

// A compact one-line summary of a tool call's input for the log.
function summarizeArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.path) return String(input.path);
  try { const s = JSON.stringify(input); return s.length > 80 ? s.slice(0, 77) + '…' : s; }
  catch { return ''; }
}

// Wrap a tool so every call is logged (outcome + a short arg summary). The
// wrapped execute is otherwise identical, so gating/consent inside the original
// still runs; we just record allowed/denied around it.
function withAudit(identity, tool) {
  const orig = tool.execute;
  return {
    ...tool,
    execute: async (input, client) => {
      const summary = summarizeArgs(input);
      try {
        const r = await orig(input, client);
        logAgentAction({ tool: tool.name, identity, summary, ok: true });
        return r;
      } catch (e) {
        logAgentAction({ tool: tool.name, identity, summary, ok: false, error: String((e && e.message) || e) });
        throw e;
      }
    },
  };
}

// Connect a gated A-Bus peer representing one agent identity. Its calls route
// through the broker → authorized against this agent's grants. clientId carries
// the identity so per-agent grants (granted by clientId) survive reconnects.
export async function connectAgentPeer(identity) {
  const ch = new MessageChannel();
  WKS.broker.connect(ch.port1);
  return connect(ch.port2, { client: 'agent:' + (identity || 'default') });
}

// The Works tool set. Each tool's execute routes through the agent's A-Bus peer
// (works.VFS) — never WKS.* — so the broker gates it. Tools are pure of
// shell-realm access by construction. Writes are gated for agent principals;
// a denied write triggers reactive consent (see requestWriteConsent). `identity`
// keys the grant 1:1 with numen's per-agent (multichannel) identity.
export function worksTools(agentBus, identity = 'default') {
  const vfs = (member, args) =>
    agentBus.call({ to: 'works', path: '/', interface: 'VFS', member }, args);
  const shell = (member, args) =>
    agentBus.call({ to: 'works', path: '/', interface: 'Shell', member }, args);
  const nb = (member, args) =>
    agentBus.call({ to: 'works', path: '/', interface: 'Notebook', member }, args);
  // A gated mutation: try the call; on AccessDenied, ask the user to consent to
  // a folder scope (defaults to `scopePath`'s folder) and retry once. The broker
  // is the enforcement point — this just turns a denial into a consent prompt.
  // Works for any gated interface (VFS writes, Notebook cell edits).
  const gated = async (iface, member, args, scopePath) => {
    const call = () => agentBus.call({ to: 'works', path: '/', interface: iface, member }, args);
    try { return await call(); }
    catch (e) {
      if (!isAccessDenied(e)) throw e;
      const ok = await requestWriteConsent(identity, scopePath);
      if (!ok) throw e;
      return call();
    }
  };
  return [
    {
      name: 'worksTree',
      description: 'List the Works workspace under a path (default /projects).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      annotations: { readOnlyHint: true, title: 'Workspace tree' },
      execute: async (input) => {
        const path = (input && input.path) || '/projects';
        return { path, entries: await vfs('List', [path, { stat: true }]) };
      },
    },
    {
      name: 'worksReadFile',
      description: 'Read a text file from the Works workspace.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { readOnlyHint: true, title: 'Read workspace file' },
      execute: async (input) => {
        return { path: input.path, content: await vfs('Read', [input.path, 'utf8']) };
      },
    },
    {
      name: 'worksStat',
      description: 'Stat a workspace path — whether it exists, and if so its kind/size.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { readOnlyHint: true, title: 'Stat path' },
      execute: async (input) => {
        const exists = await vfs('Exists', [input.path]);
        if (!exists) return { path: input.path, exists: false };
        return { path: input.path, exists: true, stat: await vfs('Stat', [input.path]) };
      },
    },
    {
      name: 'worksReadBinary',
      description: 'Read a binary file from the workspace, returned as base64.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { readOnlyHint: true, title: 'Read binary file' },
      execute: async (input) => ({ path: input.path, base64: toB64(await vfs('Read', [input.path, 'bytes'])) }),
    },
    {
      // Observe the desktop — what's open (read-only, ungated).
      name: 'worksListSurfaces',
      description: 'List the surfaces (tabs) open on the Works desktop, with the focused one flagged.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, title: 'Open surfaces' },
      execute: async () => ({ surfaces: await shell('ListSurfaces', []) }),
    },
    {
      // Navigate — open a file/project in its surface (notebook, doc, preview…).
      name: 'worksOpenPath',
      description: 'Open a file or project from the Works workspace in its surface (notebook, doc, preview, …).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { title: 'Open in Works' },
      execute: async (input) => ({ path: input.path, opened: await shell('OpenPath', [input.path]) }),
    },
    {
      // Drive — run a notebook's cells. With a path it opens+runs that notebook;
      // with none it runs the focused notebook. Returns { ran, … }.
      name: 'worksRunNotebook',
      description: 'Run all cells of a notebook. Pass a path to open and run it, or omit to run the focused notebook.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      annotations: { title: 'Run notebook' },
      execute: async (input) => shell('RunNotebook', [(input && input.path) || null]),
    },
    {
      // Set up the desktop — spawn a surface by kind (terminal, inspector, …).
      name: 'worksSpawnSurface',
      description: 'Open a new surface on the Works desktop by kind (e.g. terminal, inspector, settings, launcher).',
      inputSchema: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' } }, required: ['kind'] },
      annotations: { title: 'Spawn surface' },
      execute: async (input) => shell('SpawnSurface', [input.kind, input.title]),
    },
    {
      name: 'worksNewNotebook',
      description: 'Create a new, empty notebook project under /projects and return its path.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      annotations: { title: 'New notebook' },
      execute: async (input) => shell('NewNotebook', [(input && input.title) || null]),
    },
    {
      name: 'worksCloseSurface',
      description: 'Close the surface (tab) showing a given workspace path.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { title: 'Close surface' },
      execute: async (input) => shell('CloseSurface', [input.path]),
    },
    // ── notebook content loop (the read→run→observe→fix loop) ──
    // All address cells by 0-based index and honor the notebook's own %mcp
    // access (read-only/private cells stay protected). Reads + RunCell are open;
    // edits (Edit/Add/Delete) are broker-gated for agents + folder-consented.
    {
      name: 'worksNotebookCells',
      description: 'List a notebook\'s cells (index, type, access level, name, defines) for the notebook at `path`.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { readOnlyHint: true, title: 'Notebook cells' },
      execute: async (input) => nb('ListCells', [input.path]),
    },
    {
      name: 'worksNotebookSource',
      description: 'Read a cell\'s source from the notebook at `path` (0-based index).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' } }, required: ['path', 'index'] },
      annotations: { readOnlyHint: true, title: 'Read cell source' },
      execute: async (input) => nb('GetSource', [input.path, input.index]),
    },
    {
      name: 'worksNotebookOutput',
      description: 'Read a cell\'s last output/result from the notebook at `path` (0-based index).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' }, format: { type: 'string' } }, required: ['path', 'index'] },
      annotations: { readOnlyHint: true, title: 'Read cell output' },
      execute: async (input) => nb('GetOutput', [input.path, input.index, input.format ? { format: input.format } : undefined]),
    },
    {
      name: 'worksNotebookRunCell',
      description: 'Run a single cell (and its downstream dependents) in the notebook at `path` (0-based index).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' } }, required: ['path', 'index'] },
      annotations: { title: 'Run cell' },
      execute: async (input) => nb('RunCell', [input.path, input.index]),
    },
    {
      name: 'worksNotebookEditCell',
      description: 'Replace a cell\'s source (full `code`, or `patches`: [{old,new}]) in the notebook at `path`. Gated — read-only/private cells are refused; first edit prompts for a folder grant.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' }, code: { type: 'string' }, patches: { type: 'array' } }, required: ['path', 'index'] },
      annotations: { destructiveHint: true, title: 'Edit cell' },
      execute: async (input) => gated('Notebook', 'SetCell', [input.path, input.index, input.code, input.patches], input.path),
    },
    {
      name: 'worksNotebookAddCell',
      description: 'Add a cell (type: code|md|css|html) to the notebook at `path`, optionally at a 0-based `position`. Gated.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' }, position: { type: 'integer' } }, required: ['path', 'type'] },
      annotations: { title: 'Add cell' },
      execute: async (input) => gated('Notebook', 'AddCell', [input.path, input.type, input.code || '', input.position], input.path),
    },
    {
      name: 'worksNotebookDeleteCell',
      description: 'Delete a cell from the notebook at `path` (0-based index). Gated, destructive.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' } }, required: ['path', 'index'] },
      annotations: { destructiveHint: true, title: 'Delete cell' },
      execute: async (input) => gated('Notebook', 'DeleteCell', [input.path, input.index], input.path),
    },
    {
      // A WRITE tool — gated by the broker (works.VFS.Write is gated for agent
      // principals). Without a consented grant it returns AccessDenied; with a
      // path-scoped grant it writes only within the granted prefix.
      name: 'worksWriteFile',
      description: 'Write a text file to the Works workspace (requires a granted, scoped capability — the user is prompted to approve a folder on the first write).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      annotations: { destructiveHint: true, title: 'Write workspace file' },
      execute: async (input) => {
        await gated('VFS', 'Write', [input.path, String(input.content ?? '')], input.path);
        return { path: input.path, written: true };
      },
    },
    {
      name: 'worksWriteBinary',
      description: 'Write a binary file (base64-encoded) to the workspace (requires a granted, scoped capability).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, base64: { type: 'string' } }, required: ['path', 'base64'] },
      annotations: { destructiveHint: true, title: 'Write binary file' },
      execute: async (input) => {
        await gated('VFS', 'Write', [input.path, fromB64(input.base64)], input.path);
        return { path: input.path, written: true };
      },
    },
    {
      name: 'worksMakeDir',
      description: 'Create a directory (and any missing parents) in the workspace (gated).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { title: 'Make directory' },
      execute: async (input) => {
        await gated('VFS', 'MkDir', [input.path], input.path);
        return { path: input.path, created: true };
      },
    },
    {
      name: 'worksMove',
      description: 'Move/rename a workspace file or folder (gated — both source and destination must be in a granted scope).',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      annotations: { destructiveHint: true, title: 'Move / rename' },
      execute: async (input) => {
        // The broker's seed scope only inspects the call's FIRST arg (Move's
        // `from`), so a grant on `from` wouldn't confine the destination.
        // Ensure `to` is in a granted scope first (consent for its folder if
        // not), THEN the broker-gated Move confines `from`.
        await ensureWriteScope(identity, input.to);
        await gated('VFS', 'Move', [input.from, input.to], input.from);
        return { from: input.from, to: input.to, moved: true };
      },
    },
    {
      name: 'worksDelete',
      description: 'Delete a workspace file or folder, recursively (gated, destructive).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { destructiveHint: true, title: 'Delete path' },
      execute: async (input) => {
        await gated('VFS', 'Delete', [input.path], input.path);
        return { path: input.path, deleted: true };
      },
    },
  ].map((t) => withAudit(identity, t));   // every agent action is logged
}

// Reactive consent: prompt the user to grant the agent a path-scoped write
// capability when a write is denied. Resolves true (a grant was issued) or
// false (declined). Automation overrides the dialog via window.__agentConsent__
// — a function returning a pathPrefix string (allow), true (allow, default
// scope = the file's folder), or a falsy value (deny). Default scope offered is
// the containing folder; the user can widen it to /projects.
async function requestWriteConsent(identity, path) {
  const dir = path.replace(/[^/]*$/, '') || '/';
  const applyGrant = (r) => {
    if (!r) return false;
    grantAgent(identity, { pathPrefix: typeof r === 'string' ? r : dir });
    return true;
  };

  const hook = (typeof window !== 'undefined') && window.__agentConsent__;
  if (typeof hook === 'function') return applyGrant(await hook({ identity, path, dir }));
  if (typeof Dialog !== 'function') return false;   // no UI available → deny

  let chosen = dir;
  const scopes = dir === '/projects/' ? [{ v: dir, label: 'All projects — ' + dir }]
    : [{ v: dir, label: 'This folder — ' + dir }, { v: '/projects/', label: 'All projects — /projects/' }];

  const _btn = (label, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:5px 14px; border-radius:4px; cursor:pointer; font:inherit; '
      + 'border:1px solid var(--au-border); '
      + (primary ? 'background:var(--au-action); color:#fff; border-color:var(--au-action);'
                 : 'background:var(--au-surface-bright); color:var(--au-fg);');
    return b;
  };

  const dialog = new Dialog({
    title: 'Agent write access',
    backdrop: true,
    render: (body, ctx) => {
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'min-width:380px; max-width:480px; display:flex; flex-direction:column; gap:12px;';

      const intro = document.createElement('div');
      intro.style.cssText = 'color:var(--au-fg-soft); font-size:12px; line-height:1.5;';
      intro.innerHTML = 'The connected agent (<code>' + esc(identity) + '</code>) wants to write:<br>'
        + '<code>' + esc(path) + '</code><br>Grant it access to <strong>create, modify, move, and '
        + 'delete</strong> files in a folder? Reads stay open; the grant lasts until you revoke it or reload.';
      wrap.appendChild(intro);

      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:5px;';
      scopes.forEach((s, i) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex; gap:9px; align-items:center; padding:7px 10px; '
          + 'border:1px solid var(--au-border); border-radius:6px; cursor:pointer; background:var(--au-surface-raised);';
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'agent-scope'; radio.value = s.v; radio.checked = i === 0;
        radio.addEventListener('change', () => { chosen = s.v; });
        const t = document.createElement('div');
        t.style.cssText = 'font-size:12px;'; t.textContent = s.label;
        row.append(radio, t);
        list.appendChild(row);
      });
      wrap.appendChild(list);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:2px;';
      const deny = _btn('Deny', false); deny.addEventListener('click', () => ctx.close(null));
      const allow = _btn('Allow writes', true); allow.addEventListener('click', () => ctx.close(chosen));
      row.append(deny, allow);
      wrap.appendChild(row);

      body.appendChild(wrap);
      allow.focus();
    },
  });
  return applyGrant(await dialog.show());
}

// Does the agent already hold a grant whose scope covers `path`? Mirrors the
// broker's scopeOk (startsWith pathPrefix) — used to confine a Move's
// destination, which the broker's first-arg-only seed scope doesn't inspect.
function inScope(identity, path) {
  const grants = (WKS.broker.inspect().grants || [])
    .filter((g) => g.grantee === 'agent:' + (identity || 'default') && g.to === 'works');
  return grants.some((g) => !g.scope || g.scope.pathPrefix == null || String(path).startsWith(g.scope.pathPrefix));
}

// Ensure `path` is in a granted write scope, prompting consent for its folder if
// not. Throws AccessDenied when consent is declined. (The broker still gates the
// actual call; this is the extra check the broker's seed scope can't make.)
async function ensureWriteScope(identity, path) {
  if (inScope(identity, path)) return true;
  const ok = await requestWriteConsent(identity, path);
  if (!ok) { const e = new Error('Access denied: ' + path); e.code = 'Error.AccessDenied'; throw e; }
  return true;
}

// ── consent backend — scoped grants per agent identity ──
// The shell (post user consent) grants an agent a scoped capability over the
// workspace. The grant is keyed by the agent's clientId ('agent:<identity>') so
// it survives reconnects + maps 1:1 onto numen's per-agent (multichannel)
// identity. Reads are ungated; this grant lets the agent's WRITES through the
// VFS gate, confined to pathPrefix. The Settings panel + a consent dialog call
// these; they don't need the shim (so works-smoke can exercise the gate directly).
export function grantAgent(identity, opts = {}) {
  const id = WKS.broker.grant('agent:' + (identity || 'default'), {
    // interface:'*' so ONE folder grant authorizes both VFS writes and notebook
    // cell edits within scope (Inspect has no path arg → its scope check fails →
    // still denied, so '*' doesn't leak the topology). The scope confines by path.
    to: 'works', interface: '*', member: '*',
    scope: opts.pathPrefix ? { pathPrefix: opts.pathPrefix } : null,
  });
  emitMcp('GrantsChanged', [listAgentGrants()]);
  logAgentAction({ tool: 'grant', identity: identity || 'default', summary: 'write · ' + (opts.pathPrefix || 'entire workspace'), ok: true });
  return id;
}
export function revokeAgent(identity) {
  const n = WKS.broker.revokeAll('agent:' + (identity || 'default'));
  emitMcp('GrantsChanged', [listAgentGrants()]);
  logAgentAction({ tool: 'revoke', identity: identity || 'default', summary: n + ' grant(s)', ok: true });
  return n;
}
export function listAgentGrants() {
  return (WKS.broker.inspect().grants || []).filter((g) => String(g.grantee).startsWith('agent:'));
}

// Wire the shell as an MCP endpoint: connect the (single, spine) agent peer,
// register its tools through navigator.modelContext (the numen shim), and expose
// a small control (WKS.mcp) the Settings "Agent access" panel drives over A-Bus
// (the panel is a sandboxed surface; it can't reach the shim directly). No-op
// when the shim isn't present, so calling it at boot is always safe.
export async function setupWorksMcp() {
  const mc = (typeof navigator !== 'undefined') && navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return null;

  // The shim's control global (gcuWebMCP/gcuMCP). The host connects OUT to the
  // numen bridge with a PORT:TOKEN the user pastes in Settings.
  const ctl = (typeof window !== 'undefined') && (window.gcuMCP || window.gcuWebMCP);
  if (ctl) {
    ctl.name = 'works';   // a stable per-app id for the bridge
    // Mirror the shim's state onto the `works` service's Mcp.StateChanged signal,
    // so the sandboxed Settings panel updates live.
    ctl.onStateChange = (state) => {
      try { WKS.worksBus && WKS.worksBus.signal({ path: '/', interface: 'Mcp', member: 'StateChanged' }, [state]); } catch { /* */ }
    };
  }
  // The control the works service's Mcp interface delegates to (works-service.js).
  WKS.mcp = {
    connect: (portToken) => { if (ctl) ctl.connect(portToken); },
    disconnect: () => { if (ctl && typeof ctl.disconnect === 'function') ctl.disconnect(); },
    // Inject a FileSystemDirectoryHandle → the shim uses the fs (folder) transport
    // (file://- and PWA-friendly; no localhost / port). The folder picker needs
    // user activation, so the SHELL MENUBAR drives this (a sandboxed surface's
    // A-Bus call can't carry activation). connect('fs:<token>') follows.
    useFolder: (handle) => { if (ctl) ctl.folder = handle || null; },
    status: () => ({ state: (ctl && ctl.state) || 'disconnected' }),
  };

  const agentBus = await connectAgentPeer('default');
  for (const tool of worksTools(agentBus, 'default')) mc.registerTool(tool);
  if (typeof mc.notifyToolsChanged === 'function') mc.notifyToolsChanged();
  return { agentBus };
}
