// @gcu/coreutils — lite coreutils over a @gcu/vfs filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, names } from '../ext/coreutils/src/main.js';
import { VFS } from '../ext/vfs/index.js';

async function setup() {
  const vfs = await VFS.create();
  await vfs.mkdir('/home');
  await vfs.writeFile('/home/a.txt', 'alpha\nbeta\ngamma\n');
  await vfs.writeFile('/home/b.txt', 'B');
  await vfs.mkdir('/home/sub');
  return vfs;
}
const sh = (vfs, line) => run(line.split(' '), { vfs, cwd: '/home' });

test('ls lists a dir and marks subdirectories', async () => {
  const vfs = await setup();
  const r = await sh(vfs, 'ls');
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout.split('\n').sort(), ['a.txt', 'b.txt', 'sub/']);
});

test('ls -l shows type + size', async () => {
  const r = await sh(await setup(), 'ls -l');
  assert.match(r.stdout, /- +1 b\.txt/);
  assert.match(r.stdout, /d +\d+ sub/);
});

test('cat reads a file relative to cwd', async () => {
  const r = await sh(await setup(), 'cat a.txt');
  assert.equal(r.stdout, 'alpha\nbeta\ngamma\n');
});

test('cat missing file → code 1', async () => {
  const r = await sh(await setup(), 'cat nope.txt');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No such file/);
});

test('echo joins args literally', async () => {
  const r = await run(['echo', 'hello', 'world'], { vfs: await setup() });
  assert.equal(r.stdout, 'hello world');
});

test('mkdir + touch create entries', async () => {
  const vfs = await setup();
  await sh(vfs, 'mkdir new');
  assert.ok(await vfs.exists('/home/new'));
  await sh(vfs, 'touch new/x.txt');
  assert.ok(await vfs.exists('/home/new/x.txt'));
});

test('mkdir -p creates parents', async () => {
  const vfs = await setup();
  const r = await sh(vfs, 'mkdir -p deep/a/b');
  assert.equal(r.code, 0);
  assert.ok(await vfs.exists('/home/deep/a/b'));
});

test('rm a file; rm a dir needs -r', async () => {
  const vfs = await setup();
  assert.equal((await sh(vfs, 'rm b.txt')).code, 0);
  assert.ok(!(await vfs.exists('/home/b.txt')));
  const noR = await sh(vfs, 'rm sub');
  assert.equal(noR.code, 1);
  assert.match(noR.stderr, /is a directory/);
  assert.equal((await sh(vfs, 'rm -r sub')).code, 0);
  assert.ok(!(await vfs.exists('/home/sub')));
});

test('cp then mv', async () => {
  const vfs = await setup();
  await sh(vfs, 'cp a.txt c.txt');
  assert.equal(await vfs.readFile('/home/c.txt'), 'alpha\nbeta\ngamma\n');
  await sh(vfs, 'mv c.txt d.txt');
  assert.ok(!(await vfs.exists('/home/c.txt')));
  assert.ok(await vfs.exists('/home/d.txt'));
});

test('head -n 2 / tail -n 1', async () => {
  const vfs = await setup();
  assert.equal((await sh(vfs, 'head -n 2 a.txt')).stdout, 'alpha\nbeta');
  assert.equal((await sh(vfs, 'tail -n 1 a.txt')).stdout, 'gamma');
});

test('unknown command → code 127', async () => {
  const r = await run(['frobnicate'], { vfs: await setup() });
  assert.equal(r.code, 127);
});

test('absolute paths ignore cwd', async () => {
  const r = await sh(await setup(), 'cat /home/b.txt');
  assert.equal(r.stdout, 'B');
});

test('names export lists the command set', () => {
  assert.ok(names.includes('ls') && names.includes('cat') && names.includes('rm'));
});
