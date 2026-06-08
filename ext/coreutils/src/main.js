// @gcu/coreutils — a lite, worker-free coreutils subset over a @gcu/vfs-shaped
// filesystem. The seed of the full @gcu/coreutils extraction geas anticipates; for
// now, the genuinely-useful handful (ls/cat/echo/mkdir/rm/cp/mv/touch/head/tail) that
// any VFS-backed GCU surface can run without geas's process machinery — so they work
// on file:// too. Host-agnostic contract: run(argv, { vfs, cwd }) → { stdout, stderr,
// code }. Package management is NOT here — it's the host's concern.

import { ls, cat, echo, mkdir, rm, cp, mv, touch, head, tail } from './commands.js';

export const COMMANDS = { ls, cat, echo, mkdir, rm, cp, mv, touch, head, tail };
export const names = Object.keys(COMMANDS);

// Run one command. argv = [cmd, ...args]; env = { vfs, cwd? } (cwd defaults to '/').
export async function run(argv, env = {}) {
  const cmd = argv[0];
  const fn = COMMANDS[cmd];
  if (!fn) return { stdout: '', stderr: `${cmd}: command not found`, code: 127 };
  if (!env.vfs) return { stdout: '', stderr: `${cmd}: no filesystem`, code: 1 };
  try {
    return await fn(argv.slice(1), { vfs: env.vfs, cwd: env.cwd || '/' });
  } catch (e) {
    return { stdout: '', stderr: `${cmd}: ${(e && e.message) || e}`, code: 1 };
  }
}

export { ls, cat, echo, mkdir, rm, cp, mv, touch, head, tail };
