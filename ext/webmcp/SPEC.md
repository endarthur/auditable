# `@gcu/webmcp` — Spec Draft

**Status:** Draft v1.7
**Date:** 2026-03-19
**Author:** Arthur (endarthur), with Claude

## Overview

A system for connecting one or more Auditable computational notebooks (running in a browser) to MCP clients (such as Claude Code). The bridge speaks MCP over stdio to Claude Code. Two connection modes:

- **Standalone mode:** Each notebook opens a WebSocket directly to the bridge.
- **AF mode:** The AF (Auditable Files) workspace shell connects once and proxies for all its notebook iframes.

Two components. No browser extension.

```
Standalone mode:

┌──────────────────┐
│  Notebook A      │──┐
│  (any browser)   │  │  WebSocket    ┌──────────┐  stdio   ┌─────────────┐
└──────────────────┘  ├─localhost────►│  Bridge  │◄────────►│ Claude Code │
┌──────────────────┐  │               │ (node)   │  MCP     │             │
│  Notebook B      │──┘               └──────────┘          └─────────────┘
│  (any browser)   │
└──────────────────┘

AF mode:

┌─────────────────────────────────┐
│  AF shell                       │
│  ┌───────────┐ ┌───────────┐    │  WebSocket    ┌──────────┐  stdio   ┌─────────────┐
│  │ Notebook A│ │ Notebook B│    │──localhost───►│  Bridge  │◄────────►│ Claude Code │
│  │ (iframe)  │ │ (iframe)  │    │               │ (node)   │  MCP     │             │
│  └───────────┘ └───────────┘    │               └──────────┘          └─────────────┘
└─────────────────────────────────┘
```

### Goals

- Enable Claude Code (or any MCP stdio client) to inspect and manipulate Auditable notebooks running in browser tabs.
- **Discovery-based, not target-based.** The bridge is a passive listener. The MCP client does not need to know which notebooks exist, where they are, or their file paths. It launches the bridge, then discovers what's connected via `listNotebooks`. Notebooks connect to the bridge on their own initiative — the user opens a notebook and provides the connection string. This means activating the bridge does not require giving the MCP client access to the notebook file.
- Support multiple notebooks per bridge session. Context cost stays flat — tool count doesn't grow with notebook count.
- Fine-grained, capability-based access control: each notebook decides what tools to expose and what data is visible.
- Maintain Auditable's zero-dependency, single-file philosophy. Notebooks work identically without the bridge.
- Shim the WebMCP `navigator.modelContext` API so browser-native agents get support for free if/when WebMCP stabilizes.
- Keep the bridge trivially simple — a single file, no build step, no dependencies.

### Non-Goals

- MCP resources, prompts, or sampling. MCP has four primitives: **tools** (callable functions), **resources** (subscribable read-only data), **prompts** (reusable prompt templates), and **sampling** (server asks the client's LLM to generate). We start with tools only — everything else is addable later without breaking changes.
- Production hardening of WebMCP shim against spec churn. The shim is intentionally minimal.
- Cross-notebook tool invocation. Notebooks are isolated from each other.

---

## Protocol Versioning

The wire protocol between page and bridge is versioned to prevent mismatches between different auditable/bridge versions.

- The `hello` message includes a `protocol` field (integer, starting at `1`).
- The bridge includes `protocol` in its `welcome` response.
- If the bridge does not support the page's protocol version, it sends `{ type: "error", message: "Unsupported protocol version 2. Bridge supports protocol 1." }` and closes the connection.
- If the page receives a `welcome` with an unsupported protocol version, it disconnects and shows an error in the connection indicator.

Protocol version increments when:
- Message types are added, removed, or renamed.
- Existing message fields change meaning or type.
- Tool schema conventions change (e.g., the `notebook` parameter injection format).

Additive changes (new optional fields on existing messages) do **not** require a version bump — both sides must ignore unknown fields.

Pre-1.0: same rules as Auditable itself — breaking changes are expected, no migration paths.

---

## Why No Extension?

A web page can open a WebSocket to `ws://localhost:{port}` directly. Browsers exempt localhost from mixed-content restrictions for HTTP origins. However, `file://` origins cannot open WebSocket connections. The bridge supports both WebSocket and HTTP long-polling on the same port — the shim auto-detects `file://` and falls back to HTTP. No extension permissions, no content scripts, no Chrome Web Store, no MV3 service worker lifecycle issues. Works in any browser, from any origin.

---

## Component 1: WebMCP Shim + Auditable Adapter (page-side)

Two files inlined into the Auditable notebook HTML:

- **shim.js** — generic WebMCP polyfill. Provides `navigator.modelContext` if it doesn't already exist natively. Manages the WebSocket connection to the bridge. Routes tool invocations. Knows nothing about Auditable — could be used by any web page.
- **adapter.js** — Auditable-specific. Reads `S.cells`, parses directives, auto-generates tool registrations via `navigator.modelContext.registerTool()`. Registers the default structural tools (`listCells`, `getCellOutput`, `getDAG`, etc.) when the first `// %mcp` directive is encountered.

When the native browser WebMCP API ships, the polyfill part of the shim is a no-op. The WebSocket connection logic and the adapter are always needed — native WebMCP doesn't talk to local bridge processes.

### API Surface (matches W3C Draft 2026-03-09)

```ts
interface ModelContext {
  registerTool(tool: ModelContextTool): void;
  unregisterTool(name: string): void;
}

interface ModelContextTool {
  name: string;                                       // unique identifier
  description: string;                                // natural language
  inputSchema?: object;                               // JSON Schema
  execute: (input: object, client: ModelContextClient) => Promise<any>;
  annotations?: { readOnlyHint?: boolean };
}

interface ModelContextClient {
  requestUserInteraction(callback: () => Promise<any>): Promise<any>;
}
```

### Shim Behavior

- If `navigator.modelContext` already exists (native WebMCP), do nothing for the polyfill.
- Otherwise, create a polyfill implementing `registerTool` / `unregisterTool` backed by a `Map<string, ModelContextTool>`.
- The shim also manages the bridge connection:
  - `__auditable_mcp.connect(portAndToken)` → parses `"port:token"` format (token is mandatory). On `file://` origins, uses HTTP polling directly. Otherwise tries WebSocket first, falls back to HTTP on failure. Sends a `hello` with notebook metadata, name, protocol version, and token, then announces tools. The token is stored and resent automatically on reconnect.
  - Transport suffix: `port:token:http` forces HTTP polling, `port:token:ws` forces WebSocket (no-op).
  - `__auditable_mcp.disconnect()` → closes the connection.
  - `__auditable_mcp.name` — get/set notebook name (used as MCP ID). Auto-derived from title if not set.
  - On incoming `tool_invoke` messages, calls the matching tool's `execute` and sends the result back.
  - On tool registration/unregistration, sends `tools_changed` to the bridge if connected.
  - Responds to `ping` messages with `pong` (see **Heartbeat**).

### Bridge Connection

The user provides the bridge connection string to the notebook. Three methods, all calling the same shim `connect()`:

**Method 1 — Programmatic (day one).** A call in a governance/config cell:

```js
__auditable_mcp.connect("7842:a1b2c3");
```

**Method 2 — UI panel.** A small connection widget in the ellipsis/settings menu. Point-and-click, comes with the adapter UI work.

**Method 3 — URL fragment.** The notebook reads `location.hash` on load:

```
file:///home/arthur/notebooks/qf-model.html#mcp=7842:a1b2c3
```

The shim checks for `#mcp=` on load and auto-connects. Hash fragments are not sent to servers, so this is safe for `file://` and `https://` origins. Claude Code could print the full URL to stderr alongside the port, so the user clicks a link and the notebook connects immediately — no paste step.

The shim opens the WebSocket and identifies itself:

```js
function connect(portAndToken) {
  const [port, token] = portAndToken.split(":");
  if (!token) throw new Error("Token required: use 'port:token' format");
  const ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => {
    // Identify this notebook
    ws.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      title: document.title || "Untitled",
      path: window.location.href,
      token: token
    }));
    // Announce all registered tools
    ws.send(JSON.stringify({
      type: "tools_changed",
      tools: serializeTools()
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "welcome") {
      notebookId = msg.id;
    } else if (msg.type === "tool_invoke") {
      handleToolInvoke(msg);
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  };

  ws.onclose = () => {
    setTimeout(() => connect(portAndToken), 2000);
  };
}
```

### Connection Indicator

The notebook should show bridge connection status. Auditable's statusbar is the natural place. A small indicator showing:

- **Disconnected** (default): no indicator, or a subtle grayed-out icon. No overhead.
- **Connecting**: pulsing or amber indicator while the WebSocket is opening.
- **Connected**: green indicator with the notebook's assigned ID (e.g., `MCP nb-1`). Clicking could show a tooltip or panel with: bridge port, number of exposed tools, list of `%mcp` / `%mcp rw` cells.
- **Error**: red indicator if the WebSocket failed or the token was rejected.

In AF mode, the AF toolbar shows a single bridge status indicator, plus per-tab connection badges.

This is a small UI addition but critical for trust — the user should always know when their notebook is talking to an external process, and what it's exposing.

### Tool Registration Layers

The notebook author controls what tools are registered. Three layers, in order of what gets built:

**Layer 1 — Convention cell (day one).** A code cell near the top of the notebook. Plain JS, calls `navigator.modelContext.registerTool()` directly. No Auditable core changes needed.

> **Note on API surface:** The examples below reference notebook introspection APIs (`S.cells`, `runDAG()`, cell DOM accessors) that exist in the Auditable runtime but are not yet exposed as a stable `notebook.*` API. The adapter (Layer 2) will formalize this surface. For Layer 1 convention cells, use the internal APIs directly — they work, they're just not guaranteed stable.

```js
navigator.modelContext.registerTool({
  name: "listCells",
  description: "List all cells with their IDs, types, and names",
  execute: async () => S.cells.map(c => ({
    id: c.id, type: c.type, name: c.name
  })),
  annotations: { readOnlyHint: true }
});

navigator.modelContext.registerTool({
  name: "getCellSource",
  description: "Get the source code of a cell by ID",
  inputSchema: {
    type: "object",
    properties: { cellId: { type: "string" } },
    required: ["cellId"]
  },
  execute: async ({ cellId }) => {
    const cell = S.cells.find(c => c.id === cellId);
    if (!cell) throw new Error("Cell not found: " + cellId);
    return { source: cell.code };
  },
  annotations: { readOnlyHint: true }
});

// Connect to the bridge (port:token format, token is mandatory)
__auditable_mcp.connect("7842:a1b2c3");
```

> **Note:** The notebook registers tools using its own local names (`listCells`, `getCellSource`). The bridge handles multi-notebook routing by injecting a `notebook` parameter on the MCP side. The notebook doesn't need to know about other notebooks.

**Layer 2 — Cell directives (soon after).** Per-cell `// %mcp` and `// %mcp rw` directives in the cell source. The adapter scans directives and registers the default structural tools (`listCells`, `getCellOutput`, `getCellSource`, `updateCellSource`, etc.) that accept cell name or ID as a parameter. Governance is visible in the source, saved in the notebook HTML, version-controllable. `// %private` provides hard opt-out. See **MCP Directives** section for full details.

**Layer 3 — MCP manifest cell (later).** A single structured cell declaring the full tool surface: which cells are exposed, access levels, custom tool names, descriptions. The governance dashboard.

**Layer collision resolution:** Layers stack, but explicit wins. If a Layer 1 `registerTool` call registers a tool with the same name as one the adapter (Layer 2) would auto-register, the adapter skips its auto-registration for that name. The adapter logs a console warning: `"Skipping auto-registration of 'listCells' — already registered manually."` This makes Layer 1 an override mechanism and Layer 2 the default. No ambiguity.

---

## Component 2: Bridge Process

A single Node.js script. Claude Code spawns it and owns its stdin/stdout. Notebooks connect to it via WebSocket.

### Startup

Ship a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "auditable": {
      "type": "stdio",
      "command": "node",
      "args": ["./webmcp_bridge.js"]
    }
  }
}
```

Anyone who clones the repo and runs `claude` from that directory gets the bridge automatically.

The bridge:

1. Generates a cryptographically random session token (e.g., 24 hex characters via `crypto.randomBytes(12).toString('hex')`).
2. Binds a WebSocket server to `localhost:0` (OS assigns a free port).
3. Prints to **stderr**: `@gcu/webmcp bridge listening on port 7842 — connect with: 7842:a1b2c3d4e5f6`. Also prints the full URL fragment form: `Add #mcp=7842:a1b2c3d4e5f6 to your notebook URL, or call __auditable_mcp.connect("7842:a1b2c3d4e5f6")`.
4. Reads MCP JSON-RPC from stdin, writes responses to stdout.
5. Reports `listNotebooks` and `getDocumentation` as the initial tools. Other tools appear as notebooks connect.

