// Type declarations for @gcu/adder/vfs.
// Explicit opt-in to adder's global VFS plumbing. Most consumers should pass
// a `vfs` option to run()/compile() instead — those restore the prior VFS
// on exit. These setters mutate module-level state.

export type VFSLike = object;

/** Install a VFS instance for adder's open(), os, pathlib builtins to use.
 *  Mutates module-level state — persists across subsequent run() calls. */
export function setAdderVFS(vfs: VFSLike | null): void;

/** Return the currently-installed VFS instance, or null if none. */
export function getAdderVFS(): VFSLike | null;
