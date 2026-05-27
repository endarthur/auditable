// @gcu/epub — public API.
//
// Symmetric writer + reader for EPUB 3 (with EPUB 2 NCX fallback for
// Kindle / older readers). Pure JS, no DOM, runs in Node + browser.
// Depends on @gcu/archive for ZIP layer — passed by dep injection so
// the library stays decoupled and tree-shakable.
//
// Round-trip property: readEpub(writeEpub(spec, { archive }), { archive })
// returns a spec whose metadata, chapters, cover, resources, and toc
// match the input (modulo XHTML envelope stripping on chapter bodies).

import { writeEpub, EpubError } from './write.js';
import { readEpub } from './read.js';
import { normalizeXhtml, chapterDoc } from './xhtml.js';
import { extractHeadings, buildTocTree } from './toc.js';
import {
  containerXml, contentOpf, tocNcx, navXhtml, DEFAULT_STYLES,
} from './manifest.js';

export {
  // High-level
  writeEpub, readEpub, EpubError,
  // Lower-level for callers that want to compose differently
  normalizeXhtml, chapterDoc,
  extractHeadings, buildTocTree,
  containerXml, contentOpf, tocNcx, navXhtml,
  DEFAULT_STYLES,
};
