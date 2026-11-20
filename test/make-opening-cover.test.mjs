import { tempFolder } from '../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openingCoverFiles, ROOT, IOS_COVER, IOS_NEEDLE_SET, IOS_PAPER_SET } from '../tools/draw-the-apps-icon-in-every-size-from/scripts/make-opening-cover.mjs';

test('an explicit output root changes only the four destinations, preserving the default contract and bytes', t => {
  const root = tempFolder(join(tmpdir(), 'opening-cover-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaults = openingCoverFiles();
  assert.deepEqual(Object.keys(defaults), [IOS_COVER, join(IOS_NEEDLE_SET, 'cover-needle.svg'), join(IOS_NEEDLE_SET, 'Contents.json'), join(IOS_PAPER_SET, 'Contents.json')]);
  const explicit = openingCoverFiles({ outputRoot: root });
  assert.deepEqual(Object.keys(explicit).map(path => relative(root, path)), Object.keys(defaults).map(path => relative(ROOT, path)));
  assert.deepEqual(Object.values(explicit), Object.values(defaults));
  assert.equal(existsSync(join(root, 'ios')), false, 'asking for bytes writes nothing');
});

test('the real CLI writes every expected byte under its explicit destination and refuses an incomplete option', t => {
  const root = tempFolder(join(tmpdir(), 'opening-cover-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = fileURLToPath(new URL('../tools/draw-the-apps-icon-in-every-size-from/scripts/make-opening-cover.mjs', import.meta.url));
  const absent = spawnSync(process.execPath, [command, '--output-root'], { encoding: 'utf8' });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /Usage:/);
  const run = spawnSync(process.execPath, [command, '--output-root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const expected = openingCoverFiles({ outputRoot: root });
  assert.equal(run.stdout.trim().split('\n').length, 4);
  for (const [path, bytes] of Object.entries(expected)) assert.equal(readFileSync(path, 'utf8'), bytes);
});
