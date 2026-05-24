// Public Librarian API. Pure functions; no hidden state.

import { tokenize, tokenizeStrings } from './tokenize.js';
import { editDistance, nearTerms } from './fuzzy.js';
import { buildIndex, mergeIndexes } from './index.js';
import { search, suggest } from './search.js';
import { serialize, deserialize } from './serialize.js';

export const Librarian = {
  index: buildIndex,
  search,
  suggest,
  serialize,
  deserialize,
  merge: mergeIndexes,
  tokenize,
  editDistance,
};
