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
      // A WRITE tool — gated by the broker (works.VFS.Write is gated for agent
      // principals). Without a consented grant it returns AccessDenied; with a
      // path-scoped grant it writes only within the granted prefix.
      name: 'worksWriteFile',
      description: 'Write a text file to the Works workspace (requires a granted, scoped capability — the user is prompted to approve a folder on the first write).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      annotations: { destructiveHint: true, title: 'Write workspace file' },
      execute: async (input) => {
        const path = input.path;
        const content = String(input.content ?? '');
        try {
          await vfs('Write', [path, content]);
        } catch (e) {
          // Denied for want of a grant → ask the user to consent to a scope,
          // then retry once. Any other failure (or a declined prompt) propagates.
          if (!isAccessDenied(e)) throw e;
          const ok = await requestWriteConsent(identity, path);
          if (!ok) throw e;
          await vfs('Write', [path, content]);
        }
        return { path, written: true };
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
        + '<code>' + esc(path) + '</code><br>Grant it write access to a folder? Reads stay open; '
        + 'the grant lasts until you revoke it or reload.';
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

// ── consent backend — scoped grants per agent identity ──
// The shell (post user consent) grants an agent a scoped capability over the
// workspace. The grant is keyed by the agent's clientId ('agent:<identity>') so
// it survives reconnects + maps 1:1 onto numen's per-agent (multichannel)
// identity. Reads are ungated; this grant lets the agent's WRITES through the
// VFS gate, confined to pathPrefix. The Settings panel + a consent dialog call
// these; they don't need the shim (so works-smoke can exercise the gate directly).
export function grantAgent(identity, opts = {}) {
  const id = WKS.broker.grant('agent:' + (identity || 'default'), {
    to: 'works', interface: 'VFS', member: '*',
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
