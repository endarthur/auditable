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
//   tar.js     — POSIX ustar reader/writer
//   gz.js      — gzip helpers (native (De)CompressionStream)
//   zst.js     — zstd helpers (fzstd wrapper)
//   xz.js      — xz decoder (xz-decompress wrapper)
//   bz2.js     — bzip2 decoder (seek-bzip wrapper)
//   walk.js    — VFS directory walker for compress paths
//   writer.js  — streaming archive writer (createWriter)
//   api.js     — public surface

export * from './detect.js';
export * from './source.js';
export * from './sink.js';
export * from './zip.js';
export * from './tar.js';
export * from './gz.js';
export * from './zst.js';
export * from './xz.js';
export * from './bz2.js';
export * from './walk.js';
export * from './writer.js';
export * from './api.js';
