// The one cargo target folder every build shares (build/shared-cargo-target.mjs): one build holds it at a time, a lock
// left by a process that ended is taken over, it is cleared past its ceiling, and a workspace whose sources differ from
// the last one built gets fresh file times so cargo builds it again instead of reusing another copy's output.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARGO_TARGET_CEILING, cargoEnv, sharedCargoTargetFolder, withSharedCargoTarget } from '../build/shared-cargo-target.mjs';

function setUp() {
  const home = tempFolder(join(tmpdir(), 'trillion-cargo-target-'));
  const folder = join(home, 'cache', 'cargo-target');
  const workspace = join(home, 'crates');
  mkdirSync(join(workspace, 'one', 'src'), { recursive: true });
  writeFileSync(join(workspace, 'one', 'src', 'lib.rs'), 'pub fn one() {}\n');
  writeFileSync(join(workspace, 'Cargo.lock'), '# lock\n');
  const before = process.env.TRILLION_CARGO_TARGET_DIR;
  process.env.TRILLION_CARGO_TARGET_DIR = folder;
  return { home, folder, workspace, done: () => { if (before === undefined) delete process.env.TRILLION_CARGO_TARGET_DIR; else process.env.TRILLION_CARGO_TARGET_DIR = before; rmSync(home, { recursive: true, force: true }); } };
}

test('every build is handed the same folder, marked as a cache, and cargo is pointed at it', async () => {
  const { folder, workspace, done } = setUp();
  try {
    assert.equal(sharedCargoTargetFolder(), folder);
    const seen = await withSharedCargoTarget(workspace, given => given);
    assert.equal(seen, folder);
    assert.match(readFileSync(join(folder, 'CACHEDIR.TAG'), 'utf8'), /^Signature: 8a477f597d28d172789f06886806bc55/);
    assert.equal(cargoEnv(folder).CARGO_TARGET_DIR, folder);
    assert.equal(existsSync(`${folder}.lock`), false, 'the lock is given back when the work ends');
  } finally { done(); }
});

test('a lock whose process has ended is taken over, and the lock is given back when the work throws', async () => {
  const { folder, workspace, done } = setUp();
  try {
    mkdirSync(`${folder}.lock`, { recursive: true });
    writeFileSync(join(`${folder}.lock`, 'pid'), '999999999');
    await assert.rejects(withSharedCargoTarget(workspace, () => { throw new Error('build failed'); }), /build failed/);
    assert.equal(existsSync(`${folder}.lock`), false);
  } finally { done(); }
});

test('two builds at once take turns: the second gets the folder only after the first gives it back', async () => {
  const { home, workspace, done } = setUp();
  try {
    const { spawn } = await import('node:child_process');
    const stamp = join(home, 'second-got-it');
    const script = `import { writeFileSync } from 'node:fs'; import { withSharedCargoTarget } from ${JSON.stringify(new URL('../build/shared-cargo-target.mjs', import.meta.url).href)}; await withSharedCargoTarget(${JSON.stringify(workspace)}, () => writeFileSync(${JSON.stringify(stamp)}, String(Date.now())));`;
    let firstEnded = 0;
    let second;
    await withSharedCargoTarget(workspace, async () => {
      second = new Promise(resolve => spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'inherit' }).on('exit', resolve));
      await new Promise(resolve => setTimeout(resolve, 800));
      firstEnded = Date.now();
    });
    assert.equal(await second, 0);
    assert.ok(Number(readFileSync(stamp, 'utf8')) >= firstEnded, 'the second build ran only after the first ended');
  } finally { done(); }
});

test('a workspace whose sources differ from the last one built gets fresh file times; the same sources keep theirs', async () => {
  const { workspace, done } = setUp();
  try {
    const source = join(workspace, 'one', 'src', 'lib.rs');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(source, old, old);
    await withSharedCargoTarget(workspace, () => {});
    assert.ok(statSync(source).mtimeMs > old.getTime(), 'first build of these sources refreshes their times');
    utimesSync(source, old, old);
    await withSharedCargoTarget(workspace, () => {});
    assert.equal(statSync(source).mtimeMs, old.getTime(), 'the same sources built again are left alone');
    writeFileSync(source, 'pub fn one() { let _ = 1; }\n');
    utimesSync(source, old, old);
    await withSharedCargoTarget(workspace, () => {});
    assert.ok(statSync(source).mtimeMs > old.getTime(), 'changed sources with an old time are refreshed so cargo rebuilds them');
  } finally { done(); }
});

test('past its ceiling the folder is cleared before the next build', async () => {
  const { folder, workspace, done } = setUp();
  const ceiling = CARGO_TARGET_CEILING.gigabytes;
  try {
    await withSharedCargoTarget(workspace, given => writeFileSync(join(given, 'old-output'), Buffer.alloc(2 * 1024 * 1024)));
    CARGO_TARGET_CEILING.gigabytes = 1 / 1024; // 1 MB
    await withSharedCargoTarget(workspace, () => {});
    assert.equal(existsSync(join(folder, 'old-output')), false);
    assert.equal(existsSync(join(folder, 'CACHEDIR.TAG')), true);
  } finally { CARGO_TARGET_CEILING.gigabytes = ceiling; done(); }
});

test('cargo is told to keep this computer\'s home, checkouts, cargo, rustup and checkout paths out of every compiled module', () => {
  const before = { flags: process.env.RUSTFLAGS, encoded: process.env.CARGO_ENCODED_RUSTFLAGS };
  process.env.RUSTFLAGS = '-C target-feature=+simd128';
  delete process.env.CARGO_ENCODED_RUSTFLAGS;
  try {
    const flags = cargoEnv('/some/folder').CARGO_ENCODED_RUSTFLAGS.split('\x1f');
    assert.equal(flags[0], '-C', 'flags a script already set are kept');
    assert.ok(flags.includes('target-feature=+simd128'));
    const maps = flags.filter(flag => flag.startsWith('--remap-path-prefix='));
    assert.deepEqual(maps.map(flag => flag.split('=').pop()), ['/home', '/checkouts', '/rustup', '/cargo', '/trillion']);
    assert.equal(maps.at(-1), `--remap-path-prefix=${fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')}=/trillion`, 'the checkout comes last, so it wins over the home folder around it');
  } finally {
    if (before.flags === undefined) delete process.env.RUSTFLAGS; else process.env.RUSTFLAGS = before.flags;
    if (before.encoded !== undefined) process.env.CARGO_ENCODED_RUSTFLAGS = before.encoded;
  }
});