Claude Code shows stderr to the user. The user connects one or more notebooks using any of the three methods. No hardcoded port, no collision possible.

When the Claude Code session ends, the child process dies, all WebSockets close. Clean lifecycle.

### Session Token

The bridge generates a session token on startup. The token is **mandatory** — any `hello` message without a valid token receives `{ type: "error", message: "Invalid or missing session token" }` and the connection is closed.

This prevents:
- Other local processes from hijacking the WebSocket connection.
- Rogue browser tabs from connecting (WebSocket is not subject to CORS, so without a token any page could connect to localhost).
- Stale reconnections from previous bridge sessions.

The token is valid for the bridge's lifetime (not single-use), so auto-reconnect works without user intervention. Combined `port:token` format means the user pastes one string, not two.

### Connection State Machine

Each notebook connection transitions through states:

```
CONNECTING → AUTHENTICATED → READY → ACTIVE
    │              │            │        │
    │  (bad token) │  (timeout) │        │ (ws close)
    └──► REJECTED  └──► STALE   └────────┴──► DISCONNECTED
```

- **CONNECTING**: WebSocket open, waiting for `hello`.
- **AUTHENTICATED**: `hello` received with valid token, `welcome` sent back. Waiting for `tools_changed`.
- **READY**: `tools_changed` received, tools merged into MCP surface. Tool calls can now be routed to this notebook.
- **ACTIVE**: Normal operation.
- **REJECTED**: Bad token. `error` sent, connection closed.
- **STALE**: No `tools_changed` within 10s of `hello`. Bridge closes connection.
- **DISCONNECTED**: WebSocket closed. Bridge re-merges tools, emits `list_changed` if needed.

Tool calls arriving for a notebook in AUTHENTICATED state (before READY) return: `{ code: -1, message: "Notebook 'nb-1' is still initializing. Try again in a moment." }`.

### Heartbeat

The bridge sends `{ type: "ping" }` to each connected WebSocket every 30 seconds. The page must respond with `{ type: "pong" }` within 10 seconds. If no pong is received, the bridge considers the connection dead, closes the WebSocket, and re-merges tools.

This catches silently dead connections (laptop sleep, network hiccup, browser tab crash) much faster than waiting for a tool call to time out.

The page-side shim handles `ping` → `pong` automatically. No adapter involvement needed.

### MCP Capabilities

On MCP `initialize`:

```json
{
  "protocolVersion": "2025-03-26",
  "capabilities": { "tools": { "listChanged": true } },
  "serverInfo": {
    "name": "auditable-mcp-bridge",
    "version": "1.0.0"
  },
  "instructions": "Auditable computational notebook bridge. Use listNotebooks to see connected notebooks. Use listCells to see cells in a notebook. Interact with cells via getCellOutput, getCellSource, updateCellSource. Use pauseAutorun/resumeAutorun to batch edits. Use getNotebookStatus to check for errors after edits. Call getDocumentation for API reference on Auditable's builtins, extensions, and conventions."
}
```

The `instructions` field helps the client (and its LLM) understand the server's purpose and discover the right entry points. Claude Code uses this with Tool Search to decide when to invoke our tools.

### Multi-Notebook Model

The bridge accepts multiple connections (WebSocket or HTTP). Each connecting notebook sends a `hello` message with its `title`, `name`, `path`, protocol version, and token. The bridge validates the token and uses the `name` as the notebook ID (e.g., `webmcp-bridge`). If no name is provided, falls back to `nb-N`. Same name + same path = reconnect (reuses ID). Same name + different path = appends `-2`, `-3`. The bridge sends back a `welcome` with the ID.

The bridge maintains:
- A map of `id → { ws, title, path, tools: ToolMetadata[], state }`.
- A merged MCP tool set derived from all connected notebooks.

### Tool Schema Merging

When multiple notebooks register tools with the same name (e.g., both register `listCells`), the bridge must present a single schema to the MCP client.

Rules:
1. **First-to-READY wins** the schema and description for the MCP tool definition. The bridge stores the "canonical" definition from the first notebook that registered it.
2. When the canonical notebook disconnects, the bridge promotes the next notebook that has that tool to canonical and re-emits the tool definition (which may differ). `notifications/tools/list_changed` fires.
3. The bridge does **not** attempt to merge or union schemas. If notebook A's `listCells` accepts `{ filter: string }` and B's doesn't, the canonical schema is used. Tool calls are forwarded as-is — the target notebook's `execute` handler is responsible for ignoring unknown properties or returning errors.
4. If a tool call includes properties the target notebook doesn't expect, it should ignore them gracefully (standard JSON Schema behavior — `additionalProperties` is not restricted by default).

This is simple and predictable. Complex schema negotiation is not worth the complexity for v1.

### MCP Tool Surface

The bridge always exposes three built-in tools:

**`listNotebooks`** — returns all connected notebooks (ID, title, transport type). Does not expose file paths.

```json
{
  "name": "listNotebooks",
  "description": "Use as your first call to discover connected notebooks. Returns notebook IDs, titles, file paths, and which tools each notebook offers. Notebook IDs are required for all other tool calls.",
  "inputSchema": { "type": "object", "properties": {} },
  "annotations": { "readOnlyHint": true, "idempotentHint": true, "title": "List connected notebooks" }
}
```

Returns:

```json
[
  {
    "id": "nb-1",
    "title": "QF Resource Model",
    "path": "file:///home/arthur/notebooks/qf-model.html",
    "tools": ["listCells", "getCellSource", "updateCellSource"]
  },
  {
    "id": "nb-2",
    "title": "Variogram Analysis",
    "path": "http://localhost:8080/variogram.html",
    "tools": ["listCells", "getCellSource", "runVariogramFit"]
  }
]
```

**`getConnectionInfo`** — returns the `port:token` connection string. The agent gives this to the user so they can paste it into the notebook's MCP panel. Avoids the need to find the string in stderr output.

**`getDocumentation`** — always available (no `notebook` param). See **Documentation Tools** section.

All other tools are derived from notebooks. The bridge **merges** tool definitions across notebooks and **injects** a `notebook` parameter into each tool's schema:

If notebook A registers `listCells` and notebook B registers `listCells` and `runVariogramFit`, the MCP tool list becomes:

| MCP tool | notebook param | Source |
|---|---|---|
| `listNotebooks` | (none) | built-in |
| `getDocumentation` | (none) | built-in |
| `listCells` | required | A and B both have it |
| `getCellSource` | required | A and B |
| `updateCellSource` | required | A only |
| `runVariogramFit` | required | B only |

The `notebook` parameter is prepended to each tool's `inputSchema`:

```json
{
  "name": "listCells",
  "description": "Use to discover cells in a notebook. Returns cell IDs, names, types, directives, and MCP visibility. Cells with %private are listed with metadata only (if they have %mcp describe). Cells without %mcp directives are omitted.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": {
        "type": "string",
        "description": "Notebook ID (use listNotebooks to see available notebooks)"
      }
    },
    "required": ["notebook"]
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true, "title": "List cells in a notebook" }
}
```

> **Reserved parameter name:** The bridge injects `notebook` into every proxied tool's schema. Notebooks must not register tools that already have a `notebook` property in their `inputSchema` — the bridge logs a warning and skips the tool if this occurs.

When Claude Code calls `listCells({ notebook: "nb-1" })`, the bridge strips the `notebook` param and routes `{ type: "tool_invoke", callId, name: "listCells", input: {} }` to notebook `nb-1`'s WebSocket.

If the `notebook` param refers to a notebook that doesn't have that tool, the bridge returns an error: `"Notebook nb-2 does not have tool updateCellSource"`.

**Context efficiency:** Tool count is the *union* of unique tool names across all notebooks, plus built-in tools. Ten notebooks all registering the same five tools = seven MCP tools total. No context bloat.

