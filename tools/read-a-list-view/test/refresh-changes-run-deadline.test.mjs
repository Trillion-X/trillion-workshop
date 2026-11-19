// A refresh of changed documents (changes), and the command line's own deadline: a changed document reconciles only its
// own rows, a document the folder still holds with no answer keeps its old rows, and the command refuses a passed deadline
// before reading its input, and an invalid one as not_started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refreshRowSources } from '../read-data/list-view.mjs';
import { NAMES, choresList, recipe, recipesFolder, storedOf, storeAfter } from './support/stored.mjs';

const CLI = fileURLToPath(new URL('../do-work/read-list-view.mjs', import.meta.url));

async function kitchen() {
  const folder = await recipesFolder({ 'bread.md': recipe('bread', 40), 'buns.md': recipe('buns', 25) });
  const list = choresList([{ source: 'documents', of: '/', root: folder.root }]);
  const base = storedOf([['list:chores', 'list', list]]);
  const first = await refreshRowSources({ names: NAMES, list: 'chores', stored: base });
  const stored = { records: storeAfter(base.records, first.keep) };
  return { folder, stored };
}

test('--changes reconciles only the named document, read by its own path, and the other is left alone', async () => {
  const k = await kitchen();
  await k.folder.write('bread.md', recipe('bread', 50));
  await k.folder.write('buns.md', recipe('buns', 99));
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored: k.stored,
    changes: { documents: { paths: ['/bread.md'], removed: [] } } });
  assert.deepEqual(answer.keep.map(row => row.id), ['record:chore:documents~%2Fbread.md']);
  assert.equal(answer.keep[0].value['note.minutes'], 50);
});

test('a changed document whose row is unchanged writes nothing', async () => {
  const k = await kitchen();
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored: k.stored,
    changes: { documents: { paths: ['/bread.md'], removed: [] } } });
  assert.deepEqual(answer.keep, []);
  assert.equal(answer.sources[0].unchanged, 1);
});

test('a changed document the source no longer answers keeps its old row: a deletion is named in removed, never inferred', async () => {
  const k = await kitchen();
  const { rm } = await import('node:fs/promises');
  await rm(`${k.folder.root}/bread.md`);
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored: k.stored,
    changes: { documents: { paths: ['/bread.md'], removed: [] } } }).catch(error => error);
  assert.equal(answer.code, 'source_changed_path_unanswered');
  const removal = await refreshRowSources({ names: NAMES, list: 'chores', stored: k.stored,
    changes: { documents: { paths: [], removed: ['/bread.md'] } } });
  assert.deepEqual(removal.keep.map(row => [row.id, row.value]), [['record:chore:documents~%2Fbread.md', null]]);
});

test('the command refuses a deadline that has already passed before it reads its input, reported as not_started', () => {
  const run = spawnSync(process.execPath, [CLI, '--deadline-ms', '1'], { input: '{"op":"read"}', encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /outcome=not_started/);
});

test('the command refuses a deadline that is not an absolute millisecond integer', () => {
  const run = spawnSync(process.execPath, [CLI, '--deadline-ms', 'soon'], { input: '{"op":"read"}', encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /absolute Unix-millisecond integer/);
});

test('the command answers a read of the records on standard input, with no door', () => {
  const stored = { records: [{ id: 'list:chores', type: 'list', value: choresList([]) }, { id: 'record:chore:sweep', type: 'record:chore', value: { chore: 'sweep', minutes: 10 } }] };
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ op: 'read', names: NAMES, list: 'chores', stored }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).rows.map(row => row.id), ['sweep']);
});
