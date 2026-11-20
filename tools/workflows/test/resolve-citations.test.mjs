import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCitationsInGrantedRoot } from '../read-data/resolve-citations.mjs';
import { resolveItem } from '../read-data/citation-resolvers.mjs';

// A made-up repository, so the tool is tested with no name of ours in it.
function madeUpRepo() {
  const folder = join(tempFolder(join(tmpdir(), 'citation-test-')), 'made-up-repo');
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'src', 'thing.txt'), 'first line\nsecond line holds the words\nthird line\n');
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'made up');
  return { folder, sha: git('rev-parse', '--short=10', 'HEAD') };
}

test('a citation of the granted repository holds when its line holds the quote', async () => {
  const { folder, sha } = madeUpRepo();
  const { result } = await resolveCitationsInGrantedRoot({ items: [
    { cite: `made-up-repo/src/thing.txt:2@${sha}`, quote: 'second line holds' },
    { cite: 'made-up-repo/src/thing.txt:1-2', quote: 'first line' },
  ] }, folder);
  assert.equal(result[0].ok, true);
  assert.equal(result[1].ok, true);
});

test('a quote the cited line does not hold is refused with the line', async () => {
  const { folder, sha } = madeUpRepo();
  const { result } = await resolveCitationsInGrantedRoot({ items: [{ cite: `made-up-repo/src/thing.txt:3@${sha}`, quote: 'second line' }] }, folder);
  assert.equal(result[0].ok, false);
  assert.match(result[0].why, /does not hold the quoted text/);
});

test('a citation naming another repository is refused: it is not the granted folder', async () => {
  const { folder, sha } = madeUpRepo();
  const { result } = await resolveCitationsInGrantedRoot({ items: [{ cite: `other-repo/src/thing.txt:2@${sha}`, quote: 'second' }] }, folder);
  assert.deepEqual(result, [{ cite: `other-repo/src/thing.txt:2@${sha}`, ok: false, why: 'root not granted to this run', against: null }]);
});

test('a run with no granted folder cannot resolve any citation', async () => {
  const { sha } = madeUpRepo();
  await assert.rejects(resolveCitationsInGrantedRoot({ items: [{ cite: `made-up-repo/src/thing.txt:2@${sha}` }] }, ''), /needs the one folder granted/);
});

test('a commit named in the text is found in the granted repository and dated after the given date', async () => {
  const { folder, sha } = madeUpRepo();
  const check = { kind: 'cites-resolve', field: 'cite', resolver: 'commits', after: 'after' };
  const [verdict] = await resolveItem(check, { cite: sha, after: '2000-01-01T00:00:00Z' }, { granted: folder });
  assert.equal(verdict.ok, true);
  const [late] = await resolveItem(check, { cite: sha, after: '2999-01-01T00:00:00Z' }, { granted: folder });
  assert.equal(late.ok, false);
});