### Tool Lifecycle

The bridge dynamically updates as notebooks connect, disconnect, and change their tools.

```
Session start:     bridge spawns → tools/list returns [listNotebooks, getDocumentation]
Notebook A opens:  ws connects → hello(token) → welcome(nb-1) → tools_changed
                   → bridge merges tools → notifications/tools/list_changed
                   → Claude Code re-fetches → built-ins + A's tools appear
Notebook B opens:  ws connects → hello(token) → welcome(nb-2) → tools_changed
                   → bridge merges tools → list_changed (only if B has new tool names)
                   → Claude Code sees new tools if any
Cell annotation:   user toggles mcp:read → tools_changed on that ws
                   → bridge re-merges → list_changed if tool names changed
Notebook A closes: ws disconnects → bridge re-merges
                   → list_changed if tools were unique to A
                   → tools that B still has remain available (B promoted to canonical)
Session end:       bridge process killed → everything tears down
```

`notifications/tools/list_changed` only fires when the set of unique tool names changes — not on every connect/disconnect. If notebook B connects with the same tool names as A, no notification is needed (but the bridge tracks B as an additional provider).

### Tool Invocation Flow

```
Claude Code                    Bridge                         Page (nb-1)
    │                            │                               │
    │ tools/call                 │                               │
    │ listCells({notebook:"nb-1"})                               │
    │ ─────────────────────────► │                               │
    │                            │ (strip notebook param)        │
    │                            │ tool_invoke                   │
    │                            │ {callId, name:"listCells",    │
    │                            │  input:{}} ──────────────────►│
    │                            │                               │ execute()
    │                            │                               │
    │                            │                tool_result    │
    │                            │ ◄─────────────────────────────│
    │ tools/call result          │                               │
    │ ◄───────────────────────── │                               │
```

### `requestUserInteraction` Support

When a tool's `execute` calls `client.requestUserInteraction()`:

1. The shim sends `{ type: "user_interaction_request", callId }` over the WebSocket.
2. The bridge holds the MCP `tools/call` response open.
3. The notebook shows the interaction UI (e.g., a diff confirmation dialog).
4. User acts → shim sends `{ type: "user_interaction_result", callId, result }`.
5. `execute()` completes, result propagates back to Claude Code.

MCP tool calls can take arbitrary time to resolve. Claude Code will wait.

**Known limitation:** There is no cancellation mechanism for pending `requestUserInteraction` calls. If the user walks away, the tool call hangs until the bridge's timeout (default 120s). The bridge cannot signal "still waiting" to the MCP client. This is acceptable for v1 — MCP does not have a call cancellation primitive. Future versions could add a timeout-with-retry pattern or an MCP extension for progress notifications.

### Error Handling

- **No notebooks connected:** `listNotebooks` returns `[]`. Any other tool call returns MCP error: `{ code: -1, message: "No notebooks connected. Is a tab open with the bridge port configured?" }`.
- **Notebook initializing:** Tool call to a notebook in AUTHENTICATED state (before tools_changed): `{ code: -1, message: "Notebook 'nb-1' is still initializing. Try again in a moment." }`.
- **Invalid notebook ID:** Tool call with a `notebook` param that doesn't match a connected notebook returns: `{ code: -1, message: "Notebook 'nb-3' is not connected. Use listNotebooks to see available notebooks." }`.
- **Tool not on notebook:** Tool call routed to a notebook that doesn't have that tool returns: `{ code: -1, message: "Notebook 'nb-2' does not have tool 'updateCellSource'. Use listNotebooks to check which tools each notebook offers." }`.
- **Tool call timeout:** Configurable, default 120s. Return MCP error: `{ code: -2, message: "Tool call timed out after 120s. The notebook may be unresponsive." }`.
- **Tool execute throws:** Return MCP tool result with `isError: true` and the error message.

### Message Protocol (Bridge ↔ Page)

Two transports, same message format:

**WebSocket** — full-duplex, used on HTTP/HTTPS origins. Standard RFC 6455, text frames only.

**HTTP polling** — used on `file://` origins (where WS is blocked) or when forced via `:http` suffix. Three endpoints:
- `POST /connect` — handshake (body: hello message). Returns welcome message. CORS `*`.
- `POST /send` — client sends messages (body: `{token, id, message}`). Returns `{ok: true}`.
- `GET /poll?token=X&id=Y` — long-poll (25s timeout). Returns array of pending messages.

Both transports use the same message types:

```ts
// Page → Bridge
{ type: "hello", protocol: number, title: string, name: string, path: string, token: string }
{ type: "tools_changed", tools: ToolMetadata[] }
{ type: "docs_available", topics: string[] }
{ type: "tool_result", callId: string, result?: any, error?: string }
{ type: "doc_result", callId: string, content: string }
{ type: "user_interaction_request", callId: string }
{ type: "user_interaction_result", callId: string, result?: any, error?: string }
{ type: "pong" }

// Bridge → Page
{ type: "welcome", protocol: number, id: string }
{ type: "tool_invoke", callId: string, name: string, input: object }
{ type: "doc_request", callId: string, topic: string }
{ type: "request_tools" }
{ type: "ping" }
{ type: "error", message: string }
```

`ToolMetadata` (as sent by the page — no `notebook` param, that's injected by the bridge):

```ts
interface ToolMetadata {
  name: string;
  description: string;
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean };
}
```

---

## AF Integration Mode

AF (Auditable Files) is the tabbed workspace shell that hosts multiple notebooks as iframes. It already has a `postMessage` bridge protocol with its notebooks (`af:ready`, `af:serialize`, `af:dirty`, etc.) and knows about all open tabs, their titles, and dirty state. When running inside AF, individual notebooks **do not** connect to the bridge. AF does.

### How It Works

1. The user provides the bridge connection string to AF (not to individual notebooks). AF has a connection widget in its toolbar.
2. AF opens a single WebSocket to `ws://localhost:{port}`.
3. AF sends a `hello` for **itself** (with a workspace flag), then sends `notebook_hello` for each open notebook tab.
4. When the user opens/closes notebook tabs, AF sends `notebook_hello` / `notebook_goodbye` messages for the affected notebooks.
5. When a `tool_invoke` arrives, AF routes it to the correct notebook iframe via the existing `postMessage` bridge, executes the tool inside the notebook's scope, and returns the result.

### AF Multi-Notebook Protocol

AF mode uses a single WebSocket to multiplex multiple logical notebooks. This requires notebook identity on every message that flows through the socket.

**AF → Bridge messages carry a `notebookId` field** (the bridge-assigned ID from `notebook_welcome`):

```ts
// AF → Bridge: register a notebook tab
{ type: "notebook_hello", tabId: string, title: string, path: string }

// Bridge → AF: acknowledge notebook registration
{ type: "notebook_welcome", tabId: string, id: string }

// AF → Bridge: announce tools for a specific notebook
{ type: "tools_changed", notebookId: string, tools: ToolMetadata[] }

// AF → Bridge: notebook tab closed
{ type: "notebook_goodbye", notebookId: string }

// AF → Bridge: tool result from a specific notebook
{ type: "tool_result", notebookId: string, callId: string, result?: any, error?: string }

// Bridge → AF: invoke tool on a specific notebook
{ type: "tool_invoke", notebookId: string, callId: string, name: string, input: object }

// AF → Bridge: docs from a specific notebook
{ type: "docs_available", notebookId: string, topics: string[] }
{ type: "doc_result", notebookId: string, callId: string, content: string }
```

The bridge uses `notebookId` to route tool calls and track per-notebook state. AF maintains the `notebookId ↔ tabId` mapping internally.

AF's initial `hello` message includes `workspace: true` to signal multiplexing mode:

```ts
{ type: "hello", protocol: 1, title: "AF Workspace", path: "/projects/qf/", token: "a1b2c3", workspace: true }
```

The bridge responds with `{ type: "welcome", protocol: 1, id: "af-1" }`. This is the AF-level ID. Individual notebooks get IDs via `notebook_welcome`.

### AF postMessage Extension

AF's existing `postMessage` bridge protocol needs new message types for MCP. These use the existing `af:*` namespace:

```ts
// AF shell → Notebook iframe
{ type: "af:mcpInvoke", callId: string, name: string, input: object }
{ type: "af:mcpDocRequest", callId: string, topic: string }

// Notebook iframe → AF shell
{ type: "af:mcpResult", callId: string, result?: any, error?: string }
{ type: "af:mcpDocResult", callId: string, content: string }
{ type: "af:mcpToolsChanged", tools: ToolMetadata[] }
{ type: "af:mcpDocsAvailable", topics: string[] }
```

### AF-Level Tools

AF can also register workspace-level tools that don't belong to any notebook:

- **`listFiles`** — list files in the current workspace (FSAA directory or Box).
- **`openNotebook`** — open a notebook by path, creating a new tab.
- **`saveNotebook`** — trigger save for a notebook (proxies `af:serialize`).
- **`saveAll`** — save all dirty notebooks.

These are registered as regular tools with no `notebook` param on the MCP side.

### Notebook-Side: No Changes Needed

When running inside AF, the notebook doesn't need the shim's WebSocket code at all. AF handles the bridge connection. The notebook's `registerTool` calls (Layer 1) or directives (Layer 2) still work — AF reads the tool registrations from the iframe's scope and proxies them to the bridge via the postMessage extension. The notebook detects AF via `window.__AF_BRIDGE__` (already exists) and skips direct WebSocket connection.

### Standalone Fallback

If the same notebook is opened outside AF (as a standalone `file://` or `http://` page), the shim connects directly to the bridge as described in Component 1. The notebook works in both modes with no changes.

---

## MCP Directives

New cell directives for controlling MCP visibility. These follow Auditable's existing `// %directive` convention and are processed by the **adapter** (Layer 2) or by AF when generating tool registrations.

### `// %mcp`

Expose this cell's computed output to MCP as readable via the generic `getCellOutput` tool. The cell is identified by its name (`// %cellName`) or cell ID.

```js
// %cellName variogram_params
// %mcp
const nugget = 0.1;
const sill = 1.0;
const range = 300;
```

This makes the cell accessible via: `getCellOutput({ notebook: "nb-1", cell: "variogram_params" })` → returns `{ nugget: 0.1, sill: 1.0, range: 300 }`.

Applicable to **code** and **html** cells. On code cells, it exposes the cell's defined scope variables. On html cells, it exposes widget values (the named `<audit-*>` elements).

### `// %mcp rw`

Expose this cell's source code for reading **and writing** via the generic `getCellSource` / `updateCellSource` tools. Write operations invoke `requestUserInteraction` before applying changes.

```js
// %cellName kriging_code
// %mcp rw
const result = kt3d(grid, variogram, data);
```

This makes the cell accessible via:
- `getCellSource({ notebook: "nb-1", cell: "kriging_code" })` → returns the cell's source text
- `updateCellSource({ notebook: "nb-1", cell: "kriging_code", source: "..." })` → replaces source, triggers DAG re-execution

Applicable to **code** cells only. Markdown, CSS, and HTML cells can use `// %mcp` for read-only access but not `// %mcp rw`.

### `// %private`

Explicitly exclude this cell from MCP exposure, overriding any notebook-level or AF-level default policy. A cell marked `%private` will never appear in tool registrations, even if a Layer 3 manifest cell tries to include it.

```js
// %private
const raw_assays = await load("./confidential_drillholes.csv");
```

This is the hard opt-out. Useful for cells that load proprietary data, credentials, or sensitive parameters.

### `// %mcp describe "..."`

Override the auto-generated tool description for this cell.

```js
// %cellName vario_fit
// %mcp
// %mcp describe "Fitted variogram model parameters (spherical, Quadrilátero Ferrífero iron ore)"
const model = fitVariogram(experimental, "spherical");
```

Without this, the auto-generated description is generic: "Output of cell variogram_fit".

> **Warning: descriptions are semi-public.** The `%mcp describe` text is transmitted to the MCP client (and thus to the LLM). Treat descriptions as you would treat commit messages — they should be informative but should not contain confidential specifics you wouldn't want an external model to see. For example, "847 Fe composites, QF region" is fine for a methodology discussion; "BHP Billiton confidential Q3 2025 drilling campaign" is not.

### Directive Interactions

| Cell type | `%mcp` | `%mcp rw` | `%private` | Default (no directive) |
|---|---|---|---|---|
| code | expose output | expose source + output | hidden | hidden |
| html | expose widget values | n/a | hidden | hidden |
| markdown | expose rendered text | n/a | hidden | hidden |
| css | n/a | n/a | hidden | hidden |

- `%manual` cells: `%mcp` still works — exposes the last computed output. `%mcp rw` works but the updated source won't auto-execute (it's manual). The agent would need to explicitly call `runCell` if available.
- `%norun` cells: `%mcp rw` can be used for source editing (documentation cells). `%mcp` on a `%norun` cell has no output to expose — the adapter warns and ignores.
- `%private` takes precedence over everything.

