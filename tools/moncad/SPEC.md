# moncad — design of record

**A precision instrument you operate by command and read by panel, where every
coordinate can account for itself.**

moncad (after **Monge**, descriptive geometry) is a small standalone 2D CAD tool with
GCU sensibilities — "bigger than lamina, not humongous" — backed by the geometry cluster
(`@gcu/frame`, `@gcu/dxf`, `@gcu/groma`, `@gcu/regula`, later `@gcu/libella`). It is not
a from-scratch app; it is a GCU surface that composes the eco. Deploy is lamina-style:
in-repo source at `tools/moncad/`, built to a single self-contained `moncad.html`,
deployed to a sibling repo.

This spec is the contract. The `spec_inbox/CAD/` bundle is the broader cluster design;
this file is moncad-the-app's identity and architecture.

---

## 1. North stars (non-negotiable)

- **Single self-contained HTML.** No build step at runtime, no rented toolchain.
- **Networkless by default.** Fully functional under CSP `connect-src 'none'`; egress is
  only ever a user-invoked, feature-named action. Nothing phones home.
- **Browser-native, vanilla JS.** No frameworks.
- **Auditable.** Every coordinate carries provenance — its frame, its source, whether it
  was drawn or synthesized — and that provenance is *inspectable*, not buried.
- **A GCU surface, not an island.** Reuses `@gcu/rails` / `@gcu/menu` / `@gcu/dialog` /
  Switchboard / `@gcu/frame` / `@gcu/dxf`; the drawing is a VFS document; A-Bus-capable;
  feeds voxmesh/dee when 3D is wanted.

---

## 2. The instrument thesis

moncad is an **instrument**, not an application. You don't *use* a theodolite, you *read*
it. The product is the panel: the readouts, the snap glyphs, the constraint indicators —
honest, legible, functional over decorative. The Roman-surveying-instrument names
(groma / regula / libella) are deliberate; moncad is the rig that operates them.

"Instrument" means **legible**, not austere. A mixing desk or a cockpit is dense with
clearly-labelled, grabbable controls. A friendly, well-labelled toolbar is a *good
instrument control*. moncad is rich with honest affordances, not stripped bare.

---

## 3. Architecture — one command registry, many surfaces

The spine is a **command registry**: commands are *data*, not buttons. A command is

```
{ id, title, category, keys?, when?(ctx)->bool, run(ctx)->void|Promise, icon? }
```

registered once. Every interactive surface is a **view over that one registry**, routing
to the same command:

- **toolbar** — icon+label buttons for common draws/edits; tooltips show the command +
  keybinding, so the friendly surface quietly *teaches* the fast path (click today, type
  tomorrow);
- **menubar** — Draw / Modify / View / … where *everything* is findable;
- **command palette** — type-to-find any command (the power surface);
- **command line** — typed entry with **guided prompts** (`Specify next point or
  [Arc/Close/Undo]:`), friendly because it walks you through; accepts `10,5`, `@10,5`,
  `@10<45` coordinate input — the AutoLISP input family, the real soul of CAD;
- **context menu** — contextual commands on right-click;
- **keybindings** — resolved from the same registry;
- (later) the **MCP agent** — the same registry is the agent's command surface.

Because it's one registry, a button *is* its command — they cannot drift. This is what
makes friendly **and** honest the same thing rather than opposites.

