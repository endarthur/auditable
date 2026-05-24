#!/usr/bin/env node
// Build the Sherlock + Aesop corpus modules from the raw Project
// Gutenberg dumps in this folder. Run once (or whenever you want to
// refresh the corpora). Output: examples/data/{sherlock,aesop}.js.
//
// The raw .txt files in this folder are not committed; the build/
// output .js modules in examples/data/ ARE committed so the example
// notebook can be rebuilt offline.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, '..', '..', 'data');
fs.mkdirSync(OUT, { recursive: true });

// ───────────────────────── Sherlock Holmes ─────────────────────────
// Project Gutenberg #1661 — The Adventures of Sherlock Holmes.
function parseSherlock() {
  const raw = fs.readFileSync(path.join(HERE, 'sherlock.raw.txt'), 'utf8')
    .replace(/\r/g, '');
  const startMarker = '*** START OF';
  const endMarker = '*** END OF';
  const start = raw.indexOf('\n', raw.indexOf(startMarker)) + 1;
  const end = raw.indexOf(endMarker);
  const body = raw.slice(start, end);

  // Story headings are like "I. A SCANDAL IN BOHEMIA\n\n\n" — an
  // uppercase title at the top of its own block. The TOC also lists
  // them but in title case, so the all-caps form uniquely flags story
  // openings.
  const titles = [
    'A Scandal in Bohemia',
    'The Red-Headed League',
    'A Case of Identity',
    'The Boscombe Valley Mystery',
    'The Five Orange Pips',
    'The Man with the Twisted Lip',
    'The Adventure of the Blue Carbuncle',
    'The Adventure of the Speckled Band',
    "The Adventure of the Engineer's Thumb",
    'The Adventure of the Noble Bachelor',
    'The Adventure of the Beryl Coronet',
    'The Adventure of the Copper Beeches',
  ];

  // Find each story's start by locating its all-caps heading in the body.
  const positions = titles.map((t) => {
    // Curly quotes: the Gutenberg text uses ’ not '.
    const upper = t.toUpperCase().replace(/'/g, '’');
    const idx = body.indexOf(upper);
    if (idx < 0) {
      throw new Error('Could not find heading for: ' + t);
    }
    return idx;
  });

  // Sanity: positions should be monotonically increasing.
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) {
      throw new Error('Out-of-order heading at ' + titles[i]);
    }
  }

  const stories = titles.map((title, i) => {
    const from = positions[i];
    const to = i < positions.length - 1 ? positions[i + 1] : body.length;
    const chunk = body.slice(from, to);
    // Strip the title line + subsequent blank lines from the body.
    const upper = title.toUpperCase().replace(/'/g, '’');
    const afterTitle = chunk.indexOf('\n', chunk.indexOf(upper) + upper.length) + 1;
    let storyBody = chunk.slice(afterTitle).trim();
    // The story body itself often has a leading roman-numeral section
    // marker ("I.", "II.") above the prose — strip those.
    storyBody = storyBody.replace(/^[IVX]+\.\s*\n+/gm, '');
    // Collapse triple-blank lines to double for tidiness.
    storyBody = storyBody.replace(/\n{3,}/g, '\n\n');
    return {
      id: 'holmes-' + String(i + 1).padStart(2, '0'),
      story_num: i + 1,
      title,
      body: storyBody,
    };
  });

  return stories;
}

// ──────────────────────────── Aesop ────────────────────────────────
// Project Gutenberg #11339 — Aesop's Fables (V. S. Vernon Jones tr.).
// Body starts at the THIRD occurrence of "THE FOX AND THE GRAPES":
// first is the TOC, second is the list of illustrations, third is the
// actual prose. Each fable is an ALL-CAPS title followed by a blank
// line and the body, ending before the next ALL-CAPS title.
function parseAesop() {
  const raw = fs.readFileSync(path.join(HERE, 'aesop.raw.txt'), 'utf8')
    .replace(/\r/g, '');
  const startMarker = '*** START OF';
  const endMarker = '*** END OF';
  const start = raw.indexOf('\n', raw.indexOf(startMarker)) + 1;
  const end = raw.indexOf(endMarker);
  const body = raw.slice(start, end);

  // Find the THIRD occurrence of "THE FOX AND THE GRAPES" — that's
  // where the actual fables start (the first two are TOC + illust list).
  const marker = 'THE FOX AND THE GRAPES';
  let n = 0;
  let storyStart = -1;
  let from = 0;
  while (true) {
    const i = body.indexOf(marker, from);
    if (i < 0) break;
    n++;
    if (n === 3) { storyStart = i; break; }
    from = i + 1;
  }
  if (storyStart < 0) throw new Error('Could not locate Aesop body start');

  const proseText = body.slice(storyStart);

  // Match ALL-CAPS title lines. Aesop titles use ASCII letters, spaces,
  // dashes, commas, apostrophes (curly), "AND". A title is a whole line
  // of uppercase, length < 80, surrounded by blank lines (above and
  // below).
  const lines = proseText.split('\n');
  const titleIdx = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.length > 80) continue;
    // Has any lowercase? skip.
    if (/[a-z]/.test(line)) continue;
    // Has at least one letter?
    if (!/[A-Z]/.test(line)) continue;
    // Surrounding blank lines (above and below).
    if (i > 0 && lines[i - 1].trim() !== '') continue;
    if (i + 1 < lines.length && lines[i + 1].trim() !== '') continue;
    titleIdx.push(i);
  }

  const fables = [];
  for (let k = 0; k < titleIdx.length; k++) {
    const ti = titleIdx[k];
    const title = lines[ti].trim()
      // Title-case it for display (preserve "and" lowercase).
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bAnd\b/g, 'and')
      .replace(/\bThe\b/g, (m, off) => off === 0 ? 'The' : 'the')
      .replace(/\bA\b/g, (m, off) => off === 0 ? 'A' : 'a')
      .replace(/\bOf\b/g, 'of')
      .replace(/\bIn\b/g, 'in')
      .replace(/\bWith\b/g, 'with');
    const bodyStart = ti + 1;
    const bodyEnd = k + 1 < titleIdx.length ? titleIdx[k + 1] : lines.length;
    let fableBody = lines.slice(bodyStart, bodyEnd).join('\n').trim();
    // Strip [Illustration: ...] caption lines that appear inline.
    fableBody = fableBody.replace(/^\[Illustration:[^\]]*\]\s*$/gm, '');
    fableBody = fableBody.replace(/\n{3,}/g, '\n\n').trim();
    // The Vernon Jones translation doesn't keep morals as a separate
    // italic paragraph — they're folded into the narration. Skip the
    // moral-extraction step.
    if (fableBody.length < 60) continue;   // skip stray noise + footers
    // Skip the trailing "ILLUSTRATIONS" appendix block.
    if (/^illustrations$/i.test(title)) continue;
    fables.push({
      id: 'aesop-' + String(fables.length + 1).padStart(3, '0'),
      title,
      body: fableBody,
    });
  }
  return fables;
}

function writeModule(filename, varName, data) {
  const out = `// Generated by examples/defs/data-corpora/build.js
// Source: Project Gutenberg (public domain).
// DO NOT EDIT BY HAND — re-run build.js to regenerate.
export const ${varName} = ${JSON.stringify(data, null, 0)};
export default ${varName};
`;
  fs.writeFileSync(path.join(OUT, filename), out);
  console.log('wrote', filename, '—', data.length, 'docs,', out.length, 'bytes');
}

const sherlock = parseSherlock();
const aesop = parseAesop();
writeModule('sherlock.js', 'sherlock', sherlock);
writeModule('aesop.js', 'aesop', aesop);
