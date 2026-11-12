// The judge's contract reads come back byte-identical whether each blob is read by its own git process or batched through
// one `git cat-file --batch` process, and a path git cannot find reads as null both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitReaders } from '../do-work/read-from-repositories.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function repository(count) {
  const root = mkdtempSync(join(tmpdir(), 'batch-read-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'ports'), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(root, 'ports', `contract-${index}.json`), JSON.stringify({ index, text: 'x'.repeat(index * 37 % 5000) }));
  }
  writeFileSync(join(root, 'ports', 'binary.bin'), Buffer.from([0, 1, 2, 255, 10, 13]));
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'contracts');
  return root;
}

test('batched contract reads equal one git process per blob, byte for byte', () => {
  const root = repository(390);
  const paths = [...Array(390).keys()].map((index) => `ports/contract-${index}.json`).concat(['ports/binary.bin', 'ports/absent.json']);
  const plain = gitReaders({ root, tree: 'HEAD' });
  const expected = paths.map((path) => plain.readTarget(path));
  const batched = gitReaders({ root, tree: 'HEAD' });
  const started = Date.now();
  batched.prefetchTargets(paths);
  const seconds = (Date.now() - started) / 1000;
  const actual = paths.map((path) => batched.readTarget(path));
  assert.equal(actual.length, 392);
  actual.forEach((bytes, index) => {
    if (expected[index] === null) assert.equal(bytes, null, paths[index]);
    else assert.ok(Buffer.from(expected[index]).equals(Buffer.from(bytes)), `${paths[index]} is byte-identical`);
  });
  assert.equal(actual.at(-1), null, 'a path git cannot find reads as null');
  console.log(`prefetch of ${paths.length} blobs took ${seconds.toFixed(3)} s`);
});