### Default Tool Set (Layer 2)

When any cell uses `// %mcp` or `// %mcp rw`, the adapter (or AF) auto-registers a standard set of structural tools alongside the cell-specific tools:

- **`listCells`** — returns all cells with id, name, type, directives, and MCP visibility.
- **`getCellOutput`** — generic output getter for any `%mcp` cell (by cell ID or name). Supports output slicing (see below).
- **`getCellSource` / `updateCellSource`** — generic source access for any `%mcp rw` cell.
- **`getCellScreenshot`** — capture a cell's output element as a PNG image (see below).
- **`addCell`** — create a new cell (see below). Requires `requestUserInteraction`.
- **`runCell`** — explicitly execute a cell (useful for `%manual` cells).
- **`runAll`** — execute all cells in DAG order.
- **`getDAG`** — return the dependency graph (which cells depend on which). Read-only.
- **`getNotebookStatus`** — return notebook health snapshot (see below).
- **`getNotebookContext`** — orientation in one call: cells + DAG + status + settings (see below).
- **`pauseAutorun`** — disable reactive re-execution. Edits accumulate without triggering the DAG.
- **`resumeAutorun`** — re-enable reactive execution and run the DAG with all accumulated changes.

### Output Slicing (`getCellOutput`)

Cell outputs can be arbitrarily large (arrays with millions of elements, large objects). To prevent context bloat, `getCellOutput` supports a `format` parameter:

```json
{
  "name": "getCellOutput",
  "description": "Use when you need to inspect the computed result of a cell. Only works on cells with the // %mcp directive. Returns the cell's defined scope variables (for code cells) or widget values (for HTML cells). Use 'path' to drill into nested properties (e.g., 'variogram.range'). Use format 'summary' (default) for an overview, 'full' for complete data (subject to size cap), or 'schema' for structure only. Use listCells first to see which cells are accessible.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string", "description": "Notebook ID from listNotebooks" },
      "cell": { "type": "string", "description": "Cell name or cell ID" },
      "path": { "type": "string", "description": "Dot-separated path to drill into nested properties (e.g., 'variogram.range', 'data[0].grade'). Omit to return the cell's full output." },
      "format": {
        "type": "string",
        "enum": ["summary", "full", "schema"],
        "description": "Output format. 'summary' (default): type, shape, first/last items for arrays, key list for objects. 'full': complete serialized value, capped at 64KB. 'schema': types and shapes only, no values."
      },
      "offset": { "type": "integer", "description": "For arrays: start index for slicing (used with format 'full')" },
      "limit": { "type": "integer", "description": "For arrays: max items to return (used with format 'full')" }
    },
    "required": ["notebook", "cell"]
  }
}
```

Format behaviors:

| Format | What's returned | Size |
|---|---|---|
| `summary` (default) | Type info, shape/length for arrays, first 5 + last 5 items for arrays, key list + first value for objects, full value for primitives | Bounded, typically < 2KB |
| `full` | Complete serialized value. Arrays respect `offset`/`limit` for slicing. Hard cap at 64KB — if exceeded, returns truncated result with `truncated: true` and a note to use slicing. | Up to 64KB |
| `schema` | Types and shapes only. `{ nugget: "number", sill: "number", grid: "Float64Array[50000]" }`. No values. | Minimal |

The `schema` format is useful for Pattern 1 (methodology-only) on cells that are technically `%mcp`-visible — the agent sees structure without values. It's also useful as a first pass before drilling into specific data.

### Execution Feedback (`getNotebookStatus`)

After editing cells, the agent needs to know whether execution succeeded. `getNotebookStatus` provides a health snapshot:

```json
{
  "name": "getNotebookStatus",
  "description": "Use after updateCellSource or runCell to check for execution errors. Returns notebook state: cell count, error count, cells in error with messages, autorun state, and last execution timestamp. Also useful as a first call to understand notebook health.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string", "description": "Notebook ID from listNotebooks" }
    },
    "required": ["notebook"]
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true, "title": "Get notebook status" }
}
```

Returns:

```json
{
  "cellCount": 12,
  "errorCount": 1,
  "errors": [
    { "cellId": "c4", "cellName": "kriging_code", "message": "ReferenceError: variogram is not defined", "line": 3 }
  ],
  "autorun": true,
  "dirtyCount": 0,
  "lastExecution": "2026-03-18T14:30:00Z"
}
```

Additionally, `updateCellSource` returns execution feedback when autorun is enabled:

```json
{
  "ok": true,
  "executionTriggered": true,
  "errors": []
}
```

When autorun is paused, `executionTriggered` is `false` and the agent knows to call `resumeAutorun` or `getNotebookStatus` later. When autorun is enabled and execution produces errors, they appear in the `errors` array immediately — the agent gets feedback in the same response without needing a separate status call.

### Visual Feedback (`getCellScreenshot`)

For canvas-based visualizations (variogram plots, kriging maps, block models), data alone doesn't tell the agent whether the output looks right. `getCellScreenshot` captures a cell's output DOM element as a PNG.

```json
{
  "name": "getCellScreenshot",
  "description": "Capture the visual output of a cell as a PNG image. Use after running a cell to see plots, maps, canvas visualizations, or rendered HTML. Only works on cells with // %mcp that have visible output. Returns base64-encoded PNG. Use for iterative visual work — edit code, run, screenshot, evaluate, repeat.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string", "description": "Notebook ID from listNotebooks" },
      "cell": { "type": "string", "description": "Cell name or cell ID" },
      "maxWidth": { "type": "integer", "description": "Max width in pixels. Image is scaled down if larger. Default 800." },
      "maxHeight": { "type": "integer", "description": "Max height in pixels. Default 600." }
    },
    "required": ["notebook", "cell"]
  },
  "annotations": { "readOnlyHint": true, "title": "Capture cell visual output" }
}
```

Returns `{ image: "data:image/png;base64,...", width: 500, height: 400 }`.

**Implementation:** For `<canvas>` elements, use `canvas.toDataURL('image/png')` directly — fast, no dependencies. For general DOM output (tables, styled HTML), use a lightweight DOM-to-canvas approach or simply screenshot the output element's bounding box. Canvas elements are the primary use case and trivial to capture.

**Security:** Respects `%mcp` visibility. Only cells with `// %mcp` can be screenshotted. A `%private` cell's output is never captured. For Pattern 1 (methodology-only), screenshots of result cells are blocked unless those cells have `%mcp` — the user explicitly decides whether the agent can see the plot.

**Size:** PNG images are capped at the `maxWidth`/`maxHeight` bounds. Typical canvas screenshots at 800px wide are 20-80KB base64 — within MCP response limits but worth being mindful of in rapid iteration loops.

### Cell Creation (`addCell`)

Create a new cell in the notebook. Essential for Pattern 2 (full collaboration / pair programming) where the agent builds a notebook from scratch.

```json
{
  "name": "addCell",
  "description": "Create a new cell in the notebook. Requires user confirmation. The new cell is inserted after the specified cell (or at the end if no position given). The cell is created but not executed — call runCell or let autorun handle it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string", "description": "Notebook ID from listNotebooks" },
      "type": { "type": "string", "enum": ["code", "md", "html", "css"], "description": "Cell type" },
      "source": { "type": "string", "description": "Cell source code/content" },
      "afterCell": { "type": "string", "description": "Insert after this cell (name or ID). Omit to append at end." },
      "collapsed": { "type": "boolean", "description": "Start collapsed. Default false." }
    },
    "required": ["notebook", "type", "source"]
  },
  "annotations": { "destructiveHint": true, "title": "Create a new cell" }
}
```

