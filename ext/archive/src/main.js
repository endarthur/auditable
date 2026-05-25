// @gcu/archive — archive format handling for the GCU stack
//
// Module manifest. Each file is a piece of the pipeline:
//   detect.js  — magic-byte format sniffing + extension fallback
//   source.js  — source adapter normalization (Uint8Array | VFS | stream | fetch)
//   sink.js    — sink adapter normalization (VFS | stream | memory)
//   zip.js     — ZIP read/write (fflate wrapper)
//   api.js     — public surface: archive.list, archive.read, archive.extract,
//                archive.compress, archive.stream, archive.gzip/gunzip, etc.
//
// Future-shipped (planned, not yet in main.js):
//   tar.js     — POSIX ustar reader/writer
//   gz.js      — gzip helpers (native (De)CompressionStream)
//   zst.js     — zstd helpers (fzstd wrapper)
//   xz.js      — lazy-loaded xz decoder
//   bz2.js     — lazy-loaded bzip2 decoder
//   walk.js    — VFS directory walker for compress paths

export * from './detect.js';
export * from './source.js';
export * from './sink.js';
export * from './zip.js';
export * from './tar.js';
export * from './gz.js';
export * from './zst.js';
export * from './walk.js';
export * from './writer.js';
export * from './api.js';
