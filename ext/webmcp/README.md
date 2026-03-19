# @gcu/webmcp

MCP bridge connecting Claude Code (or any MCP stdio client) to running Auditable notebooks in the browser.

```
┌──────────────────┐
│  Notebook A      │──┐
│  (browser tab)   │  │  WS or HTTP    ┌──────────┐  stdio   ┌─────────────┐
└──────────────────┘  ├─localhost────►│  Bridge  │◄────────►│ Claude Code │
┌──────────────────┐  │               │ (node)   │  MCP     │             │
│  Notebook B      │──┘               └──────────┘          └─────────────┘
│  (browser tab)   │
└──────────────────┘
```

## Quick Start

1. Start Claude Code in the auditable repo (`.mcp.json` auto-registers the bridge).
2. Open a notebook in the browser.
3. In Claude Code: call `getConnectionInfo` to get the connection string (`port:token`).
4. In the notebook: ellipsis menu > **mcp** > paste the connection string > **connect**.
   Or append `#mcp=port:token` to the notebook URL.
5. In Claude Code: call `listNotebooks` to see connected notebooks, then use tools like `listCells`, `getCellSource`, `getCellOutput`, etc.

## Files

| File | Location | Purpose |
|------|----------|---------|
| `webmcp_bridge.js` | repo root | Node.js bridge: MCP stdio + WebSocket server, tool merging, routing |
| `src/js/shim.js` | bundled into auditable.html | Generic WebMCP polyfill: `navigator.modelContext`, WS/HTTP client, reconnect, auto file:// detection |
| `src/js/mcp-adapter.js` | bundled into auditable.html | Auditable-specific: tool registrations, access control, audit log, panel UI |
| `.mcp.json` | repo root | MCP server config (auto-detected by Claude Code) |

The bridge is a single zero-dependency Node.js script. The shim and adapter are bundled into every auditable notebook at build time.

## Access Control

Auditable uses per-cell directives to control what an MCP agent can see and do:

| Directive | Effect |
|-----------|--------|
| *(none)* | Cell is effectively private. Listed with index/type only. |
| `// %mcp` | Read-only. Agent can read source and output. |
| `// %mcp r` | Same as `// %mcp` (alias for symmetry). |
| `// %mcp rw` | Read-write. Agent can read and update source. |
| `// %private` | Hard opt-out. Cannot be overridden by manifest. |
| `// %mcp describe "..."` | Metadata for private cells. Description is visible in `listCells`. |
| `// %mcp fs data/` | Allow agent to read/write notebook.fs under `data/`. |
| `// %mcp fs:read data/` | Allow agent to read (not write) notebook.fs under `data/`. |
| `// %mcp fs *` | Allow agent full access to notebook.fs. |

Precedence: `%private` > `%mcp rw` > `%mcp` > manifest tool-level > manifest defaults > none.

In HTML cells, `// %` directives are stripped from the rendered output — they work for access control but don't appear visually.

### Filesystem Sandboxing

The `fsList`, `fsRead`, `fsWrite`, and `fsDelete` tools are gated by `// %mcp fs` directives. Without at least one `%mcp fs` directive (or manifest `fs` config), all fs tools return an error.

- Multiple `%mcp fs` directives across cells are combined (union of prefixes).
- `fs:read` prefixes only allow `fsList` and `fsRead`, not writes or deletes.
- Path traversal (`../`) is rejected by `validatePath`.
- Writes and deletes always require user confirmation regardless of prefix.

Manifest equivalent:

```js
// %mcp manifest
({
  fs: "data/",                          // shorthand
  fs: { prefix: "data/", readOnly: true },  // explicit
  fs: "*",                              // allow all
})
```

### Manifest Cell (Layer 3)

A single cell can declare the governance policy for the entire notebook:

```js
// %mcp manifest
({
  defaults: "rw",    // all cells default to read-write
  tools: {
    "loadData":   { cell: "data loader", describe: "Load CSV drill data" },
    "runKriging": { cell: 4, describe: "Execute kriging", access: "rw" },
  },
})
```

