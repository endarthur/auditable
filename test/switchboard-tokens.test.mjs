// Switchboard token parity — enforces ext/switchboard/switchboard.css as the
// single source of truth for the design tokens. Every in-repo copy
// (src/style.css = auditable, works/style.css = the shell, works/surfaces/
// _theme.css = surfaces) may define a SUBSET of the canonical tokens, but any
// token it does define must match switchboard.css's value — no deltas. (The
// old Works "brighter dark accents" exception was retired in v1.3.0 when the
// CVD-tuned accents became bright enough for works + auditable to share one
// palette.)
//
// This is the safety net for the @gcu/switchboard extraction: the copies stay
// physically in place (no risky theming rewire), but they cannot silently
// drift. A future build-inline rewire (deleting the copies, sourcing from the
// package) is the next step; until then, this test holds the line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const norm = (v) => v.trim().replace(/\s+/g, ' ').toLowerCase();

// Pull --sw-*/--au-* declarations out of a CSS block body.
function declsOf(block) {
  const map = new Map();
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const name = '--' + m[1];
    if (name.startsWith('--sw-') || name.startsWith('--au-')) map.set(name, norm(m[2]));
  }
  return map;
}

// The token :root block + the [data-theme="dark"] token block of a file.
// (Token blocks are flat — no nested braces — so [^}]* is safe.)
function tokens(css) {
  const root = (css.match(/:root\s*\{([^}]*)\}/) || [, ''])[1];
  const dark = (css.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/) || [, ''])[1];
  return { light: declsOf(root), dark: declsOf(dark) };
}

const ACCENTS = new Set(['--sw-orange', '--sw-blue', '--sw-green', '--sw-yellow', '--sw-red', '--sw-violet']);

const canonical = tokens(read('ext/switchboard/switchboard.css'));

const CONSUMERS = [
  { file: 'src/style.css',              works: false },
  { file: 'works/style.css',            works: true  },
  { file: 'works/surfaces/_theme.css',  works: true  },
];

test('switchboard.css defines a full canonical token set', () => {
  // Sanity: the canonical file actually parsed (guards a regex/format break).
  assert.ok(canonical.light.size >= 30, `light tokens: ${canonical.light.size}`);
  assert.ok(canonical.dark.size >= 16, `dark tokens: ${canonical.dark.size}`);
  for (const a of ACCENTS) assert.ok(canonical.dark.has(a), `canonical dark missing ${a}`);
});

for (const { file } of CONSUMERS) {
  test(`${file} tokens match switchboard.css exactly`, () => {
    const t = tokens(read(file));
    // Sanity: we actually found token blocks (a selector-shape change would
    // otherwise let this pass vacuously).
    assert.ok(t.light.size >= 10, `${file}: parsed only ${t.light.size} light tokens`);
    assert.ok(t.dark.size >= 6, `${file}: parsed only ${t.dark.size} dark tokens`);

    for (const scope of ['light', 'dark']) {
      for (const [token, val] of t[scope]) {
        if (!canonical[scope].has(token)) continue;          // app-specific addition — fine
        // No deltas any more — every shared token must match canon exactly.
        // (The old Works "brighter dark accents" exception retired in v1.3.0,
        // when the CVD-tuned accents became bright enough to share.)
        assert.equal(val, canonical[scope].get(token),
          `${file} [${scope}] ${token} = ${val} ≠ canonical ${canonical[scope].get(token)} `
          + `— reconcile with ext/switchboard/switchboard.css`);
      }
    }
  });
}

test('auditable (src/style.css) uses the CANONICAL dark accents (no delta)', () => {
  // The decisive finding: auditable's dark accents ARE the Switchboard canon.
  // This pins it — if auditable's accents ever drift, switchboard.css is wrong
  // or auditable diverged; either way, surface it.
  const t = tokens(read('src/style.css'));
  for (const a of ACCENTS) {
    assert.equal(t.dark.get(a), canonical.dark.get(a),
      `src/style.css dark ${a} must equal canonical ${canonical.dark.get(a)}`);
  }
});
