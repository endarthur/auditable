// @gcu/book — shell-context entry (surface registration). EXTENSION_SPEC §2.5 + §3.8.
//
// The Book reader — reflowable long-form reading (a directory with book.json +
// md/html chapters; see openPath). Lib deps docview/katex/librarian/reader-core
// via gcu.requires; markdown is a baked CORE_LIB. Source surface is reader.html.

const BOOK_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/book',
      version: BOOK_VERSION,
      description: 'Book reader — reflowable long-form reading (book.json + md/html chapters), highlights, search, KaTeX math.',
      surfaces: [
        {
          kind:     'book',
          label:    'Book',
          icon:     '▤',
          file:     'surface.html',
          requires: ['abus', 'surface', 'markdown', 'docview', 'katex', 'librarian', 'reader-core'],
        },
      ],
    });
  }
}
