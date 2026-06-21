# numen for Works — implementation guide

How the agent integration is *built*. The user-facing doc (`docs/works-agent.md`)
says what an agent can do; this says how the pieces fit, so adding a tool or a
gate takes minutes, not an afternoon of rediscovery. Sibling to `SURFACES.md`.

The capability model this rides on is the design of record in
`spec_inbox/works-capability-security-spec.md` (§4 is the gate/grant/authorize
slice). This doc is the code-level companion.

---

## The realms (where each line of code runs)

```
external agent (Claude Code)         ── a remote process; runs NO code in our realms
   │  MCP JSON-RPC over stdio
numen bridge (../numen/numen-bridge.js)   ── relays MCP ⇄ page; app-agnostic; UNCHANGED by us
   │  WebSocket / HTTP / fs-folder transport
shim  (works/js/shim.js, vendored)   ── polyfills navigator.modelContext; sets window.gcuMCP
   │  tool.execute(input, client)         client.identity = the calling channel (folder = identity)
shell realm (works/js/*)             ── TRUSTED first-party code; owns the A-Bus broker + the VFS
   │  agentBus.call(...)  ON A GATED PEER
broker (ext/abus) authorizes         ── default-deny for gated members unless a grant matches
   │
works service (works/js/works-service.js)  ── VFS / Shell / Notebook / Mcp / Inspect interfaces
```

**The one discipline:** the adapter acts *only* through the agent's A-Bus peer,
**never** `WKS.*` directly. That's what makes the broker see — and gate — every
agent action. A tool that reaches into `WKS` bypasses the capability model. Don't.

---

## Files

| File | Role |
|---|---|
| `works/js/shim.js` | Vendored numen shim (page side). `navigator.modelContext` + `window.gcuMCP`. **Generated — do not hand-edit** (see *Re-vendoring*). |
| `works/js/mcp-adapter.js` | The heart. Tool definitions, the gated-peer wiring, consent, grants, audit, the per-identity dispatcher. |
| `works/js/bus.js` | `setupBus()` — creates the broker and installs the **gates**. |
| `works/js/works-service.js` | The `works` A-Bus service: `VFS` / `Shell` / `Notebook` / `Mcp` / `Inspect` methods the tools call. |
| `works/js/surfaces.js` | `callNotebookAt` / `listSurfaces` / `runNotebookAt` / `closeSurfaceAt` — shell-side surface ops the Shell/Notebook interfaces delegate to. |
| `works/js/init.js` | Calls `setupWorksMcp()` at boot; exposes the `WKS.*` handles. |
| `works/surfaces/settings.html` | The "Agent access" panel — connect, grants list, audit log. A sandboxed surface, so it drives everything over `works.Mcp`. |
| `src/js/surface.js` | The notebook's `Notebook` A-Bus interface (runs **in the notebook frame**). |
| `src/js/mcp-adapter.js` | The notebook's own MCP logic + the exported `worksBridge*` functions the Works bridge calls. |
| `ext/abus/src/broker.js` | `gate` / `grant` / `revoke` / `authorize` — the capability primitive. |

---

## Anatomy of a tool call

`worksWriteFile({path, content})`, no grant yet:

1. The bridge delivers `tool_invoke` to the shim; the shim calls the registered
   **dispatcher** tool's `execute(input, client)` with `client.identity`.
2. The dispatcher (`setupWorksMcp`) resolves `client.identity` → that agent's
   tool set via `agentToolsFor(identity)` and calls the real tool's `execute`.
3. The tool calls `gated('VFS', 'Write', [path, content], path)`, which does
   `agentBus.call({ to:'works', interface:'VFS', member:'Write' }, …)` on the
   **agent's gated peer** (clientId `agent:<identity>`).
4. The broker's `authorize()` sees `works.VFS.Write` is gated for `agent:`
   principals, finds no matching grant → throws `Error.AccessDenied`.
5. `gated()` catches it (via `isAccessDenied`), calls `requestWriteConsent` →
   the `@gcu/dialog` prompt. On **Allow**, it issues `grantAgent(identity,
   {pathPrefix})` and retries the call — now authorized.
6. `withAudit` (wrapping every tool) logs the outcome and fires `AuditChanged`.

A *read* tool (`worksTree`) skips 4–5: its interface/member isn't gated, so
`authorize()` returns true and the call passes.

---

## The capability primitive (`ext/abus/src/broker.js`)

Host-only API on the broker object — **never on the wire**, so peers can't read,
forge, enumerate, or self-grant:

- `gate(name, policy)` — mark a well-known service's calls default-deny. Policy
  is `{ interfaces?, members?, principals? }`, each optional (omitted = matches
  all). **Additive** — multiple `gate()` calls on one name compose (OR).
  `principals` matches a caller's clientId by **prefix** (`'agent:'`).
- `grant(grantee, { to, interface?, member?, scope? }) → id` — authorize a peer.
  `grantee` is a unique `:N` (session) or a clientId (survives reconnect);
  `interface`/`member` default `'*'`; `scope.pathPrefix` is matched against the
  call's **first string arg** (`scopeOk`).
- `revoke(id)` / `revokeAll(grantee)` — session grants auto-purge on disconnect.
- `authorize(fromUnique, msg, targetUnique)` — `gatedNameFor` reverse-resolves
  the target's well-known name (so a direct `:N` call can't dodge the gate),
  then a gated call passes only if some grant matches.
- `inspect()` reports `grants` + `gatePolicies` (the Settings UI reads these).

The gates live in **`works/js/bus.js`**:

```js
WKS.broker.gate('works', { interfaces: ['Inspect'] });                    // topology — granted to the inspector at spawn
WKS.broker.gate('works', { interfaces: ['VFS'],
  members: ['Write','MkDir','Move','Delete'], principals: ['agent:'] });   // file writes — agents only
WKS.broker.gate('works', { interfaces: ['Notebook'],
  members: ['SetCell','AddCell','DeleteCell'], principals: ['agent:'] });  // cell edits — agents only
```

The `principals: ['agent:']` filter is why surfaces — which share `works.VFS`
but aren't `agent:` principals — pass freely. No big-bang gate of the hot path.

---

## Recipes

### Add a read-only / navigation tool

Add an entry to the `worksTools()` array in `mcp-adapter.js`. Route through the
right interface helper (`vfs` / `shell` / `nb`) — never `WKS`:

```js
{
  name: 'worksWhatever',
  description: '…',                       // the agent reads this — be precise
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  annotations: { readOnlyHint: true, title: 'Whatever' },
  execute: async (input) => shell('SomeMethod', [input.path]),
},
```

Then add `SomeMethod` to the matching interface in `works-service.js`. `withAudit`
and the per-identity dispatcher are applied automatically (the array is
`.map(withAudit)`-ed and registered by `setupWorksMcp`). Add a `works-smoke`
check.

### Add a *gated* (mutating) tool

Route through `gated(interface, member, args, scopePath)` instead. It turns a
broker `AccessDenied` into a consent prompt + retry:

```js
execute: async (input) => gated('VFS', 'Trash', [input.path], input.path),
```

…and gate the member in `bus.js`:

```js
WKS.broker.gate('works', { interfaces: ['VFS'], members: ['Trash'], principals: ['agent:'] });
```

`scopePath` is the path the consent dialog scopes to (usually the first path
arg). For a two-path op (like Move) where the broker only checks the first arg,
also call `ensureWriteScope(identity, secondPath)` first — it consents/denies
the *destination* client-side, since `scopeOk` can't see it.

### Add a new gate

One `gate()` call in `bus.js`. Keep it narrow: name the `interfaces`, the
`members`, and `principals: ['agent:']` so you don't gate surfaces. Because
gates are additive, a new gate never disturbs existing ones.

---

## Consent, grants, audit (all in `mcp-adapter.js`)

- **`requestWriteConsent(identity, path)`** — the `@gcu/dialog` scope prompt.
  Returns `false` (deny) or issues `grantAgent` (allow). Tests/automation
  override the dialog via `window.__agentConsent__` — a function returning a
  pathPrefix / `true` / falsy (same shape as `__NO_AUTO_SETUP__`).
- **`grantAgent(identity, {pathPrefix})`** — `broker.grant('agent:'+identity,
  { to:'works', interface:'*', member:'*', scope })`. `interface:'*'` is
  deliberate: **one** folder grant covers VFS writes *and* Notebook edits in
  scope (Inspect has no path arg, so its `scopeOk` fails → still denied). Fires
  `GrantsChanged`.
- **`revokeAgent` / `listAgentGrants`** — back the Settings grants list.
- **`withAudit(identity, tool)`** — wraps every tool; pushes `{ts, tool,
  identity, summary, ok, error}` to a bounded in-memory ledger and fires
  `AuditChanged`. `getAuditLog()` reads it. In-memory only — a session ledger.