- **`defaults`** — fallback access for cells without directives: `"rw"`, `"read"`, `"private"`.
- **`tools`** — named tool aliases. The agent sees `loadData` instead of `getCellOutput(cellIndex: 3)`. Each tool runs its target cell and returns the output. Cells are referenced by `%cellName` or index.
- **Tool-level `access`** — overrides manifest defaults for specific cells.
- The manifest cell itself is always private (the agent can't read or modify governance config).

Per-cell directives (`%mcp`, `%private`) always override manifest settings.

## Tools

### Bridge Built-ins

| Tool | Description |
|------|-------------|
| `listNotebooks` | Discover connected notebooks. Returns IDs, titles, transport type. No `notebook` param needed. |
| `getConnectionInfo` | Returns the port:token connection string. Use to get credentials for connecting a notebook. |

### Notebook Tools

All notebook tools require a `notebook` parameter (injected by the bridge):

| Tool | Access | Description |
|------|--------|-------------|
| `listCells` | any | List cells with index, type, access level, defines, errors |
| `getCellSource` | read | Get cell source code |
| `getCellOutput` | read | Get cell output (structured). Supports format, path drilling, array slicing |
| `getCellScreenshot` | read | Capture canvas output as PNG, or text content |
| `updateCellSource` | rw | Update cell source via full replacement (`code`) or surgical patches (`patches`: array of {old, new}). Shows diff confirmation. Triggers reactive execution |
| `addCell` | any | Add a new cell. Requires user confirmation |
| `setWidgetValue` | rw | Set a widget value (slider, dropdown, checkbox, text-input). Triggers reactive execution or callback |
| `runCell` | any | Execute a cell and its dependents |
| `runAll` | any | Execute all cells |
| `getDAG` | any | Get dependency graph (defines, uses, edges) |
| `getNotebookStatus` | any | Title, cell count, autorun state, errors |
| `getNotebookContext` | any | Quick orientation: cells, scope, errors, autorun |
| `pauseAutorun` | any | Pause reactive execution (batch edits) |
| `resumeAutorun` | any | Resume reactive execution, run all |
| `getDocumentation` | any | Builtin API docs, extension docs, notebook.fs docs |
| `getAuditLog` | any | Recent tool call history (last 100). An **export** button downloads the full audit log as JSON for compliance records |
| `fsList` | any | List files in notebook embedded filesystem |
| `fsRead` | any | Read file from embedded filesystem |
| `fsWrite` | any | Write file to embedded filesystem (confirmation required) |
| `fsDelete` | any | Delete file from embedded filesystem (confirmation required) |

### Custom Tools (via Manifest)

When a manifest defines `tools`, each entry becomes a named MCP tool that runs its target cell and returns the output. If the cell is writable, the agent can pass `code` to update the source before running.

## User Confirmation

Mutation tools (`updateCellSource`, `addCell`, `fsWrite`, `fsDelete`) show a confirmation dialog in the notebook:

- **Accept** — allow this operation
- **Accept All** — allow all operations for the session (resets on disconnect)
- **Reject** — deny the operation (tool call returns an error)

For `updateCellSource`, the dialog shows a line-based diff of the proposed change.

## Patches Mode

`updateCellSource` supports two modes:

- **Full replacement**: `{ index: 5, code: "..." }` — replaces the entire cell source.
- **Patches**: `{ index: 5, patches: [{ old: "ctx.lineWidth = 2", new: "ctx.lineWidth = 3" }] }` — surgical search-and-replace. Each patch's `old` string must be unique in the cell.

Patches are applied in order. If any `old` string is not found, the tool errors before applying anything. The confirmation dialog shows the same LCS diff regardless of mode.

## Widget Interaction

`setWidgetValue` lets the agent adjust widget values without editing code:

```json
{ "index": 5, "name": "smoothWindow", "value": 3 }
```

Works with all four widget types: slider (number), dropdown (string), checkbox (boolean), text-input (string). Triggers the same reactive execution or callback as user interaction. Requires `rw` access and user confirmation.

## Connection

### Programmatic

```js
window.__auditable_mcp.connect("port:token");
```

### URL Fragment

```
notebook.html#mcp=port:token
```

### MCP Panel

Ellipsis menu > **mcp** > enter `port:token` > **connect**. Toggle with **Ctrl+M**. The panel also shows connection status and the audit log.

### Notebook Naming

Notebooks derive their MCP ID from the document title (e.g., "WebMCP bridge" → `webmcp-bridge`). Override via the **name** field in the MCP panel. If left empty, the derived name is used. Same name + same page = reconnect reuses the ID. Same name + different page = appends `-2`, `-3`, etc.

### Status Indicator

The statusbar shows `mcp` (green) when connected, `mcp...` (amber) when connecting.

### Transport

The shim tries WebSocket first. On `file://` origins (where WS is blocked by browsers), it falls back to HTTP long-polling automatically. Force a transport with a suffix:

- `port:token` — auto-detect (WS on HTTP origins, HTTP on `file://`)
- `port:token:http` — force HTTP polling
- `port:token:ws` — force WebSocket (no-op on HTTP origins)

The bridge serves both transports on the same port via `http.createServer` + `upgrade` handler.

## Hook Setup

The bridge can install a Claude Code hook that redirects raw file reads to the MCP tools:

```bash
node webmcp_bridge.js --setup
```

This creates `.claude/hooks/protect-notebooks.js` and adds a `PreToolUse` hook to `.claude/settings.json`. The hook detects the `<!--AUDITABLE-NOTEBOOK-->` magic marker in HTML files and blocks direct reads with a message steering toward MCP tools.

## Protocol

### Session Token

The bridge generates a random token on startup: `crypto.randomBytes(12).toString('hex')`. Connections without a valid token are rejected.

### WebSocket / HTTP Messages (Bridge <-> Notebook)

| Direction | Type | Purpose |
|-----------|------|---------|
| page -> bridge | `hello` | Authenticate with protocol version + token. Includes `name` for notebook ID derivation. |
| bridge -> page | `welcome` | Assign notebook ID |
| page -> bridge | `tools_changed` | Register/update tool list |
| bridge -> page | `tool_invoke` | Execute a tool |
| page -> bridge | `tool_result` | Return tool result |
| page -> bridge | `notification` | Push notification (e.g. execution complete) |
| bridge -> page | `ping` | Heartbeat |
| page -> bridge | `pong` | Heartbeat response |

HTTP transport uses `POST /connect`, `POST /send`, `GET /poll` endpoints with CORS headers. Same message format, different transport.

### MCP (Bridge <-> Claude Code)

Standard MCP JSON-RPC over stdio. The bridge supports:
- `initialize` / `notifications/initialized`
- `tools/list` / `tools/call`
- `notifications/tools/list_changed` (when notebooks connect/disconnect)
- `notifications/execution/complete` (forwarded from notebooks)
- `ping`

### Multi-Notebook Routing

The bridge merges tool definitions across notebooks. If two notebooks both register `listCells`, one MCP tool exists with a `notebook` parameter. Tool count is the union of unique names, not the sum.

When a notebook disconnects, its tools are removed and another provider is promoted if available. The bridge emits `notifications/tools/list_changed` on any change.

## Notifications

The notebook pushes `execution/complete` after every DAG execution:

```json
{
  "notebook": "nb-1",
  "errors": [],
  "cellCount": 12,
  "timestamp": "2026-03-19T10:30:00Z"
}
```

## Governance Patterns

### Methodology-Only (data stays private)

```js
// Cell 0: data loading
// %private
// %mcp describe "Loads drillhole database (proprietary)"
const data = await load("data.csv");

// Cell 1: kriging code
// %mcp rw
const result = krigeOrdinary(data, params);

// Cell 2: visualization
// %mcp
const plot = ui.canvas(600, 400);
drawVariogram(plot, result);
```

The agent can edit the kriging code and see the plot, but never sees the raw data.

### Full Collaboration

```js
// %mcp manifest
({ defaults: "rw" })
```

All cells readable and writable. Use `%private` on specific cells to opt out.

### Review Mode

All cells `// %mcp` (read-only). The agent inspects but can't modify.

### Widget-Driven

HTML cells with `<audit-slider>` / `<audit-dropdown>` exposed via `// %mcp rw`. The agent adjusts parameters through widget values without touching code.

## Requirements

- Node.js (for the bridge process)
- Any modern browser (for the notebook)
- Claude Code or any MCP stdio client