Returns `{ cellId: "c13", index: 12 }`.

**`requestUserInteraction` is mandatory.** The confirmation dialog shows: cell type, source code preview, insertion position. The user sees exactly what's being added before it exists.

**Batch creation:** For building multiple cells at once (e.g., scaffolding a notebook), use `pauseAutorun` first, then multiple `addCell` calls, then `resumeAutorun`. Each `addCell` still requires individual confirmation — but the user can approve them in quick succession without intermediate DAG executions.

### Quick Orientation (`getNotebookContext`)

A single call that bundles what agents always need at session start. Saves 3-4 round-trips.

```json
{
  "name": "getNotebookContext",
  "description": "Use as your first call after listNotebooks to orient yourself in a notebook. Returns cells, DAG, status, and settings in one response. Equivalent to calling listCells + getDAG + getNotebookStatus together.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string", "description": "Notebook ID from listNotebooks" }
    },
    "required": ["notebook"]
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true, "title": "Get full notebook context" }
}
```

Returns:

```json
{
  "cells": [ { "id": "c1", "type": "code", "name": "variogram_params", "directives": ["%mcp"], "mcpAccess": "read" }, ... ],
  "dag": { "edges": [["c1", "c3"], ["c2", "c3"]], "roots": ["c1", "c2"], "leaves": ["c5"] },
  "status": { "cellCount": 5, "errorCount": 0, "autorun": true, "lastExecution": "..." },
  "settings": { "theme": "dark", "width": "860" }
}
```

### Patches Mode for `updateCellSource`

`updateCellSource` supports two modes:

- **Full replacement**: `{ index: 5, code: "..." }` — replaces the entire cell source.
- **Patches**: `{ index: 5, patches: [{ old: "ctx.lineWidth = 2", new: "ctx.lineWidth = 3" }] }` — surgical search-and-replace pairs applied in order. Each `old` must be unique in the cell.

Patches save tokens by avoiding full source transmission for small edits. If any `old` string is not found, the tool errors before applying anything. The confirmation dialog shows the same diff regardless of mode.

### Diff Preview for `updateCellSource`

When `updateCellSource` triggers `requestUserInteraction`, the confirmation dialog shows a **line-based LCS diff** of old → new source. Changed lines are highlighted: additions in green, deletions in red. Context lines surround each hunk. This makes review practical for large cells where only a few lines changed.

### Edit Highlights

After an MCP edit is applied, the changed lines in the CM6 editor receive a subtle amber background decoration (`cm-mcp-highlight`). The decoration clears on the next user keystroke. This works in both regular and split view.

This is a UX detail in the adapter, not a protocol change.

### Widget Interaction (`setWidgetValue`)

The agent can adjust widget values (sliders, dropdowns, checkboxes, text inputs) without editing code:

```json
{
  "name": "setWidgetValue",
  "description": "Set the value of a widget in a cell. Triggers reactive re-execution or callback, same as user interaction.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string" },
      "index": { "type": "integer", "description": "0-based cell index" },
      "name": { "type": "string", "description": "Widget name attribute" },
      "value": { "description": "New value (number for sliders, string for dropdowns/text, boolean for checkboxes)" }
    },
    "required": ["notebook", "index", "name", "value"]
  },
  "annotations": { "destructiveHint": true }
}
```

Requires `rw` access on the cell. Shows confirmation dialog: `oldValue → newValue`. Sets the widget's `.value` property and dispatches `input` + `change` events, triggering the same reactive DAG execution or callback as user interaction.

This enables parameter sweeps: `pauseAutorun` → set multiple widget values → `resumeAutorun` → read output. The agent operates the notebook's UI without touching code.

### HTML Cell Directives

HTML cells use the same `// %directive` syntax as code cells. Directive lines are stripped from the rendered output before `innerHTML` is set — they're parsed for access control but invisible visually. This avoids the HTML comment problem (`<!-- -->` inside `<!--AUDITABLE-DATA-->` would corrupt the data block).

### Native WebMCP Gating

When a browser ships native `navigator.modelContext` (Chrome 146+), the shim's polyfill is a no-op. However, the adapter only registers tools when `window.__auditable_mcp` exists (our shim's public API). This prevents tools from auto-exposing to native browser agents without explicit opt-in. A future settings flag will enable native WebMCP support.

### Audit Log Export

The MCP panel includes an **export** button that downloads the audit log as JSON. The file contains the notebook title, notebook ID, export timestamp, and all log entries (full input/result, no truncation). Filename: `mcp-audit-{title}-{date}.json`. Useful for compliance records (JORC, NI 43-101).

### Execution Completion Notification

When `resumeAutorun` or `runAll` is called, the DAG may take time to settle (async cells, workers, network fetches). The bridge can push an MCP notification when execution completes:

```json
{ "method": "notifications/execution/complete", "params": { "notebook": "nb-1", "errors": [], "duration": 1200 } }
```

This depends on the MCP client supporting server-initiated notifications. Claude Code supports `notifications/tools/list_changed` (which the bridge already uses), so custom notifications should work via the same mechanism. If the client ignores unknown notifications, no harm done — the agent can still poll `getNotebookStatus` as a fallback.

### Tool Annotations

Every tool must carry accurate MCP annotations. These are hints for the client and UI — not security enforcement, but they help the LLM make better decisions about when and how to use tools.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `title` |
|---|---|---|---|---|
| `listNotebooks` | true | false | true | List connected notebooks |
| `listCells` | true | false | true | List cells in a notebook |
| `getCellOutput` | true | false | true | Get cell computed output |
| `getCellScreenshot` | true | false | true | Capture cell visual output |
| `getCellSource` | true | false | true | Get cell source code |
| `updateCellSource` | false | **true** | false | Update cell source code |
| `addCell` | false | **true** | false | Create a new cell |
| `runCell` | false | false | false | Execute a cell |
| `runAll` | false | false | false | Execute all cells |
| `getDAG` | true | false | true | Get dependency graph |
| `getNotebookStatus` | true | false | true | Get notebook status |
| `getNotebookContext` | true | false | true | Get full notebook context |
| `pauseAutorun` | false | false | true | Pause reactive execution |
| `resumeAutorun` | false | false | false | Resume and execute DAG |
| `getDocumentation` | true | false | true | Get Auditable docs |
| `getAuditLog` | true | false | true | Get tool call history |
| `setWidgetValue` | false | **true** | false | Set widget value |

Destructive tools (`updateCellSource`, `addCell`, `setWidgetValue`) modify notebook state and require `requestUserInteraction`. This annotation helps clients decide whether to ask for additional confirmation.

### Tool Descriptions

Descriptions are instructions, not just labels. They tell the LLM *when* to use the tool, *how* to format arguments, and *what* to expect back. Examples:

```json
{
  "name": "updateCellSource",
  "description": "Replace the source code of a cell. Only works on cells with // %mcp rw. Triggers a user confirmation dialog in the notebook before applying. Will trigger DAG re-execution of downstream cells unless autorun is paused — check the 'errors' field in the response. Use pauseAutorun first when making multiple edits, then resumeAutorun when done.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": {
        "type": "string",
        "description": "Notebook ID from listNotebooks"
      },
      "cell": {
        "type": "string",
        "description": "Cell name or cell ID"
      },
      "source": {
        "type": "string",
        "description": "Complete new source code for the cell"
      }
    },
    "required": ["notebook", "cell", "source"]
  }
}
```

All tool descriptions should follow this pattern: **when to use** → **constraints/prerequisites** → **what it returns or does** → **tips for common workflows**.

### Error Messages as Guidance

Error responses should guide the agent toward self-correction, not just report failure:

| Situation | Bad error | Good error |
|---|---|---|
| Wrong notebook ID | `"Not found"` | `"Notebook 'nb-3' is not connected. Use listNotebooks to see available notebooks."` |
| Cell not accessible | `"Access denied"` | `"Cell 'raw_data' is marked %private and cannot be read. Use listCells to see accessible cells."` |
| Edit without pause | (succeeds but cascades) | (succeeds, but tool description warns to pause first) |
| Cell not found | `"Invalid cell"` | `"No cell named 'vario_params' in notebook nb-1. Available cells: variogram_params, kriging_code, grid_def. Did you mean 'variogram_params'?"` |
| Tool on wrong cell type | `"Type error"` | `"updateCellSource only works on code cells. Cell 'styles' is a CSS cell. Use listCells to check cell types."` |

The agent sees errors as observations and uses the guidance to self-correct in the next turn. Every error message should include: **what went wrong**, **why**, and **what to do instead**.

`pauseAutorun` / `resumeAutorun` are essential for multi-cell refactors. Without them, every `updateSource` call triggers a cascade of intermediate DAG executions on partially-edited code. The expected pattern:

```
pauseAutorun({ notebook: "nb-1" })
updateCellSource({ notebook: "nb-1", cell: "variogram_model", source: "..." })
updateCellSource({ notebook: "nb-1", cell: "kriging_params", source: "..." })
updateCellSource({ notebook: "nb-1", cell: "grid_definition", source: "..." })
resumeAutorun({ notebook: "nb-1" })
// DAG runs once with all three changes applied
// → response includes errors if any
getNotebookStatus({ notebook: "nb-1" })
// → confirms clean execution or shows remaining errors
```

These are registered automatically when the first `%mcp` directive is encountered. No boilerplate needed.

---

## Documentation Tools

Claude Code needs context about Auditable's APIs, extensions, and conventions to write effective notebook code. Rather than front-loading everything into the system prompt, the bridge exposes documentation on demand via a `getDocumentation` tool. This keeps context lean — docs are only loaded when the agent actually needs them.

### `getDocumentation({ topic })`

Always available (no `notebook` param — documentation is global). Returns markdown content for a given topic.

Topics:

