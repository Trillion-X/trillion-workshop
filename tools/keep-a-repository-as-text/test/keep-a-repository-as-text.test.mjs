// tools/keep-a-repository-as-text/test/keep-a-repository-as-text.test.mjs
//
// Unit tests run on a fixture repository made in a temp folder. The live test pulls TheMattBerman/ad-spy-kit from GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkInput, cloneShallow, keepRepositoryAsText, licenceOf, pullAndBundle, pullRoot } from '../keep-a-repository-as-text.mjs';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test'];
const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';
const MOST_BYTES_PER_FILE = 200000;

/** A fixture repository with a binary file, a file over the cap, a symlink, a LICENSE, and a hook that would leave a marker. */
async function makeFixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'kart-fixture-'));
  const repo = path.join(base, 'repo');
  const marker = path.join(base, 'hook-ran');
  await mkdir(repo);
  await run('git', ['init', '--quiet', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# Fixture\n\nA text file.\n');
  await writeFile(path.join(repo, 'LICENSE'), MIT_TEXT);
  await writeFile(path.join(repo, 'picture.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  await writeFile(path.join(repo, 'huge.txt'), 'a'.repeat(MOST_BYTES_PER_FILE + 5000));
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src', 'index.mjs'), 'export const answer = 42;\n');
  await run('ln', ['-s', 'README.md', path.join(repo, 'link-to-readme')]);
  await run('git', ['-C', repo, 'add', '--all']);
  await run('git', [...GIT_ID, '-C', repo, 'commit', '--quiet', '-m', 'fixture']);
  // A hook in the fixture's own .git folder. A fetch never copies it, so it must not run in the pulled copy.
  await writeFile(path.join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  return { base, repo, marker, remote: `file://${repo}` };
}

async function freshFolder(base) {
  const dir = path.join(base, `clone-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir);
  return dir;
}

test('the DATA default root resolves to the unbranded pulled-files folder without creating it', () => {
  assert.equal(pullRoot(), path.join(homedir(), 'Library', 'Application Support', 'pulled-files', 'repos'));
});

test('refuses an address that is not a plain https repository address, before git runs', () => {
  assert.match(checkInput({ url: 'http://github.com/a/b' }).error, /https/);
  const withCredentials = new URL('https://github.com/a/b');
  withCredentials.username = 'user';
  withCredentials.password = 'pw';
  assert.match(checkInput({ url: withCredentials.href }).error, /user name or password/);
  assert.match(checkInput({ url: 'https://github.com/a/b?x=1' }).error, /query or fragment/);
  assert.match(checkInput({ url: 'https://github.com/only-owner' }).error, /owner and a repository/);
  assert.match(checkInput({ url: 'https://github.com/a/b', ref: '--upload-pack=touch' }).error, /plain letters/);
  assert.match(checkInput({ url: 'https://github.com/a/b', ref: 'x/../y' }).error, /plain letters/);
  assert.deepEqual(checkInput({ url: ' https://github.com/a/b.git ' }), {
    url: 'https://github.com/a/b',
    host: 'github.com',
    segments: ['a', 'b'],
    ref: null,
  });
});

test('clones without running any hook and without installing template hooks', async () => {
  const fixture = await makeFixture();
  const dir = await freshFolder(fixture.base);
  const commit = await cloneShallow(fixture.remote, null, dir);
  assert.match(commit, /^[0-9a-f]{40}$/);
  await assert.rejects(stat(fixture.marker), { code: 'ENOENT' });
  const hooks = await readdir(path.join(dir, '.git', 'hooks')).catch(() => []);
  assert.deepEqual(hooks.filter(name => !name.endsWith('.sample')), []);
  await rm(fixture.base, { recursive: true, force: true });
});

test('answers plain words when the repository or the ref is not there', async () => {
  const fixture = await makeFixture();
  await assert.rejects(cloneShallow('file:///no/such/repository', null, await freshFolder(fixture.base)), /was not found, or it needs a sign-in/);
  await assert.rejects(cloneShallow(fixture.remote, 'no-such-branch', await freshFolder(fixture.base)), /ref no-such-branch was not found/);
  await rm(fixture.base, { recursive: true, force: true });
});

test('bundles one text file with a header, a file list, skips with reasons, and the identity of its bytes', async () => {
  const fixture = await makeFixture();
  const root = path.join(fixture.base, 'pulled');
  const answer = await pullAndBundle({
    url: 'https://example.test/owner/fixture',
    host: 'example.test',
    segments: ['owner', 'fixture'],
    remote: fixture.remote,
    root,
  });
  assert.equal(answer.licence, 'MIT');
  assert.match(answer.commit, /^[0-9a-f]{40}$/);
  assert.equal(path.basename(answer.bundle_path), `example.test__owner__fixture@${answer.commit}.txt`);
  const bytes = await readFile(answer.bundle_path);
  assert.equal(answer.bundle_bytes, bytes.length);
  assert.equal(answer.bundle_blake3, makeHashCodeHexFromBytes(bytes));
  assert.match(answer.bundle_blake3, /^1f:[0-9a-f]{64}$/);
  const body = bytes.toString('utf8');
  assert.match(body, new RegExp(`commit: ${answer.commit}`));
  assert.match(body, /licence: MIT/);
  assert.match(body, /===== src\/index\.mjs \(\d+ bytes\) =====\nexport const answer = 42;/);
  assert.match(body, /===== README\.md/);
  const skipped = Object.fromEntries(answer.files_skipped.map(s => [s.path, s.why]));
  assert.match(skipped['picture.bin'], /NUL byte/);
  assert.match(skipped['huge.txt'], /per-file cap/);
  assert.match(skipped['link-to-readme'], /symbolic link/);
  assert.equal(answer.files_kept, 3);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('clone-')), []);
  await rm(fixture.base, { recursive: true, force: true });
});

test('the same fixture commit gives the same bundle bytes and BLAKE3 on repeat pulls', async () => {
  const fixture = await makeFixture();
  try {
    const request = {
      url: 'https://example.test/owner/fixture',
      host: 'example.test',
      segments: ['owner', 'fixture'],
      remote: fixture.remote,
      root: path.join(fixture.base, 'pulled'),
    };
    const first = await pullAndBundle(request);
    const firstBytes = await readFile(first.bundle_path);
    const second = await pullAndBundle(request);
    const secondBytes = await readFile(second.bundle_path);
    assert.equal(first.commit, second.commit);
    assert.equal(first.bundle_path, second.bundle_path);
    assert.equal(first.bundle_blake3, second.bundle_blake3);
    assert.equal(first.bundle_bytes, second.bundle_bytes);
    assert.deepEqual(firstBytes, secondBytes);
    assert.doesNotMatch(secondBytes.toString('utf8'), /^kept at:/m);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('stops at the total cap and says which files were left out', async () => {
  const fixture = await makeFixture();
  const chunk = 'b'.repeat(190000);
  for (let i = 0; i < 45; i += 1) await writeFile(path.join(fixture.repo, `part-${String(i).padStart(2, '0')}.txt`), chunk);
  await run('git', ['-C', fixture.repo, 'add', '--all']);
  await run('git', [...GIT_ID, '-C', fixture.repo, 'commit', '--quiet', '-m', 'many parts']);
  const answer = await pullAndBundle({
    url: 'https://example.test/owner/many',
    host: 'example.test',
    segments: ['owner', 'many'],
    remote: fixture.remote,
    root: path.join(fixture.base, 'pulled'),
  });
  const capSkips = answer.files_skipped.filter(s => /total cap/.test(s.why));
  assert.ok(capSkips.length > 0, 'expected files skipped at the total cap');
  assert.ok(answer.bundle_bytes < 8_200_000, `bundle is ${answer.bundle_bytes} bytes`);
  await rm(fixture.base, { recursive: true, force: true });
});

test('finds a licence file at any depth, and says when its id is not identified', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'kart-licence-'));
  await mkdir(path.join(base, 'skills'));
  await writeFile(path.join(base, 'skills', 'LICENSE-notes'), 'Some terms of our own.\n');
  const files = [{ path: 'skills/LICENSE-notes', kind: 'file' }];
  assert.equal(await licenceOf({ host: 'example.test', segments: ['a', 'b'], files, root: base }), 'licence file skills/LICENSE-notes present; its SPDX id was not identified (read the file in the bundle)');
  await writeFile(path.join(base, 'skills', 'LICENSE-notes'), MIT_TEXT);
  assert.equal(await licenceOf({ host: 'example.test', segments: ['a', 'b'], files, root: base }), 'MIT only, in skills/LICENSE-notes (no licence file at the repository root)');
  await writeFile(path.join(base, 'LICENSE'), MIT_TEXT);
  files.push({ path: 'LICENSE', kind: 'file' });
  assert.equal(await licenceOf({ host: 'example.test', segments: ['a', 'b'], files, root: base }), 'MIT');
  assert.equal(await licenceOf({ host: 'example.test', segments: ['a', 'b'], files: [], root: base }), 'none declared (all rights reserved by default)');
  await rm(base, { recursive: true, force: true });
});

test('live: keeps TheMattBerman/ad-spy-kit from GitHub as text with its MIT licence', { skip: process.env.REPOSITORY_TEXT_LIVE_TEST !== '1' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kart-live-'));
  try {
    const answer = await keepRepositoryAsText({ url: 'https://github.com/TheMattBerman/ad-spy-kit' }, { root });
    assert.equal(answer.error, undefined, answer.error);
    assert.equal(answer.licence, 'MIT');
    assert.match(answer.commit, /^[0-9a-f]{40}$/);
    assert.ok(answer.files_kept > 0);
    const bytes = await readFile(answer.bundle_path);
    assert.equal(answer.bundle_blake3, makeHashCodeHexFromBytes(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
