// Parallel scan driver — fans a sluice scan across @gcu/proc Pool workers, the
// §7a model: the engine orchestrates on the main thread (cheap) and dispatches
// the heavy SCAN off-thread, chunked, then merges the partial states.
//
// Pure / dependency-injected (takes the sluice module + a proc Pool + a sluice
// module URL), so it runs unchanged in the shell (sluice bundled, proc workers)
// and in Node tests (createNodeWorker, sluice via a data: URL). The worker fn is
// self-contained — proc strips closures, so it receives everything as arguments.
//
// Forward-compatible (not a bodge): the chunk crosses as a Blob by reference (no
// byte copy); proc Phase B (VFS-from-worker) later upgrades the SOURCE the worker
// reads, without touching this driver. The accumulator crosses as a serializable
// spec (sluice.accumulatorFromSpec), the permanent cross-realm op contract.

// Worker-side: import sluice from the given module URL, rebuild the accumulator
// from its spec, scan one Blob chunk, return the partial (mergeable) state.
// Standalone — references only its arguments (proc serializes it via toString()).
export async function _scanChunk(blob, sluiceUrl, parseOpts, accSpec) {
  const S = await import(sluiceUrl);
  const acc = S.accumulatorFromSpec(accSpec);
  return S.scanState(S.recipe(S.fromBlob(blob), S.parseCsv(parseOpts)), acc);
}

// scanParallel({ sluice, pool, sluiceUrl, blob, parseOpts?, accSpec, workers? })
//   sluice    — the sluice module (main-thread: chunks / accumulatorFromSpec / merge)
//   pool      — a @gcu/proc Pool (pool.map dispatches chunks to workers)
//   sluiceUrl — an import()-able URL of the sluice bundle (data:/blob)
//   blob      — the source as a sliceable Blob/File
//   accSpec   — a serializable accumulator spec (sluice.accumulatorFromSpec)
// Returns the finalized accumulator result (merged across chunks).
export async function scanParallel({ sluice, pool, sluiceUrl, blob, parseOpts = {}, accSpec, workers = 4 }) {
  const { header, blobs } = await sluice.chunks(blob, workers, { comment: parseOpts.comment });
  const opts = { ...parseOpts, header };
  const make = () => sluice.accumulatorFromSpec(accSpec);

  let states;
  if (blobs.length <= 1) {
    // Trivial input — skip worker overhead, scan inline.
    const b = blobs[0] || blob;
    states = [await sluice.scanState(sluice.recipe(sluice.fromBlob(b), sluice.parseCsv(opts)), make())];
  } else {
    states = await pool.map(blobs, _scanChunk, { extra: [sluiceUrl, opts, accSpec] });
  }

  const acc = make();
  const merged = states.reduce((a, b) => acc.merge(a, b));
  return acc.result(merged);
}