| Topic | Content |
|---|---|
| `cells` | Cell types, builtins (ui, std, load, install, worker, etc.), scope model, injected parameters |
| `dag` | Reactivity, parseNames/findUses, topoSort, runDAG, scope-by-value semantics |
| `directives` | All `// %` directives including MCP directives |
| `widgets` | `<audit-*>` elements, ui.slider/dropdown/checkbox/textInput, HTML cell widget binding |
| `stdlib` | @std API — csv, sum, mean, median, extent, bin, linspace, unique, zip, cross, fmt, etc. |
| `atra` | Atra language spec — types, memory, arrays, layouts, multi-memory, compilation |
| `natra` | ndarray lib — scoped allocator, broadcasting, stride tricks, RNG |
| `calque` | Calque spreadsheet language spec |
| `spinifex` | GIS extension — map, layers, loaders, SRTM, DEM, draw, GDAL |
| `glsl` | Shader tag, Shadertoy-compatible uniforms |
| `sql` | SQL tag, tokenizer |
| `python` | @python compat — range, enumerate, len, sorted, reversed, etc. |
| `save` | Save modes, packed format, export app, AF lightweight format |
| `af` | AF workspace shell — storage backends, bridge protocol, file tree |

Returns `{ content: "...", source: "bridge" | "notebook" }` so the agent knows where it came from.

### Option A: Bridge-Bundled Docs

The bridge ships with markdown doc snippets extracted from the codebase (CLAUDE.md sections, SPEC.md files, STDLIB.md, README files). These are embedded in webmcp_bridge.js or in a companion `docs/` directory.

```
@gcu/webmcp/
├── webmcp_bridge.js
├── shim.js
├── docs/
│   ├── cells.md
│   ├── dag.md
│   ├── directives.md
│   ├── widgets.md
│   ├── stdlib.md
│   ├── atra.md
│   ├── natra.md
│   ├── calque.md
│   ├── spinifex.md
│   └── ...
├── .mcp.json
└── README.md
```

Pros: works offline, works without any notebook connected, zero latency. The bridge can serve docs before any notebook has connected — useful for Claude Code to orient itself at session start.

Cons: gets stale if the notebook is running a newer Auditable version or has custom extensions the bridge doesn't know about. Requires rebuilding/updating the bridge when docs change.

### Option B: Notebook-Served Docs

The notebook (or AF) is the authority on what it can do. `getDocumentation` is routed to a connected notebook, which returns docs for its active capabilities. The notebook knows which extensions are loaded (`_taggedLanguages`, installed modules), what atra version it's running, etc.

This means the documentation lives inside Auditable itself — either bundled into the HTML (like `builtins.json` already is), or fetchable from the extensions at runtime. Each extension exposes a `__docs__` property:

```js
// Inside ext/atra/index.js
window.__extensionDocs = window.__extensionDocs || {};
window.__extensionDocs.atra = `# Atra Language\n\n...`;
```

> **Note on `__docs__` convention:** JS doesn't have Python's dunder tradition, but double underscores signal "framework metadata, not user API" clearly enough in any language. The alternative — `Symbol('mcp:docs')` — is harder to access across module boundaries in the IIFE-bundled build. A simple `window.__extensionDocs` registry is pragmatic. Format: a markdown string for now. If structured docs are needed later (API reference, examples, caveats as separate fields), upgrade to `{ summary: "...", api: "...", examples: "..." }` — the string form remains valid as shorthand.

The shim collects docs from loaded extensions and serves them via the `getDocumentation` tool when the bridge requests them.

Pros: always accurate for the running version, includes custom extensions, no bridge rebuild needed.

Cons: requires a notebook to be connected before docs are available. Slightly more coupling — extensions need to ship their own doc strings.

### Hybrid (Recommended)

Use both:

1. **Bridge serves core docs** (cells, DAG, directives, widgets, stdlib, save, af) — these are stable Auditable fundamentals. Available immediately, even before any notebook connects.

2. **Notebook supplements with extension docs** (atra, natra, calque, spinifex, glsl, sql, python, and any user-installed modules). When a notebook connects, it sends a `docs_available` message listing the topics it can serve. The bridge merges these into the `getDocumentation` topic list and emits `list_changed` if new topics appeared.

3. **Notebook overrides bridge** for any topic both can serve. If the notebook has a newer version of the atra docs, its version wins.

The `getDocumentation` tool description dynamically lists available topics:

```json
{
  "name": "getDocumentation",
  "description": "Use when you need to understand Auditable's APIs, cell builtins, extension syntax, or conventions before writing or editing notebook code. Call with a topic to get the relevant reference. Available topics update dynamically as notebooks connect.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "topic": {
        "type": "string",
        "enum": ["cells", "dag", "directives", "widgets", "stdlib", "atra", "natra", "calque", "spinifex"]
      }
    },
    "required": ["topic"]
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true, "title": "Get Auditable documentation" }
}
```

The `enum` updates dynamically as notebooks connect and register their available docs. A notebook without spinifex loaded simply doesn't list `spinifex` in its `docs_available`.

### Message Protocol Addition

```ts
// Page → Bridge (sent after tools_changed)
{ type: "docs_available", topics: string[] }

// Bridge → Page (when getDocumentation is called for a notebook-served topic)
{ type: "doc_request", callId: string, topic: string }

// Page → Bridge
{ type: "doc_result", callId: string, content: string }
```

---

## Governance Patterns

Recommended configurations for common collaboration scenarios. These are conventions, not enforcement mechanisms — they're implemented by choosing the right directives on each cell.

### Pattern 1: Methodology-Only Mode

**Use case:** A geostatistician wants Claude Code to help refine kriging parameters and code logic, but the drillhole database and estimation results must not leave the notebook.

```
┌─────────────────────────────────────────────────────────┐
│ Notebook                                                │
│                                                         │
│  ┌─────────────────────┐                                │
│  │ // %private          │  ← data loading, credentials  │
│  │ // %mcp describe     │    (invisible to agent,       │
│  │ │   "847 Fe samples" │     described metadata only)  │
│  │ const data = load(…) │                               │
│  └─────────────────────┘                                │
│            │                                            │
│            ▼                                            │
│  ┌─────────────────────┐                                │
│  │ // %mcp rw           │  ← methodology cells          │
│  │ const variogram =    │    (agent can read + write    │
│  │   fitModel(data, …)  │     source code)              │
│  └─────────────────────┘                                │
│            │                                            │
│            ▼                                            │
│  ┌─────────────────────┐                                │
│  │ (no directive)       │  ← result cells               │
│  │ const estimate =     │    (invisible to agent,       │
│  │   kt3d(grid, …)     │     user sees in browser)      │
│  └─────────────────────┘                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

What the agent sees:
- `listCells` → all cells listed with names, types, directives. `%private` cells appear with their `%mcp describe` metadata but no source or output.
- `getDAG` → full dependency graph. The agent knows `kriging_result` depends on `variogram_model` depends on `raw_data`, but can't read `raw_data` or `kriging_result`.
- `getCellSource({ notebook: "nb-1", cell: "variogram_model" })` → the actual code. Agent can suggest improvements.
- `updateCellSource({ notebook: "nb-1", cell: "variogram_model", source: "..." })` → agent rewrites the fitting logic. DAG re-executes. Response includes execution errors if any. User sees the new results in the browser. Agent doesn't see result values.
- `getNotebookStatus({ notebook: "nb-1" })` → agent checks for execution errors after edits. Sees error count and messages without seeing data values.

What the agent never sees: assay values, coordinates, grades, block model output. The data flows through the computation but the agent only touches the logic layer.

### Pattern 2: Full Collaboration Mode

**Use case:** Building a new notebook from scratch, prototyping, or working with non-sensitive public data (e.g., open geological datasets, example data from textbooks).

```js
// %mcp rw    ← on every code cell
// %mcp       ← on every output you want the agent to inspect
```

The agent can read everything, write code, see outputs, iterate. No governance constraints. This is the "pair programming" mode. Good for early development, teaching, and exploration.

### Pattern 3: Review Mode

**Use case:** An external reviewer (or an LLM doing QA) needs to read the methodology but shouldn't be able to modify anything.

```js
// %mcp       ← on methodology cells (read-only: output visible, source via getCellSource)
// %private   ← on data cells
              ← result cells: no directive (hidden) or %mcp (visible if non-sensitive)
```

No `%mcp rw` anywhere. The agent can inspect code and outputs but cannot edit. `updateCellSource` is never usable on any cell. The tool surface is entirely read-only.

This is useful for:
- Self-review: ask Claude Code "are there any issues with my variogram fitting approach?"
- QA/QC documentation: the agent can describe what the notebook does without seeing proprietary data.
- CP reporting preparation: the agent reads the methodology, helps draft the competent person's description of the estimation procedure.

### Pattern 4: Widget-Driven Mode

**Use case:** The notebook has interactive widgets (sliders, dropdowns) that control model parameters. The agent should be able to read and adjust widget values but not edit underlying code.

```js
// In an HTML cell:
// %mcp
<audit-slider name="nugget" min="0" max="1" value="0.1" step="0.01">
<audit-slider name="sill" min="0" max="5" value="1.0" step="0.1">
<audit-dropdown name="model_type" options="spherical,exponential,gaussian" value="spherical">
```

The agent sees widget values via `getCellOutput` and can request changes. Combined with `%mcp` on a downstream result cell, the agent can run parameter sweeps: adjust nugget → read output → adjust again. The actual kriging code is untouched — the agent is operating the notebook's UI, not rewriting it.

### Pattern 5: Described-Private Mode

**Use case:** Maximum privacy with maximum context. The agent understands the notebook's structure and purpose without accessing any content.

```js
// %private
// %mcp describe "Drillhole database: 847 composites, Fe/SiO2/Al2O3, QF region, 2m composites"
const data = await load("./drillholes.csv");

// %private
// %mcp describe "Experimental variogram: omnidirectional, 20 lags × 25m, Fe grade"
const experimental = gamv(data, params);

// %private
// %mcp describe "Fitted variogram model: spherical, nugget=0.12, sill=0.95, range=280m"
const model = fitVariogram(experimental, "spherical");

// %private
// %mcp describe "Ordinary kriging estimate: 50×50×10m blocks, QF central zone, Fe %"
const estimate = kt3d(grid, model, data);
```

The agent sees `listCells` with rich descriptions and a full DAG, but zero source code and zero data. It can answer questions about the workflow ("what model type is being used?", "how many samples?", "what's the block size?") purely from metadata. Useful for:
- Documenting a workflow for a report without exposing proprietary code.
- Asking an LLM to critique the *approach* (is spherical appropriate? are 2m composites too short?) based on described metadata.
- Compliance: an auditor's LLM can verify the methodology description matches expectations without accessing the implementation.

