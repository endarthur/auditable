// inferLicense(text) — fingerprint-based SPDX-id guess from raw license text.
//
// Use case: an installed module shipped a LICENSE file but no package.json
// `license` field (or pkg-managed only). Without this, the aggregator labels
// everything UNKNOWN — pessimistic but useless. The fingerprints below match
// the distinctive sentinel phrase from each license's CANONICAL text — same
// approach SPDX/license-detector use, scaled down to the ~10 ids that cover
// the ecosystem auditable actually pulls from.
//
// Returns: an SPDX id string on a confident match, or null. Designed to be
// boring: we'd rather decline than misclassify. The caller treats null as
// "still UNKNOWN, fall back to whatever was already there."
//
// Not a full SPDX detector. Things deliberately out of scope:
//   - Exception detection (WITH clauses).
//   - License-text variants that diverge from canonical wording.
//   - OR-disjunctions inside one file.
//
// Fingerprints picked for uniqueness within the working corpus, not for
// distinguishing every SPDX id from every other. ISC + MIT share a lot of
// phrasing; the ISC check runs first because its distinctive "fee" wording
// would otherwise be claimed as MIT.

// Each entry: { id, pattern } where pattern is a regex. The first match wins.
// Order matters — more-specific patterns ahead of more-generic ones.
const FINGERPRINTS = [
  // BSD-3 has the distinctive third clause about endorsement.
  { id: 'BSD-3-Clause', pattern: /neither the name of (the copyright holder|the (\w+\s){1,4}foundation)?[\s\S]{0,200}?be used to endorse or promote products/i },

  // BSD-2 = BSD-3 minus the endorsement clause. Match the redistributions clauses without endorsement.
  { id: 'BSD-2-Clause', pattern: /redistributions of source code must retain[\s\S]{0,400}?redistributions in binary form must reproduce/i },

  // ISC — short permissive, distinctive "fee" + no warranty.
  { id: 'ISC', pattern: /permission to use,? copy,? modify,?( and\/or)? distribute this software for any purpose with or without fee/i },

  // MIT — distinctive opening clause + "Software" reference.
  { id: 'MIT', pattern: /permission is hereby granted,? free of charge,? to any person obtaining a copy[\s\S]{0,200}?(of this software|the "?Software"?)/i },

  // Apache-2.0 — distinctive title line.
  { id: 'Apache-2.0', pattern: /apache license[\s\S]{0,30}?version 2\.0/i },

  // MPL-2.0 — distinctive title line.
  { id: 'MPL-2.0', pattern: /mozilla public license[\s\S]{0,30}?version 2\.0/i },

  // AGPL-3.0 — order before GPL because both contain "GNU GENERAL PUBLIC LICENSE".
  { id: 'AGPL-3.0', pattern: /gnu affero general public license[\s\S]{0,30}?version 3/i },

  // LGPL — version-specific.
  { id: 'LGPL-3.0', pattern: /gnu lesser general public license[\s\S]{0,30}?version 3/i },
  { id: 'LGPL-2.1', pattern: /gnu lesser general public license[\s\S]{0,30}?version 2\.1/i },

  // GPL — version-specific. AGPL/LGPL already filtered above.
  { id: 'GPL-3.0', pattern: /gnu general public license[\s\S]{0,30}?version 3/i },
  { id: 'GPL-2.0', pattern: /gnu general public license[\s\S]{0,30}?version 2/i },

  // The Unlicense — distinctive public-domain dedication phrasing.
  { id: 'Unlicense', pattern: /this is free and unencumbered software released into the public domain/i },

  // 0BSD / BSD-Zero-Clause — distinctive no-attribution-required phrasing.
  { id: '0BSD', pattern: /permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i },

  // CC0 — public domain dedication, distinctive title.
  { id: 'CC0-1.0', pattern: /cc0 1\.0 universal/i },
];

export function inferLicense(text) {
  if (typeof text !== 'string' || text.length < 40) return null;
  // Whitespace normalize so a Win-style \r\n LICENSE file matches the same
  // patterns as a Unix one. Cheap; ~one allocation.
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  for (const fp of FINGERPRINTS) {
    if (fp.pattern.test(t)) return fp.id;
  }
  return null;
}