**The synthesis (stated principle, so we don't drift to either failure mode):** *one
command registry, many friendly surfaces; legible-instrument, not austere-instrument.*
Refuse the soulless median app on one side (ribbon, wall-of-buttons-only, generic SaaS
chrome) and the hostile greybeard CLI on the other (command-line-only, no discoverability).
**Usable, discoverable, friendly is in the brief.**

---

## 4. Data model — canonical, framed, honest

- **Geometry is the `@gcu/dxf` primitive** (frame-native, bulge-canonical): the
  bulge-polyline (line + arc are the same primitive), circle, point. dxf already defines
  it; `@gcu/regula` builds offset/fillet/trim on it. The one curve type flows through.
- **World coordinates are canonical.** The board does math and rendering in a small
  **local frame** (`@gcu/frame`), but the **readout shows true world (UTM)** so the
  geologist sees real position; typed input accepts world and converts on entry. No
  silent shifts — ever.
- **Canonical vs derived, honestly.** You edit the small exact thing (bulge arcs, later
  constraints); the heavy thing (tessellation, later the field) is *derived* and
  regenerates. The UX never lets you save a faceted lie as truth.
- **Provenance is visible.** Click a point → see its frame, source, and whether it was
  drawn or synthesized (`PROV_SYNTH`). The audit question "what happened to this
  coordinate?" is always answerable. No commercial CAD does this; it is the GCU soul made
  literal.

---

## 5. The instrument panel (readouts)

The status surface is the instrument face: **world-UTM coordinate** readout (live),
length/angle, active snap (with glyph + label), ortho/polar state, active layer, and the
working **frame** (origin + units + CRS). Switchboard accents do semantic instrument work
— orange = active command, blue/teal = snap/info, amber = constraint engaged, green =
valid/go, red = fault, violet = selected.

---

## 6. Renderer — WebGL2 geometry + Canvas2D overlay

The board renders at mining scale (a pit wireframe, a dense survey, a 100k–1M-segment
DXF), so the renderer is **WebGL2 from the start** — Canvas2D's immediate-mode redraw
stutters on pan/zoom over a big drawing, and the renderer is too foundational to swap
later. The hard graphics problems are *sidestepped* by a **hybrid split**, not solved:

- **Geometry → WebGL2.** Batched/instanced line-quads (segments expanded to screen-width
  in the vertex shader), instanced point markers, arcs tessellated from bulge at a
  screen-space tolerance (reuses `@gcu/dxf`'s `arc.js`). **Pan/zoom is a single transform
  uniform — not a redraw.** That is the win.
- **Text / glyphs / UI / snap-markers / rubber-band → a Canvas2D overlay** stacked on top
  (two canvases, one transform). Text is the hard GPU problem (SDF atlases) — so it isn't
  on the GPU; labels are few and cheap in 2D. Bonus: dragging a rubber-band or moving the
  crosshair redraws only the light overlay while the heavy geometry sits still on the GPU
  — *better* interaction feel than pure Canvas2D.
- **Picking → a CPU spatial index** (uniform grid) → candidates → precise hit-test via
  groma/regula predicates. The same index **is** the snapping index (snapping is a
  spatial-query problem), so picking rides it for free — no GPU picking.

**WebGL2, not WebGPU:** WebGL2 runs everywhere offline (the networkless north star).
WebGPU is a *future backend* behind a thin renderer seam (it ties into the roadmapped
`@gcu/wgpu`). The renderer is **moncad-internal**, factored cleanly so it could extract to
an `@gcu/<renderer>` later if plot/plate/strata want it — owned and small, not a vendored
2D engine (single-file / auditable / no-frameworks).

---

## 7. Snapping & precision input

Snapping is make-or-break, and the failure mode is being too eager: always-on-all-types
turns it into a *fight* (grabs the midpoint when you wanted the endpoint; won't let you
place a free point). The principle: **snapping must never be a fight** — trivially toggled
off for a free point, constrained to exactly what you want, with feedback so you always
know what it's about to grab. Defaults sensible, full control available.

**Controls** — all are **registry commands**, so they live in the palette, are bindable,
*and* render as status-bar chips (one registry, the usual surfaces):

- **Master toggle** — `F3` (+ a clear status indicator) turns all snapping on/off. A free
  point is one keystroke away.
- **Per-type running snaps** — endpoint / midpoint / centre / node **on by default**
  (later: intersection / perpendicular / tangent / nearest / grid), each independently
  toggled and persisted. Shown as a row of toggle **chips in the status bar** — the snap
  state is readable + clickable right where you already look (the instrument panel).
- **One-shot override** — force a single snap for the *next* pick, overriding the running
  set. Typed at the **command line** mid-draw (`cen` → centre for the next point) — the
  AutoLISP osnap-override heritage, a natural fit for the input loop.
- **Cycling** — `Tab` cycles candidates under the aperture instead of letting the priority
  auto-pick decide.
- **Aperture** — the pickup radius (`SNAP_PX`), adjustable; too grabby vs too fussy is
  personal.
- **Grid snap vs object snap** are separate modes (snap-to-geometry ≠ snap-to-a-grid).

**Mechanics.** The `snap.js` spatial index is unchanged by all this — the app filters its
query results by the active type set, and the master toggle short-circuits the query. So
control is pure app/UX wiring over a stable index. Feedback is the overlay glyph (□ end ·
△ mid · ○ centre · ✕ node) + the snap-type name in the panel.

**Sequencing.** Snap *control* earns its keep exactly when you start **drawing** (placing a
point) — while merely hovering a viewer a wrong snap is harmless. So the toggles, master
switch, and override land **with the draw tools**, tuned against actual drafting.

---

## 8. Integration with the cluster

| Need | Package |
|---|---|
| coordinate framing, world↔local, provenance | `@gcu/frame` |
| open / save real DXF (layers, blocks, XDATA) | `@gcu/dxf` |
| exact predicates for edit ops (point-side, intersection) | `@gcu/groma` (planned) |
| offset / fillet / chamfer / trim | `@gcu/regula` (planned) |
| cota / structure contours / sections (geological mode) | `@gcu/libella` (planned, v2) |

Pulled in as the work demands them — `groma`/`regula` arrive with the edit long-tail,
designed against moncad as their real consumer.

---

## 9. Staged arc

- **v0 — the dumb-but-lovely board.** A LibreCAD-class drafter done right: real DXF
  round-trip, frame-correct world readout, real edit geometry (regula), snapping, the
  command spine, the Switchboard instrument skin. **No constraint solver** (a dumb board
  has none — this sidesteps the entire GPL ghost). Genuinely useful, shippable.
- **v1 — parametric.** A from-scratch constraint solver (written from the academic
  literature only — see §11) bolts on → parametric sketching.
- **v2 — geological (the real soul).** cota / elevation-as-data, the descriptive-geometry
  mode (`@gcu/libella`): three-point, structure contours, sections, outcrop prediction.
  This is what makes it unmistakably *ours* and is why the name is Monge. v0's bones know
  they're heading here.

---

## 10. Build order within moncad (the vertical slice)

Take the prototype's genuinely good mechanical parts (the pan/zoom feel, the snapping
math) but rebuild them on the **right bones** — the command registry first, the WebGL2
renderer next, not a button soup. Order:

1. command registry + the surfaces' wiring (the spine);
2. the WebGL2 geometry renderer + Canvas2D overlay (frame-aware pan/zoom) + the
   instrument-panel readouts (§6);
3. the CPU spatial index → snapping (endpoint/mid/center/intersection/perp/nearest/grid),
   which also serves picking (snap-control UX in §7);
4. the command/coordinate-input loop (guided prompts, `@10<45`);
5. draw commands (line/polyline/circle/arc) → DXF round-trip via `@gcu/dxf`;
6. the edit long-tail (move/copy/rotate/trim/offset/fillet) → pulls in `@gcu/regula`.

---

## 11. Hard rules & non-goals

- **Solver licensing hygiene (standing).** Any constraint solver is written **from the
  academic literature only** — never LLM-washed from SolveSpace/slvs, PlaneGCS, JSketcher
  (GPL/AGPL). Manifold (Apache-2.0) is fine to read/vendor/oracle. v0 has no solver at all.
- **Not a B-rep solid kernel.** Stay 2.5D; carry elevation as data; project out to
  voxmesh/dee for 3D viz rather than maintaining solid topology.
- **Anti-patterns we actively refuse:** a ribbon; buttons as the *only* path; generic SaaS
  chrome (gradients, big rounded cards, hamburger); rebuilding what rails/menu already do;
  decorative over functional; hiding precision/provenance behind a "clean simple" facade.
