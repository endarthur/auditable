// moncad — the command registry. The spine.
//
// Commands are DATA, not buttons. Every interactive surface — toolbar, menubar, command
// palette, command line, keybindings, (later) the MCP agent — is a VIEW over this one
// registry, routing to the same command through the same execute() path. Because there
// is one registry, a toolbar button IS its command: they cannot drift, and the button's
// tooltip can honestly teach the keystroke. This is what makes friendly and honest the
// same thing rather than opposites (SPEC §3).
//
// A Command:
//   { id, title, category?, keys?, icon?, description?,
//     when?(ctx) -> bool,            // enabled in this context? (default: always)
//     run(ctx, args?) -> void|Promise }
//
// `ctx` is the live editor context (document, viewport, input loop, …) handed in at
// execute time — the registry itself is context-free dispatch, so it stays pure and
// testable.

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

// Canonical keystroke form: lowercase, modifiers in a fixed order, so 'Shift+Ctrl+K' and
// 'ctrl+shift+k' resolve to the same binding.
export function normalizeKey(k) {
  const parts = String(k).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods = parts.filter((p) => MOD_ORDER.includes(p)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const keys = parts.filter((p) => !MOD_ORDER.includes(p));
  return [...mods, ...keys].join('+');
}

// Subsequence fuzzy score for the palette: substring beats scatter, earlier beats later.
// Empty query matches everything weakly (the palette opens showing all commands).
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0.0001;
  const i = text.indexOf(q);
  if (i >= 0) return 1000 - i;                       // substring — prefer earlier
  let ti = 0, hits = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, ti);
    if (idx < 0) return 0;                            // not a subsequence → no match
    hits++; ti = idx + 1;
  }
  return hits;                                        // weak subsequence match
}

export class CommandRegistry {
  constructor() {
    this._cmds = new Map();      // id → command
    this._keys = new Map();      // normalized keystroke → id
  }

  register(cmd) {
    if (!cmd || !cmd.id) throw new Error('command needs an id');
    if (typeof cmd.run !== 'function') throw new Error(`command "${cmd.id}" needs a run()`);
    this._cmds.set(cmd.id, cmd);
    if (cmd.keys) for (const k of [].concat(cmd.keys)) this._keys.set(normalizeKey(k), cmd.id);
    return this;
  }

  registerAll(cmds) { for (const c of cmds) this.register(c); return this; }

  get(id) { return this._cmds.get(id) || null; }
  has(id) { return this._cmds.has(id); }

  // Enabled in this context? when() defaults to true. Surfaces use this to grey out.
  isEnabled(id, ctx) { const c = this._cmds.get(id); return !!c && (c.when ? !!c.when(ctx) : true); }

  // List commands — drives the menubar / toolbar. Optionally one category, optionally only
  // those enabled in `ctx`.
  list({ ctx, category, enabledOnly = false } = {}) {
    let cmds = [...this._cmds.values()];
    if (category) cmds = cmds.filter((c) => c.category === category);
    if (enabledOnly && ctx) cmds = cmds.filter((c) => (c.when ? !!c.when(ctx) : true));
    return cmds;
  }

  // Distinct categories in registration order — drives menu grouping.
  categories() { return [...new Set([...this._cmds.values()].map((c) => c.category).filter(Boolean))]; }

  // Fuzzy-ranked commands for the palette (skips those disabled in ctx).
  search(query, ctx) {
    const scored = [];
    for (const c of this._cmds.values()) {
      if (ctx && c.when && !c.when(ctx)) continue;
      const s = fuzzyScore(query, (c.title || c.id).toLowerCase());
      if (s > 0) scored.push({ c, s });
    }
    scored.sort((a, b) => b.s - a.s || (a.c.title || a.c.id).localeCompare(b.c.title || b.c.id));
    return scored.map((x) => x.c);
  }

  // Keybinding surface: keystroke → command id, and the inverse for tooltips. Same registry,
  // so the tooltip's key and the key that fires it are guaranteed to agree (no drift).
  forKey(key) { return this._keys.get(normalizeKey(key)) || null; }
  keyFor(id) { for (const [k, cid] of this._keys) if (cid === id) return k; return null; }

  // THE single execution path every surface routes through. Honours when(); returns a
  // small result envelope rather than throwing on a disabled command.
  async execute(id, ctx, args) {
    const c = this._cmds.get(id);
    if (!c) throw new Error(`unknown command: ${id}`);
    if (c.when && !c.when(ctx)) return { ok: false, reason: 'disabled' };
    return { ok: true, result: await c.run(ctx, args) };
  }
}
