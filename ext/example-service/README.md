# @example/service — reference service contribution

The **services** counterpart to [`@example/quip`](../example-quip) (a surface
contribution). It shows the smallest complete shape of a Works **A-Bus service**
contributed by a package.

## The shape

```
ext/example-service/
  package.json   ← declares the service as DATA (gcu.services)
  service.js     ← the service entry: exports setupService(ctx)
```

That's it. **No `works.js`** — a service needs no boot-time code. The shell's
boot scan (`works/js/extension-services.js`) reads every installed package's
`package.json` → `gcu.services[]` and declares each on the broker **cold**. The
service's code (`setupService`) runs only on the **first call** to it (cold→hot),
so a package that's installed-but-never-used costs nothing.

## The manifest (`package.json` → `gcu.services`)

```json
{
  "gcu": {
    "services": [
      {
        "name":       "example-echo",   // the A-Bus name the service claims
        "entry":      "service.js",      // the entry module (relative to /lib/<pkg>/)
        "export":     "setupService",    // the named export the activator calls
        "requires":   ["capsule"],       // libs to inject (resolved baked or from /lib)
        "permission": "open"             // recorded for the install-time gate
      }
    ]
  }
}
```

## The entry (`service.js`)

`export async function setupService(ctx)`. The module imports **nothing** — every
dependency arrives through `ctx` (dependency injection), so it runs identically
whether it's shell-bundled or blob-imported from `/lib`, with no post-boot import
map. `ctx.deps` holds the resolved `requires` libs as module namespaces. The
activator resolves each via the baked payloads (works/works-all) **or** an
installed copy in `/lib` (a provisioned lean shell) — so the same package works
baked or provisioned.

`setupService` connects a broker peer, exposes the service interface, and
`claim`s the declared name. See the inline comments in `service.js`.

## Why data, not code

Surfaces/contextMenu contribute via a package's `works.js` (code the shell runs
at boot). Services are declared as **data** and activated lazily — trusting a
package to *name* a service is a weaker grant than trusting it to *run code* at
boot. That split is the safety point of the contribution registry.

See `@gcu/workbench` (`ext/workbench/`) for a real package that contributes
**both** a surface (works.js) and a service (gcu.services).