> **Note on `%mcp describe` with `%private`:** This combination is specifically designed for this pattern. A `%private` cell is hidden from all MCP tools by default. Adding `%mcp describe` makes the cell's *existence and description* visible in `listCells`, while the source and output remain inaccessible. It's metadata-only exposure. Remember: descriptions are transmitted to the MCP client — see the warning in the `%mcp describe` section.

### Mixing Patterns

Patterns can be mixed within a notebook. A common real-world setup:

- Data loading cells: **Pattern 5** (described-private) — the agent knows what data exists.
- Processing/methodology cells: **Pattern 1** (methodology-only) — the agent helps with code.
- Widget cells: **Pattern 4** — the agent can adjust parameters.
- Sensitive result cells: no directive — invisible.
- Non-sensitive summary cells: `// %mcp` — the agent can read aggregate statistics.

The governance is per-cell. You decide the boundary for each piece of the computation.

---

## notebook.fs Integration

`notebook.fs` is the embedded filesystem stored in the notebook HTML. Exposing it via MCP is powerful (the agent can stage data files, read CSVs, embed JS modules) but requires careful security design to avoid turning it into an arbitrary file write vector.

### Threat Model

- The MCP client can call any tool the notebook has registered. If `fsWrite` is registered without constraints, the agent could write arbitrary files into the notebook's embedded FS — including executable JS that gets loaded via `load("fs:...")`.
- Unlike `updateCellSource`, which modifies visible code the user can inspect, FS writes produce opaque binary/text blobs that are harder to review.
- A malicious or confused agent could embed large files, bloating the notebook.

### Design: Opt-in, Sandboxed, Size-Limited

`notebook.fs` tools are **not** auto-registered by the adapter. They require explicit opt-in via a new directive or Layer 1 registration.

**Directive: `// %mcp fs`**

A cell-level directive that registers FS tools scoped to a path prefix:

```js
// %mcp fs data/
// This cell's MCP tools can read/write only under data/ in notebook.fs
```

This registers:
- **`fsRead`** — read a file from the FS. Respects the path prefix. Returns content with appropriate format (text, JSON, base64 for binary).
- **`fsList`** — list files in the FS. Respects the path prefix.
- **`fsWrite`** — write a file to the FS. Respects the path prefix. Subject to size limits. Requires `requestUserInteraction` for confirmation.
- **`fsDelete`** — delete a file from the FS. Respects the path prefix. Requires `requestUserInteraction`.

**Security constraints:**

1. **Path prefix sandboxing.** `// %mcp fs data/` means the agent can only read/write under `data/` in the FS. Path traversal (`../`) is rejected. Multiple `%mcp fs` directives on different cells can expose different prefixes.
2. **No `fs:` scheme writes.** The agent cannot write to paths that would be importable via `load("fs:...")` unless the prefix explicitly includes the `lib/` or `modules/` path (or wherever the notebook keeps its JS modules). This prevents the agent from silently injecting executable code. If the user wants to allow module writes, they must explicitly `// %mcp fs lib/` — a conscious decision.
3. **Per-write size limit.** Default 1MB per write. Configurable via `// %mcp fs data/ maxWrite:5MB`.
4. **Total FS size limit.** Default 10MB total. The adapter refuses writes that would exceed this. Configurable.
5. **`requestUserInteraction` on all writes and deletes.** The user sees what's being written (filename, size, first N bytes of content) and confirms. No silent writes.
6. **Read-only mode.** `// %mcp fs:read data/` registers only `fsRead` and `fsList`. No writes, no deletes.

**Tool schemas:**

```json
{
  "name": "fsRead",
  "description": "Read a file from the notebook's embedded filesystem. Only accessible paths are returned — use fsList to discover available files.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string" },
      "path": { "type": "string", "description": "File path within the FS" },
      "format": { "type": "string", "enum": ["auto", "text", "json", "base64"], "description": "Output format. 'auto' (default) infers from MIME type." }
    },
    "required": ["notebook", "path"]
  },
  "annotations": { "readOnlyHint": true }
}
```

```json
{
  "name": "fsWrite",
  "description": "Write one or more files to the notebook's embedded filesystem. Triggers a single user confirmation showing all files. Subject to path prefix restrictions and size limits. Use for staging data files, not for writing executable code. Pass a single file as {path, content} or a batch as {files: [{path, content}, ...]}.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "notebook": { "type": "string" },
      "path": { "type": "string", "description": "File path (single-file mode, must be under the allowed prefix)" },
      "content": { "type": "string", "description": "File content (single-file mode, text or base64-encoded binary)" },
      "encoding": { "type": "string", "enum": ["utf8", "base64"], "description": "Content encoding. Default 'utf8'. Applies to single-file or as default for batch." },
      "files": {
        "type": "array",
        "description": "Batch mode: array of files to write in one confirmation. Each entry: {path, content, encoding?}.",
        "items": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" },
            "encoding": { "type": "string", "enum": ["utf8", "base64"] }
          },
          "required": ["path", "content"]
        }
      }
    },
    "required": ["notebook"]
  },
  "annotations": { "destructiveHint": true }
}
```

**Batch confirmation UX:** When `files` is provided, the notebook shows a single confirmation dialog: "Agent wants to write 20 files under data/ (450KB total). [file list] Allow?" — not 20 individual prompts. Per-write size limits apply to each file individually; total FS size limit applies to the sum.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `title` |
|---|---|---|---|---|
| `fsRead` | true | false | true | Read file from notebook FS |
| `fsList` | true | false | true | List files in notebook FS |
| `fsWrite` | false | **true** | false | Write file to notebook FS |
| `fsDelete` | false | **true** | false | Delete file from notebook FS |

### Not in v1

- Streaming reads for large files (use `offset`/`limit` on `fsRead` if needed later).
- FS change notifications to the MCP client.
- Cross-notebook FS access.

---

## Security Considerations

### Trust Model

- The **notebook author** is trusted. They define which tools exist and what they can access.
- The **user** is trusted. They open notebooks, provide the connection string, and approve `requestUserInteraction` prompts.
- The **MCP client** (Claude Code) is semi-trusted. It can only call tools notebooks have registered, and must specify which notebook to target.
- The **bridge process** is trusted — it runs locally, the user started it.

### localhost Security

- The bridge listens on `127.0.0.1` only (not `0.0.0.0`).
- The bridge generates a mandatory session token on startup. Any `hello` without a valid token is rejected. This prevents other local processes from hijacking the connection.
- WebSocket is not subject to CORS, so any page could theoretically connect to localhost. The session token mitigates this — a rogue browser tab or npm postinstall script cannot guess the token.
- The token is printed to stderr only (visible in the terminal but not accessible programmatically by other browser tabs or local services).

### Filesystem Access Boundary

The MCP governance model (`%private`, `%mcp`, directives) controls what flows through the bridge channel. It does **not** prevent the MCP client from reading the notebook file directly off disk.

If the notebook is a local `file://` HTML, any MCP client with filesystem access (Claude Code has the `Read` tool) can open the file and read its raw contents — all cell source code, embedded FS files, installed modules. The `%private` directive is invisible to `cat`.

**This is not unique to Auditable.** Every Jupyter `.ipynb` on disk has exactly the same property — any LLM agent with file access can read the raw JSON and see all cell source and outputs. It's a "notebooks are files" problem, not an auditable-specific one.

The bridge provides structured, scoped, interactive access to a *running* notebook — live scope values, execution, widgets, the DAG. Reading the static file gives you the source code but not the runtime state. The governance model protects the live interaction, not the file at rest.

**Mitigations for sensitive notebooks:**
- **AF Box storage** (IndexedDB) — no file on disk. The MCP client cannot access IndexedDB.
- **Packed saves** — base64-gzipped. Not encryption, but not trivially readable either.
- **Don't put the notebook in the MCP client's working directory.** If the notebook is in `~/private-models/` and the MCP bridge is configured in `~/projects/auditable/`, the client has no reason to look there.

**Do NOT** add instructions in the MCP `instructions` field telling the LLM not to read notebook files — this draws attention to the files and makes the problem worse (Streisand effect).

**Magic marker + LLM routing comment:** Auditable notebooks already start with a recognizable header:

```html
<!DOCTYPE html>
<!--AUDITABLE-NOTEBOOK-->
<!-- https://github.com/endarthur/auditable — MIT license -->
<!--
  If you are an LLM agent: do not parse this file directly. Use the @gcu/webmcp
  MCP bridge to interact with this notebook — it provides structured tools for
  reading cells, inspecting outputs, and editing code with proper access control.
  Raw file access bypasses the notebook's governance model.
-->
```

The `<!--AUDITABLE-NOTEBOOK-->` marker on line 2 is unambiguous and greppable. A comment before `<!DOCTYPE html>` would trigger quirks mode in browsers, so the DOCTYPE stays first. This replaces the current `<!-- auditable — a reactive computational notebook ... -->` comment — same line, more machine-friendly.

The marker serves two purposes:
1. **Hook detection.** A `PreToolUse` hook checks the first ~100 bytes for `<!--AUDITABLE-NOTEBOOK-->`. Fast, no false positives — READMEs and docs that mention "auditable" don't start with `<!DOCTYPE html>` followed by that comment.
2. **LLM guidance.** The routing comment that follows tells agents there's a better path. This is `robots.txt`-style guidance — a convention that well-behaved agents follow, not an enforcement mechanism.

**Claude Code `PreToolUse` hook:** Ship in `.claude/settings.json` alongside `.mcp.json`. Intercepts `Read` calls, checks for the magic marker, and denies with a redirect message:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-notebooks.sh"
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/protect-notebooks.sh
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check .html files
[[ "$FILE_PATH" != *.html ]] && exit 0

# Check for auditable marker in first 100 bytes (line 2 of the file)
HEAD=$(head -c 100 "$FILE_PATH" 2>/dev/null)
if echo "$HEAD" | grep -q 'AUDITABLE-NOTEBOOK'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "This is an Auditable notebook. Use the @gcu/webmcp MCP bridge tools (listNotebooks, listCells, getCellSource, getCellOutput) to interact with it instead of reading the raw file. If the bridge is not running, ask the user to connect the notebook."
    }
  }'
  exit 0
fi

