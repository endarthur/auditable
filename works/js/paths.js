// Canonical content-library layout — the single source of truth for where
// installed content packs live. Content the user consumes is VISIBLE under
// /home/library/; the bookkeeping (ledger, reading state) is dotted because it
// IS machinery, not content. Every shell consumer imports these so the layout
// lives in exactly one place (scattered '/home/.books' literals are what made
// the pre-1.0 relocation a chore — don't reintroduce them).
//
// Reader surfaces (works/surfaces/reader.html, dd60.html) are isolated iframes
// and can't import this module; they mirror STATE_DIR with a comment pointing
// back here. Keep them in sync by hand.

export const LIBRARY   = '/home/library';
export const BOOKS_DIR  = LIBRARY + '/books';        // book packs (reader content)
export const DATA_DIR   = LIBRARY + '/data';         // data packs (datasets)
export const LEDGER     = LIBRARY + '/.installed.json';   // kind-neutral install ledger
export const STATE_DIR  = LIBRARY + '/.state';       // per-book reading progress / annotations

export const bookDir   = (name) => BOOKS_DIR + '/' + name;
export const dataDir   = (name) => DATA_DIR + '/' + name;
export const stateFile = (slug) => STATE_DIR + '/' + slug + '.json';

// datKind → install root. Falls back to books for legacy/undeclared packs.
export const destFor = (datKind, name) => (datKind === 'data' ? dataDir(name) : bookDir(name));
