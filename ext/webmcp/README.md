# Auditable MCP adapter

Auditable's MCP **adapter** — it exposes notebook cells and tools to an MCP agent
(Claude Code, Claude Desktop, any stdio MCP client).

> **The bridge, shim, transports, and protocol now live in [`@gcu/numen`](https://github.com/gentropic/numen)**
> (sibling repo `../numen`), the shared GCU bridge used by Auditable, weir, and
> future surfaces. Auditable vendors numen's `shim.js` (as `src/js/shim.js`) and
> points `.mcp.json` at numen's bridge. See numen's `README.md` / `SPEC.md` /
> `TRANSPORTS.md` for the wire protocol, the `fs`/socket transports, multi-surface
> `--watch`, ports/tokens, and distribution (`npx github:gentropic/numen`, JSR, `.mcpb`).
>
> **What lives here (auditable-specific):** the tool registrations + the access
> model — `src/js/mcp-adapter.js` (tools, audit log, panel UI) and
> `src/js/mcp-access.js` (the pure access-level decision, unit-tested in
> `test/mcp-access.test.mjs`).

```
 notebook (browser) ──shim.js──►  @gcu/numen bridge (node)  ◄──stdio──► MCP client
   mcp-adapter.js                  (fs folder or localhost)
   = the tools + access model
```

## Quick start

1. Start Claude Code in the auditable repo — `.mcp.json` launches the numen bridge
   (`node ../numen/numen-bridge.js --app auditable --port 7802`).
2. Open a notebook in the browser.
3. In Claude Code: `getConnectionInfo` → the `port:token` string.
4. In the notebook: ellipsis menu → **mcp** → paste → **connect** (or append
   `#mcp=port:token` to the URL). Toggle the panel with **Ctrl+M**.
5. `listClients` → connected notebooks; then `listCells`, `getCellSource`, etc.

## Access model — "open to read, gated to act"

A notebook you've connected an agent to is **readable by default** — you opened it
to collaborate. Mutation and execution stay human-gated. Directives tune it:

| Directive | Effect |
|-----------|--------|
| *(none — default)* | **`open`**: readable; edits + execution **confirm** (dialog, with session "always allow"). |
| `// %mcp` | Read-only source — readable, source edits **denied** (still runnable, with confirm). |
| `// %mcp rw` | Pre-approved — readable + edits/execution run **without** a confirm. |
| `// %private` | Hard opt-out — invisible to the agent (unless `%mcp describe`). |
| `// %mcp describe "..."` | Metadata for a `%private` cell (shown in `listCells`). |
| `// %mcp fs data/` | Allow `notebook.fs` read/write under `data/`. |
| `// %mcp fs:read data/` | Allow read-only `notebook.fs` under `data/`. |
| `// %mcp fs *` | Allow full `notebook.fs` access. |

Precedence: cell directive > manifest tool-level > manifest defaults > `open`.
The decision is `resolveAccess(code, manifest, cellIndex, cellName)` in
`mcp-access.js`. The line sits at **acting**, not reading (per numen's threat model
§5.1: reads are open because you connected; mutation + execution are human-gated
regardless of who proposed them).

### Restoring the old opt-in (strict) posture

A sensitive notebook can flip the baseline back to default-deny with a manifest:

```js
// %mcp manifest
({ defaults: "private" })   // or "strict" — cells hidden until annotated with // %mcp
```

`defaults` accepts `"open"` (the global default), `"read"`, `"rw"`, or
`"private"`/`"strict"` (opt-in mode).

### Manifest cell

A single cell can declare governance for the whole notebook:

```js
// %mcp manifest
({
  defaults: "open",                                   // baseline posture
  tools: {
    loadData:   { cell: "data loader", describe: "Load CSV drill data" },
    runKriging: { cell: 4, describe: "Execute kriging", access: "rw" },
  },
  fs: { prefix: "data/", readOnly: true },
})
```

- **`tools`** — named tool aliases bound to a cell (by `%cellName` or index); the
  agent sees `loadData` instead of `getCellOutput(index: 3)`.
- **Tool-level `access`** overrides the manifest default for that cell.
- The manifest cell itself is always `private`.

### Filesystem sandboxing

`fsList` / `fsRead` / `fsWrite` / `fsDelete` are gated by `// %mcp fs` directives
(or manifest `fs`). Without one, all fs tools error. Prefixes union across cells;
`fs:read` allows only list/read; path traversal (`../`) is rejected; writes/deletes
always confirm.

## Tools

Built-ins (answered by the numen bridge): `listClients`, `getConnectionInfo`.

| Tool | Gate | Description |
|------|------|-------------|
| `listCells` | — | Cells with index, type, access level, defines, errors |
| `getCellSource` / `getCellOutput` / `getCellScreenshot` | read | Read source / structured output / canvas PNG |
| `getDAG` / `getNotebookStatus` / `getNotebookContext` | read | Dependency graph / status / orientation |
| `updateCellSource` | edit (confirm) | Full replacement (`code`) or surgical `patches` (`[{old,new}]`); shows a diff |
| `setWidgetValue` | edit (confirm) | Set a slider/dropdown/checkbox/text-input value → reactive re-run |
| `addCell` | edit (confirm) | Add a cell |
| `runCell` / `runAll` | execute (confirm) | Execute a cell + dependents / the whole notebook |
| `pauseAutorun` / `resumeAutorun` | — | Batch edits |
| `getDocumentation` / `getAuditLog` | — | API docs / tool-call history (exportable as JSON) |
| `fsList` / `fsRead` / `fsWrite` / `fsDelete` | `%mcp fs` | Embedded filesystem (writes/deletes confirm) |

"edit/execute (confirm)" tools prompt a dialog with **Accept** / **Accept All**
(session-wide) / **Reject**. `// %mcp rw` cells skip the confirm (pre-approved).

## Connection

```js
window.__auditable_mcp.connect("port:token");   // programmatic
```
…or `notebook.html#mcp=port:token`, or the **mcp** panel (Ctrl+M). The statusbar
shows `mcp` (green, connected) / `mcp...` (amber, connecting). Notebook IDs derive
from the document title; override via the panel's **name** field.

## Governance patterns

**Default (collaboration):** nothing to do — cells are readable, edits/runs confirm.

**Methodology-only (data stays private):**
```js
// %private
// %mcp describe "Loads drillhole database (proprietary)"
const data = await load("data.csv");
```
The agent sees the method cells (and can edit them with confirmation) but never the raw data.

**Strict review:** `// %mcp manifest` with `defaults: "private"`, then `// %mcp` the
cells you want inspected (read-only).

**Trusted automation:** `// %mcp rw` on the cells an agent may edit/run without prompts.
