// @gcu/lamina — windowed, read-only viewer for arbitrarily huge files.
// Public surface (manifest-is-truth; @gcu/build bundles from here).
export { createRecordScanner, scanRecords, scanFileToIndex, splitRecords, parseFields } from './scan.js';
export { buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey } from './source.js';
export { createRecordViewSource, LOADING } from './viewsource.js';
export { parseFilter, scanFilter, createFilteredViewSource } from './filter.js';
export { detectKind } from './detect.js';
export { createLaminaProvider } from './provider.js';
