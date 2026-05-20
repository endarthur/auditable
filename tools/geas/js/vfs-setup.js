// VFS bootstrap for the geas tool. The filesystem is one IndexedDB
// mount at / — everything (including /tmp) persists across reloads,
// which is what you want for a shell you keep coming back to.

const WELCOME_TEXT = `Welcome to geas — the GCU shell.

A real Unix-shape shell running entirely in your browser. The parser,
executor, and ~55 builtins run in a Web Worker; this filesystem is
IndexedDB-backed and persists across reloads.

Things to try:

  ls /home
  cat /home/welcome.txt
  echo "hello, $USER" | tr a-z A-Z
  seq 1 5 | while read n; do echo "line $n"; done
  for f in /home/*; do echo $f; done
  source /home/hello.sh
  find / -name '*.txt'

Up-arrow recalls history. Files you create persist. Have fun.
`;

const HELLO_SCRIPT = `# A tiny geas script — run it with:  source /home/hello.sh

greet() {
  echo "Hello from a geas function, $1!"
}
greet world

# Typed pipes: CSV in, filtered by a predicate, CSV back out.
printf 'name,age\\nada,36\\ngrace,41\\nalan,32\\n' > /tmp/people.csv
echo "people over 35:"
from-csv /tmp/people.csv | where 'age > 35' | to-csv
`;

// Create the VFS and seed /home on first run. Returns the live VFS.
async function setupVfs(vfsMod) {
  const vfs = await vfsMod.VFS.create({ type: 'idb', name: 'geas-fs' });

  // First-run seeding is gated by a marker file so we don't clobber
  // the user's edits to welcome.txt / hello.sh on later visits.
  let seeded = false;
  try { await vfs.stat('/home/.seeded'); seeded = true; }
  catch { /* not seeded yet */ }

  if (!seeded) {
    await vfs.mkdir('/home', { recursive: true });
    await vfs.mkdir('/tmp', { recursive: true });
    await vfs.writeFile('/home/welcome.txt', WELCOME_TEXT);
    await vfs.writeFile('/home/hello.sh', HELLO_SCRIPT);
    await vfs.writeFile('/home/.seeded', '1');
  }
  return vfs;
}