The Settings panel reaches none of this directly (it's a sandboxed surface) — it
drives `works.Mcp` (`GrantAgent` / `RevokeAgent` / `ListAgentGrants` /
`GetAuditLog`) and subscribes to the `GrantsChanged` / `AuditChanged` / `StateChanged`
signals.

---

## Per-agent identities (multichannel)

The numen shim carries each calling channel's identity (folder = identity) into
`tool.execute(input, client)` as `client.identity`. Wiring:

- **`agentToolsFor(identity)`** — one cached gated peer + tool set per identity.
  An identity keeps one peer so its grants (keyed by clientId) persist.
- **`setupWorksMcp`** registers **dispatcher** tools: schemas come from the
  `'default'` set (identity-independent), and each dispatcher's `execute(input,
  client)` resolves `client.identity` → `agentToolsFor(identity)` → the real
  tool. So N agents over N folder channels each act under their own grants
  through one tool registry.
- `'default'` is the single-channel sugar (WebSocket/HTTP, or a single folder).
- `onChannelState` logs each channel's connect/disconnect by identity.

The consent/grants/audit code was already keyed on `identity`, so multichannel
needed no change there — the Settings list shows/revokes per-agent for free.

---

## The notebook bridge

The agent edits notebooks through Works without re-implementing cell logic or
losing the notebook's `%mcp` access control:

- `src/js/mcp-adapter.js` exports `worksBridge*` (ListCells / GetSource /
  GetOutput / GetDAG / SetSource / AddCell / RunCell / DeleteCell). These reuse
  the notebook's own `_mcpRequireRead/Write` (so read-only/private cells still
  throw) but pass `input._skipConfirm` to skip the per-cell confirm — the Works
  folder grant *is* the consent ("one consent, not two").
- `src/js/surface.js`'s `Notebook` A-Bus interface (running in the notebook
  frame) relays to those `worksBridge*` fns. Cells are addressed by 0-based index.
- `works/js/surfaces.js` `callNotebookAt(path, member, args)` resolves a notebook
  by **path** (reuse an open tab, else open + wait `Surface.Ready`) and calls its
  `Notebook` interface. `works-service.js`'s `Notebook` interface wraps it; the
  `worksNotebook*` tools call that.

So a cell edit is gated twice over, by design: the broker gate (Works folder
grant) *and* the notebook's `%mcp` level. A `// %mcp` cell refuses edits even in
a granted folder.

---

## Re-vendoring the shim

`works/js/shim.js` (and `src/js/shim.js` — they're identical) are **verbatim
copies** of `../numen/shim.js` (repo `Documents/GitHub/numen`, **not**
`~/numen`, which holds `weir/`). To update:

```sh
cp ../numen/shim.js src/js/shim.js
cp ../numen/shim.js works/js/shim.js
node build.js               # auditable.html embeds it
node build.js --target=works
```

No auditable-side edits — the shim is app-agnostic; everything app-specific is
wired through `window.gcuMCP` in `mcp-adapter.js`. After a shim bump, re-run the
smoke + the e2e (below). The bridge and `fs-channel.js` are owned by numen.

---

## Testing

- **`node test/works-smoke.mjs`** (Playwright, not in `npm test`) — the
  `agentMcp` + `multiAgent` page-evals drive the tools directly through a gated
  peer and assert the gating/consent/audit/multichannel behaviour. Add a check
  for every new tool.
- **`node test/numen-works.mjs`** — the real loop: spawns the **vendored**
  bridge (`test/vendor/numen-bridge.js`), loads `works.html` in Playwright, and
  drives the bridge's MCP stdio. Exercises the actual shim → dispatcher → peer →
  `works.*` path. Guarded; skips without the vendored bridge.

---

## Gotchas (each cost real time)

- **Match the error *code*, not the message.** The broker denies with `e.code
  === 'Error.AccessDenied'`; the message ("not authorized to call …") contains
  neither "denied" nor "authorized". `isAccessDenied` checks the code.
- **`rails.closeTab` is the public handle** (the returned API), not the internal
  `inst._closeTab`. `closeSurfaceAt` uses the public one.
- **A no-encoding VFS read decodes bytes to a *string*.** `worksReadBinary`
  passes `'bytes'`; binary crosses the MCP boundary as base64.
- **Move's destination is invisible to the broker.** `scopeOk` only inspects the
  first arg, so confine `to` with `ensureWriteScope` client-side.
- **`../numen` is `Documents/GitHub/numen`** from the auditable repo — the
  similarly-named `~/numen` is a different tree.

---

## See also

- `docs/works-agent.md` — the user-facing counterpart.
- `spec_inbox/works-capability-security-spec.md` — the capability model (§4).
- `ext/abus/SPEC.md` — the bus + broker.
- `SURFACES.md` — authoring a surface (the sibling guide).