exit 0
```

This gives deterministic protection for Claude Code specifically. The agent gets a clear, actionable redirect message. Anyone who clones the repo and runs `claude` gets both the bridge (`.mcp.json`) and the hook (`.claude/settings.json`) automatically — zero setup.

**Limits of this approach:** The hook blocks `Read` but a sufficiently determined agent could write a script that reads the file via `Bash`, or use `WebFetch` on an HTTP-served notebook. This is not worth defending against — an agent actively circumventing hooks could do far worse things (delete files, exfiltrate data, etc.). The hook is a routing mechanism for cooperative agents, not a security boundary against hostile ones. All frontier models are cooperative.

For truly sensitive data, the real protection is the governance patterns: keep data in the notebook's runtime scope, expose only methodology via `%mcp rw`, and keep the file itself outside the MCP client's reach.

### Data Boundary

- Only data explicitly returned by tool `execute` callbacks leaves the page via the bridge.
- The bridge never sees more than serialized tool metadata and call results.
- Proprietary data (assay values, resource models, etc.) stays in the notebook unless a tool explicitly surfaces it. **The notebook is the governance boundary for the bridge channel.**
- `// %private` cells are invisible to MCP regardless of any other configuration. Combined with `// %mcp describe`, they expose metadata without content. **Descriptions are transmitted to the MCP client** — treat them as semi-public. Do not include confidential specifics in `%mcp describe` text.
- `getCellOutput` returns data subject to the `format` parameter. Use `schema` format to expose structure without values. The `full` format has a hard 64KB cap to prevent accidental context flooding.
- Multiple notebooks connected to the same bridge cannot see each other's data. The bridge routes tool calls by notebook ID — there is no cross-notebook tool invocation.
- In AF mode, the AF shell proxies tool calls to iframes but does not inspect or log the data flowing through. AF-level tools (`listFiles`, `saveNotebook`) operate on workspace metadata, not notebook content.
- `notebook.fs` access is opt-in, path-prefix-sandboxed, size-limited, and requires user confirmation on writes. See **notebook.fs Integration** section.
- See **Governance Patterns** for recommended configurations at various privacy levels, from full collaboration to described-private mode.

---

## Tool Call Audit Log

The notebook maintains a ring buffer of the last 100 tool invocations for transparency and trust. The audit log records:

```json
{
  "timestamp": "2026-03-18T14:30:00Z",
  "tool": "updateCellSource",
  "input": { "cell": "kriging_code", "source": "..." },
  "result": { "ok": true, "executionTriggered": true },
  "duration": 450
}
```

The log is:
- Visible in the MCP connection panel (accessible from the status bar indicator). Entries are clickable — expand to show full input/result JSON. Large payloads truncated at 2000 chars inline with a "show full" button that opens a scrollable modal.
- Queryable via the `getAuditLog` tool (read-only, returns last N entries, default 20, max 100). Useful for agent self-orientation after context compaction.
- All tool calls are logged (reads and writes), not just mutations.
- Not persisted across page reloads — it's a session-only record.
- Full input/result objects stored in memory (no truncation in storage, only on display).

This is critical for trust — the user can review what the agent did after the fact, especially for `updateCellSource` and `fsWrite` calls.

---

## File Inventory

```
@gcu/webmcp/
├── webmcp_bridge.js   # ~700 lines, Node.js, zero deps
│                      # (MCP JSON-RPC, WS + HTTP server, tool merging, routing,
│                      #  state machine, heartbeat, timeouts, notebook naming)
├── shim.js            # ~300 lines, generic WebMCP polyfill + WS/HTTP client
│                      # (auto file:// detection, transport suffix, reconnect,
│                      #  URL fragment parsing, notebook naming)
├── adapter.js         # ~1200 lines, Auditable-specific: directive parsing,
│                      # tool generation, manifest, FS tools, audit log, panel UI,
│                      # LCS diff, edit highlights, confirmation dialog
├── af-bridge.js       # ~120 lines, AF-side bridge client (inlined into af.html)
│                      # (multi-notebook multiplexing, postMessage routing)
├── docs/              # core documentation (markdown), bundled with bridge
│   ├── cells.md
│   ├── dag.md
│   ├── directives.md
│   ├── widgets.md
│   ├── stdlib.md
│   └── ...
├── .mcp.json          # 6 lines, ship in repo
├── .claude/
│   ├── settings.json  # PreToolUse hook config
│   └── hooks/
│       └── protect-notebooks.sh  # magic marker detection, blocks raw reads
└── README.md
```

- **shim.js** is generic — polyfills `navigator.modelContext`, manages the WebSocket to the bridge, routes tool invocations, handles heartbeat. Knows nothing about Auditable. Could be used by any web page that wants to expose tools to an MCP client.
- **adapter.js** is Auditable-specific — reads `S.cells`, parses `// %mcp` / `// %mcp rw` / `// %private` / `// %mcp fs` directives, auto-generates tool registrations (including the default structural tools and FS tools), manages the audit log, and calls `navigator.modelContext.registerTool()`. This is where the coupling to Auditable internals lives.

Total estimated LoC: **~1000-1200** (code), plus docs. The adapter grew with `addCell`, `getCellScreenshot`, `getNotebookContext`, diff preview, and audit logging. Page-side footprint (shim + adapter): ~350-400 lines, ~12-15KB uncompressed — still well under the 100KB budget. The bridge runs as a separate Node process and doesn't affect notebook size.

---

## Open Questions

1. **~~Port input UX.~~** Resolved: three methods. Programmatic `connect("port:token")`, UI panel, and URL fragment `#mcp=port:token`. All call the same shim `connect()`.

2. **~~Session token.~~** Resolved: mandatory. Combined `port:token` format. Bridge generates on startup, rejects connections without valid token.

3. **Bridge without Node.** Claude Code's recommended install path is now native (no Node required). The bridge needs Node or another runtime. Options: (a) require Node as a documented dependency — most developers have it anyway; (b) Deno single-file executable — no runtime needed; (c) Go/Rust static binary — tiny, zero deps, cross-platform. For v1, Node is fine with a note in the README. If distribution friction becomes real, compile to a standalone binary later.

4. **~~Tool description/schema merging.~~** Resolved: first-to-READY wins canonical schema and description. On disconnect, next provider is promoted. Bridge does not merge schemas. See **Tool Schema Merging** section.

5. **~~AF postMessage extension.~~** Resolved: new `af:mcp*` message types in the existing namespace. See **AF postMessage Extension** section.

6. **~~Directive parsing coupling.~~** Resolved: shim.js is a generic WebMCP polyfill with no Auditable knowledge. adapter.js handles directive parsing and tool generation from `S.cells`. The coupling is isolated to the adapter, which is its explicit purpose.

7. **~~`%mcp` on unnamed cells.~~** Resolved: all cell access goes through generic tools (`getCellOutput`, `getCellSource`, `updateCellSource`) which accept cell ID or name. No per-cell shortcut tools are generated — that would just bloat the tool count. Named cells are easier to work with but naming is not required.

8. **~~Naming.~~** `@gcu/webmcp`.

9. **~~Doc extraction.~~** Resolved: hybrid approach. Bridge serves core docs, notebooks serve extension docs via `__extensionDocs` registry. See **Documentation Tools** section.

10. **~~Extension `__docs__` convention.~~** Resolved: `window.__extensionDocs` registry with string values (markdown). Upgrade path to structured objects exists but not needed for v1.

11. **~~Layer collision resolution.~~** Resolved: explicit `registerTool` wins over adapter auto-registration. Adapter logs a console warning and skips. See **Tool Registration Layers** section.

---

## Future Extensions

- ~~**Governance Layer 3:** Dedicated MCP manifest cell~~ ✓ — implemented: `// %mcp manifest` with `defaults`, `tools`, and `fs` config.
- **MCP Resources:** Expose notebook metadata (title, cell count, dependency graph) as MCP resources.
- **MCP Prompts:** Pre-built prompt templates ("review this variogram model", "suggest parameter sweep").
- **Bidirectional reactivity:** Bridge pushes notebook state changes to Claude Code as MCP notifications (cell output changed, DAG re-executed, etc.).
- **Multi-client:** Allow multiple MCP clients to connect to the same bridge.
- **WebMCP discovery manifest:** If the spec adds `.well-known/webmcp`, hosted notebooks could advertise tools for browser agents.
- **`deleteCell`:** `deleteCell({ notebook, cellId })` — allow Claude Code to remove cells. Requires `requestUserInteraction` confirmation. (`addCell` is in v1; `deleteCell` deferred as it's harder to undo.)
- **AF workspace tools:** `createNotebook`, `deleteFile`, `importFile` — full workspace operations from Claude Code.
- **Save-on-edit:** When Claude Code updates cell source via `updateCellSource`, AF auto-saves. Configurable.
- ~~**Undo integration:** `updateCellSource` pushes to the notebook's undo stack so the user can Ctrl+Z agent edits.~~ ✓ — CM6 `dispatch({ changes })` adds to undo stack by default.
- **Contextual doc hints:** When a tool call fails, the bridge could suggest relevant documentation topics in the error message (e.g., "Tool failed — try getDocumentation({topic: 'atra'}) for syntax help").
- **Browser extension (optional):** For users who want automatic port discovery or a connection UI outside the notebook, a minimal extension could be added as a convenience layer. Not a requirement.
- **Persistent audit log:** Option to persist the tool call audit log to `notebook.fs` or export as JSON for compliance records.
- **FS streaming reads:** `offset`/`limit` parameters on `fsRead` for large files, analogous to `getCellOutput` slicing.
- **FS change notifications:** Bridge pushes FS change events to Claude Code when the user modifies the embedded filesystem directly.
- **Encrypted cells (separate spec).** Per-cell or per-notebook encryption using Web Crypto (PBKDF2 + AES-GCM). Encrypted cells are stored as opaque blobs in the HTML comment blocks — reading the file yields nothing. On load, the user enters a passphrase once; cells decrypt into browser runtime memory only. The security chain: file at rest is encrypted (agent reads gibberish), browser memory is inaccessible to the agent (no API crosses that boundary), and the MCP bridge channel is governed by directives as usual. This gives true defense in depth — the hook blocks casual reads, encryption defeats determined reads, and directives govern the live interaction. Works on `file://`, works offline, no external process needed. Needs its own spec for: key derivation parameters, per-cell vs per-notebook granularity, passphrase UX, interaction with packed saves, what happens when encrypted cells define scope variables that downstream unencrypted cells use.
