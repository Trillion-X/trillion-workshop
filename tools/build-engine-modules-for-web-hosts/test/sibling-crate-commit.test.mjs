// tools/build-engine-modules-for-web-hosts/test/sibling-crate-commit.test.mjs
//
// A crate outside the Workshop (the engine's crates beside it) is fingerprinted at the commit the fingerprint records, read
// from git. Uncommitted edits in that checkout, which other sessions may hold, must not change the result, and a fingerprint
// with no recorded commit for such a crate is refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_TOOL } from '../build/compiled-modules.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

test('uncommitted edits beside the Workshop do not change a sibling crate\'s fingerprint', async () => {
  const root = tempFolder(join(tmpdir(), 'sibling-crate-commit-'));
  try {
    // A sibling checkout whose crates/ folder is the top of its own repository, as the writer requires.
    const crates = join(root, 'sibling', 'crates');
    mkdirSync(join(crates, 'lib', 'src'), { recursive: true });
    writeFileSync(join(crates, 'Cargo.toml'), '[workspace]\nresolver = "2"\nmembers = ["lib"]\n');
    writeFileSync(join(crates, 'Cargo.lock'), 'version = 4\n');
    writeFileSync(join(crates, 'lib', 'Cargo.toml'), '[package]\nname = "lib"\nversion = "0.1.0"\n');
    writeFileSync(join(crates, 'lib', 'src', 'lib.rs'), 'pub fn answer() -> u8 { 1 }\n');
    git(crates, ['init', '-q']);
    git(crates, ['add', '.']);
    git(crates, ['commit', '-q', '-m', 'crates']);
    const first = git(crates, ['rev-parse', 'HEAD']);

    // A copy of the build folder inside a temporary Workshop, so its TOOLS and WORKSHOP are this layout.
    const workshop = join(root, 'workshop');
    cpSync(join(BUILD_TOOL, 'build'), join(workshop, 'tools', 'build-engine-modules-for-web-hosts', 'build'), { recursive: true });
    cpSync(join(BUILD_TOOL, '..', 'process-session'), join(workshop, 'tools', 'process-session'), { recursive: true });
    symlinkSync(join(BUILD_TOOL, '..', '..', 'node_modules'), join(workshop, 'node_modules'));
    const { crateSourceFingerprint } = await import(pathToFileURL(join(workshop, 'tools', 'build-engine-modules-for-web-hosts', 'build', 'compiled-modules.mjs')).href);
    const dir = '../../sibling/crates/lib';
    const workspace = '../../sibling/crates';

    const committed = await crateSourceFingerprint([dir], [], { [workspace]: first });
    // Uncommitted edits to a crate source and to the workspace lock, in the sibling's working files.
    writeFileSync(join(crates, 'lib', 'src', 'lib.rs'), 'pub fn answer() -> u8 { 2 }\n');
    writeFileSync(join(crates, 'Cargo.lock'), 'version = 4\n# another session\n');
    assert.equal(await crateSourceFingerprint([dir], [], { [workspace]: first }), committed);

    // A new commit changes what the fingerprint of that new commit reads, and the old commit still reads the same.
    git(crates, ['add', '.']);
    git(crates, ['commit', '-q', '-m', 'answer two']);
    const second = git(crates, ['rev-parse', 'HEAD']);
    assert.notEqual(await crateSourceFingerprint([dir], [], { [workspace]: second }), committed);
    assert.equal(await crateSourceFingerprint([dir], [], { [workspace]: first }), committed);

    // No recorded commit for a crate outside the Workshop is refused, not read from the working files.
    await assert.rejects(crateSourceFingerprint([dir], []), /has no recorded commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
