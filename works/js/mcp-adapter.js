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
import { WKS } from './state.js';

// Connect a gated A-Bus peer representing one agent identity. Its calls route
// through the broker → authorized against this agent's grants. clientId carries
// the identity so per-agent grants (granted by clientId) survive reconnects.
export async function connectAgentPeer(identity) {
  const ch = new MessageChannel();
  WKS.broker.connect(ch.port1);
  return connect(ch.port2, { client: 'agent:' + (identity || 'default') });
}

// The Works tool set (spine: read-only). Each tool's execute routes through the
// agent's A-Bus peer (works.VFS) — never WKS.* — so the broker gates it. Tools
// are pure of shell-realm access by construction. Write/mutate tools + scoped
// consent are the next slice.
export function worksTools(agentBus) {
  const vfs = (member, args) =>
    agentBus.call({ to: 'works', path: '/', interface: 'VFS', member }, args);
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
  ];
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
    status: () => ({ state: (ctl && ctl.state) || 'disconnected' }),
  };

  const agentBus = await connectAgentPeer('default');
  for (const tool of worksTools(agentBus)) mc.registerTool(tool);
  if (typeof mc.notifyToolsChanged === 'function') mc.notifyToolsChanged();
  return { agentBus };
}
