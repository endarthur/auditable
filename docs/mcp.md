# MCP Bridge

Connect AI agents (like Claude Code) to a running auditable notebook. The MCP (Model Context Protocol) bridge lets agents read cells, edit source, set widgets, run code, and access the notebook filesystem — all under your control.

!!! tip "Driving the whole desktop?"
    This page is the **standalone-notebook** bridge. To connect an agent to the
    entire **Auditable Works** workspace — files, surfaces, and every notebook,
    under A-Bus capability grants — see [Agent Access (numen for Works)](works-agent.md).

---

## Quick start

1. The bridge starts automatically when Claude Code opens a project with `.mcp.json`.
2. In the notebook, open the **MCP panel** (connection icon in the toolbar, or ++ctrl+m++).
3. Paste the connection string shown by the bridge (`port:token`). Ask the agent for the connection string if not shown.
4. The notebook connects — tools appear in the MCP panel.

!!! tip
    The bridge supports both **WebSocket** (default for HTTP origins) and **HTTP long-polling** (automatic fallback for `file://` origins). Force a transport by appending a suffix: `port:token:ws` or `port:token:http`.

You can also connect via URL fragment — append `#mcp=port:token` to the notebook URL.

---

## Access control

By default, cells are private — agents cannot see or modify them. Use directives to grant access:

| Directive | Access level |
|-----------|-------------|
| `// %mcp` | Read-only (source + output visible) |
| `// %mcp r` | Alias for `// %mcp` |
| `// %mcp rw` | Read-write (source + output readable, source editable) |
| `// %private` | Hard opt-out (overrides manifest defaults) |

```js
// %mcp rw
const data = await fetch("https://api.example.com/data").then(r => r.json());
```

Cells without any MCP directive are effectively private. They appear in `listCells` with their index and type, but source and output are hidden.

!!! info
    Adder (Python) cells use `#` instead of `//` for directives: `# %mcp rw`.

---

## Manifest cell

A single manifest cell sets notebook-wide MCP policy. The manifest cell itself is always private — agents cannot read or modify the governance config.

```js
// %mcp manifest
({
  defaults: "rw",
  tools: {
    "getData": { cell: 0, describe: "Fetch the current dataset" },
    "runAnalysis": { cell: "analysis", describe: "Run the analysis pipeline" }
  },
  fs: "data/"
})
```

| Field | Description |
|-------|-------------|
| `defaults` | Default access for all cells: `"rw"`, `"read"`, or omit for private |
| `tools` | Named custom tools that map to specific cells (by index or `%cellName`) |
| `fs` | Filesystem prefix for agent access (string, object, or `"*"` for full access) |

Custom tools become first-class MCP tools. The agent sees `getData` instead
of `getCellOutput(cellIndex: 0)`. Each tool runs its target cell and returns
the output.

!!! info
    `// %private` always wins — it overrides manifest `defaults` on any cell where it appears. Per-cell directives take precedence over manifest settings.

---

## Available tools

### Read-only tools

| Tool | Description |
|------|-------------|
| `listCells` | List all cells with type, access level, and defines |
| `getCellSource` | Read a cell's source code |
| `getCellOutput` | Read a cell's text output (supports format, path drilling, array slicing) |
| `getCellScreenshot` | Capture a cell's output as a PNG image |
| `getDAG` | Get the dependency graph (defines, uses, edges) |
| `getNotebookStatus` | Notebook state: title, cell count, autorun, locked flag |
| `getNotebookContext` | Full notebook context in one call (cells, scope, errors) |
| `getDocumentation` | Built-in documentation reference |
| `getAuditLog` | Review all agent actions this session (last 100) |
| `getConnectionInfo` | Connection string for the current bridge |

### Mutation tools

| Tool | Description |
|------|-------------|
| `updateCellSource` | Replace or patch a cell's source code |
| `addCell` | Insert a new cell at a given position |
| `setWidgetValue` | Set a widget's value (slider, dropdown, checkbox, text-input) |

### Execution tools

| Tool | Description |
|------|-------------|
| `runCell` | Execute a specific cell and its dependents |
| `runAll` | Run all cells |
| `pauseAutorun` | Pause reactive execution (useful for batch edits) |
| `resumeAutorun` | Resume reactive execution and run all |

### Filesystem tools

| Tool | Description |
|------|-------------|
| `fsList` | List files under an allowed prefix |
| `fsRead` | Read a file from the notebook filesystem |
| `fsWrite` | Write a file to the notebook filesystem |
| `fsDelete` | Delete a file from the notebook filesystem |

!!! note
    Filesystem tools require `// %mcp fs` directives (or manifest `fs` config). Without at least one fs directive, all filesystem tools return an error. Path traversal (`../`) is always rejected.

---

## User confirmation

Mutation tools (`updateCellSource`, `addCell`, `setWidgetValue`, `fsWrite`,
`fsDelete`) trigger a confirmation dialog in the notebook before executing.
For source edits, the dialog shows a line-based diff. You can:

- **Accept** — allow this action
- **Accept All** — auto-accept all actions in this category for the session
- **Reject** — deny the action (the tool call returns an error to the agent)

Code edits, widget changes, cell additions, and filesystem writes are separate
categories. Accepting all in one category does not affect others. Auto-accept
resets when the agent disconnects.

---

## Surgical patches

`updateCellSource` supports both full replacement and surgical patches:

```js
// Full replacement — replaces the entire cell source
{ cell: 0, code: "const x = 42;" }

// Surgical patches — multiple search/replace pairs
{ cell: 0, patches: [
  { old: "const x = 1", new: "const x = 42" },
  { old: "// TODO", new: "// DONE" }
]}
```

Patches are applied in order. Each `old` string must be unique in the cell
source. If any `old` string is not found, the tool errors before applying
anything. The confirmation dialog shows the same diff regardless of mode.

---

## Connection panel

The MCP panel (toolbar icon, or ++ctrl+m++) shows:

- Connection status and transport type (WS or HTTP)
- Connected agent count
- Audit log of all agent actions this session
- Accept/reject controls for pending mutations

The statusbar shows `mcp` (green) when connected and `mcp...` (amber) when
connecting.

!!! tip
    Notebooks derive their MCP ID from the document title (e.g., "WebMCP bridge" becomes `webmcp-bridge`). Override this via the **name** field in the MCP panel.

---

## Governance patterns

### Read-only dashboard

```js
// %mcp manifest
({ defaults: "r" })
```

The agent can read all cells but cannot modify anything.

### Controlled editing

```js
// %mcp manifest
({
  defaults: "r",
  tools: {
    "updateConfig": { cell: "config", describe: "Update configuration", access: "rw" }
  }
})
```

Most cells read-only, specific cells editable via named custom tools.

### Full access with filesystem

```js
// %mcp manifest
({
  defaults: "rw",
  fs: "*"
})
```

All cells readable and writable, full filesystem access. Use `// %private` on
individual cells to opt out.

!!! warning
    Full access means the agent can edit any cell and write to the entire notebook filesystem. Apply `// %private` to cells containing sensitive data.

---

See [Directives](directives.md) for the full directive reference.
