// @gcu/dispatch — corpus generation: banks × kinds over the session
// vocabulary, answer-first (arguments picked, utterance rendered), seeded,
// deduplicated, with the eval-contamination guard as a first-class option.
import { mulberry32, normText, cap } from './text.js';
import { mkR, KINDS } from './kinds.js';

export function generate(ctx, tools, { seed = 42, targets = {}, refusalTarget = 70, extraRefusals = [], excludeTexts = null } = {}) {
  const R = mkR(mulberry32(seed));
  const seen = new Set();
  const excluded = new Set();
  const out = [];
  const guard = (q) => {
    const key = normText(q);
    if (seen.has(key)) return false;
    if (excludeTexts && excludeTexts.has(key)) { excluded.add(key); return false; }
    seen.add(key);
    return true;
  };
  for (const tool of tools) {
    const kind = KINDS[tool.kind];
    if (!kind) throw new Error(`unknown kind "${tool.kind}" (tool ${tool.name})`);
    const target = targets[tool.name] ?? tool.target ?? kind.defaultTarget;
    let made = 0, tries = 0;
    while (made < target && tries++ < target * 40) {
      const { q, args } = kind.render(tool, ctx, R);
      if (!guard(q)) continue;
      out.push({ q, tool: tool.name, args });
      made++;
    }
  }
  const refusalBank = [...ctx.vocab.L.refusals, ...extraRefusals];
  let made = 0, tries = 0;
  while (made < refusalTarget && tries++ < refusalTarget * 40) {
    const base = R.pick(refusalBank);
    const q = R.maybe(0.4) ? base : R.pick([`${base} please`, `can you ${base}`, `${base}?`, `${cap(base)}.`, `${base} for me`]);
    if (!guard(q)) continue;
    out.push({ q, tool: null, args: null });
    made++;
  }
  return { corpus: out, excluded: [...excluded] };
}
