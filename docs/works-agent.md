# Agent Access (numen for Works)

Connect an AI agent (like Claude Code) to the **Auditable Works** desktop. The
agent drives the workspace the way you do — browsing files, opening surfaces,
running and editing notebooks — but only through **capabilities you grant**,
every action **gated, consented, and audited**.

This is the *shell-level* counterpart to the notebook [MCP Bridge](mcp.md). The
notebook bridge connects an agent to **one open notebook**; this connects an
agent to the **whole desktop** — the VFS, the surfaces, and every notebook in
the workspace.

---

## How it differs from the notebook bridge

| | [Notebook MCP Bridge](mcp.md) | Agent access (this page) |
|---|---|---|
| Connects to | one running notebook | the Works shell (whole workspace) |
| Tool surface | cells of that notebook | files, surfaces, *and* notebooks |
| Access model | per-cell `%mcp` directives | A-Bus **capability gates** + folder consent |
| Identity | one connection | **many** agents, each scoped (multichannel) |

The two compose: when the agent reads or edits a notebook through Works, the
notebook's own `%mcp` access levels are **still enforced** — read-only and
private cells stay protected regardless of any workspace grant.

---

## The model in one paragraph

The agent runs no code in any Works realm — it's a remote process talking over
the [numen](https://github.com/gentropic/numen) bridge. So there is nothing to
sandbox; the threat is its *requests*. Each agent is represented as a **gated
A-Bus peer**: every tool call becomes an A-Bus call **on that agent's peer**,
which the shell's broker authorizes against the agent's grants. Reads and
navigation are open; **mutations are default-deny** until you consent to a
folder scope. The broker stamps each peer's identity unforgeably, so a grant to
one agent never leaks to another.

---

## Quick start

You need the numen bridge running (it ships with the `gentropic/numen` repo).
There are two transports — pick whichever fits how you launched Works.

### WebSocket / HTTP (served Works)

Best when Works is served over `http(s)` (a dev server or PWA).

1. Start the bridge: `node ../numen/numen-bridge.js --app works --port 7803`
2. In Works, open **Tools → Settings… → Agent access (MCP)**.
3. Paste the bridge's `port:token` into **Bridge key** and click **Connect**.

### Shared folder (file:// and PWA-friendly)

The folder transport needs no localhost, no port, and no Private-Network-Access
prompt — ideal for a `file://` Works or a locked-down PWA. Because the folder
picker needs a user gesture, it's a **shell menu action**, not a panel button:

1. Start the bridge pointed at a folder (the fs transport).
2. In Works, **Tools → "Connect agent folder…"**.
3. Pick the folder the bridge watches, then paste the bridge **token**.

!!! note
    "Connect agent folder…" only appears when the numen shim is present and your
    browser supports the folder picker (`showDirectoryPicker`).

---

## What the agent can do — the tool catalog

22 tools across four tiers. **Observe** and **navigate/run** are open;
**mutations** are gated and need a consented folder grant.

### Observe (read-only, open)

| Tool | Effect |
|---|---|
| `worksTree` | List the workspace under a path (default `/projects`). |
| `worksReadFile` | Read a text file. |
| `worksReadBinary` | Read a binary file (returned as base64). |
| `worksStat` | Whether a path exists, and its kind/size. |
| `worksListSurfaces` | What surfaces (tabs) are open; the focused one flagged. |
| `worksNotebookCells` | List a notebook's cells (index, type, access, name, defines). |
| `worksNotebookSource` | Read a cell's source. |
| `worksNotebookOutput` | Read a cell's last output/result. |

### Navigate & run (open)

| Tool | Effect |
|---|---|
| `worksOpenPath` | Open a file/project in its surface. |
| `worksSpawnSurface` | Open a surface by kind (terminal, inspector, …). |
| `worksNewNotebook` | Create a new notebook project under `/projects`. |
| `worksCloseSurface` | Close the surface showing a path. |
| `worksRunNotebook` | Run all cells of a notebook (open it first if given a path). |
| `worksNotebookRunCell` | Run one cell and its downstream dependents. |

!!! note "Why running is open"
    Running a notebook executes the cells it **already contains** — the agent
    isn't injecting code, just pressing Run. Cell *content* changes (below) are
    gated.

### Mutate files (gated + consent)

| Tool | Effect |
|---|---|
| `worksWriteFile` | Write a text file. |
| `worksWriteBinary` | Write a binary file (base64 input). |
| `worksMakeDir` | Create a directory (and parents). |
| `worksMove` | Move/rename a file or folder. |
| `worksDelete` | Delete a file or folder (recursive). |

### Mutate notebooks (gated + consent)

| Tool | Effect |
|---|---|
| `worksNotebookEditCell` | Replace a cell's source (full `code` or `patches`). |
| `worksNotebookAddCell` | Add a cell (`code`/`md`/`css`/`html`). |
| `worksNotebookDeleteCell` | Delete a cell. |

Together these close the agent's **read → run → observe → fix** loop: read the
cells, run them, read the outputs, edit, repeat.

---

## Consent & grants

The first time an agent tries to **write**, the shell asks you to approve a
**folder scope**:

> The connected agent wants to write `/projects/report/draft.txt`. Grant it
> access to **create, modify, move, and delete** files in a folder?
> ◉ This folder — `/projects/report/`  ○ All projects — `/projects/`

- **Allow** issues a path-scoped grant and the write proceeds. Subsequent writes
  *within that folder* don't re-prompt — the grant covers them.
- **Deny** propagates the denial back to the agent.

A grant is **one consent, not two**: the same folder grant authorizes both file
writes *and* notebook cell edits under that path. Reads are always open.

Grants are **session-only** — they live in the shell's broker and clear on
reload. Manage them in **Settings → Agent access**:

- The **grants list** shows each agent identity, its writable scope, and a
  **Revoke** button.
- A grant to one agent never authorizes another (see *Per-agent identities*).

!!! warning "Notebook access still applies"
    A folder grant lets the agent edit cells, but the notebook's own `%mcp`
    directives win: a `// %mcp` (read-only) or `// %private` cell refuses edits
    even inside a granted folder.

---

## Audit log

Every agent action — allowed or denied — is recorded. **Settings → Agent access
→ Recent agent activity** shows a live list (`time · tool · summary ·
ok/denied`), newest first. The log is in-memory only: a session ledger, cleared
on reload. Grants, revokes, and channel connects/disconnects are logged too, by
identity.

---

## Per-agent identities (multichannel)

Over the folder transport, **multiple agents can connect at once** — one folder
per agent, where the *folder is the identity*. Each identity gets its **own**
gated peer and its **own** grant set:

- A grant to `alice` does **not** authorize `bob`.
- Each agent's activity is logged under its identity.
- The Settings grants list shows and revokes per-agent.

The WebSocket/HTTP transport is single-channel — one agent, the `default`
identity. The folder transport is where many-agents-at-once lives.

---

## What the agent can't do

- **Read secrets from another realm.** Surfaces are sandboxed, opaque-origin
  iframes; the agent (and surfaces) reach the workspace only through the gated
  `works` A-Bus service, never the shell's internals.
- **Mutate outside a granted folder.** Writes, moves, deletes, and cell edits
  are confined to consented scopes — a move's *destination* is scope-checked too.
- **Install packages, provision profiles, or export the workspace.** These stay
  human-only — you click them.

---

## See also

- [MCP Bridge](mcp.md) — the standalone-notebook agent integration.
- [Auditable Works](works.md) — the desktop this rides on.
- [@gcu/numen](https://github.com/gentropic/numen) — the bridge + shim (incl.
  the multichannel transport docs).
- [@gcu/abus](https://github.com/gentropic/auditable/blob/main/ext/abus/SPEC.md)
  — the capability-bearing message bus underneath.
