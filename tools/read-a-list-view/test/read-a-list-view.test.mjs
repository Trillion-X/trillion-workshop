// read-a-list-view on a made-up bakery's list of chores, its records handed in as `stored` and its documents read from a
// real folder: a refresh answers the records to write as keep rows (only what changed, the rows the source no longer has),
// a read is records only (no folder is touched), paged with no row lost or repeated, a view's rules decided by the rule
// filter and its sort, and the bounds a list keeps.
import test from 'node:test';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';
import data from '../read-data/list-view.json' with { type: 'json' };
import { NAMES, choresList, recipe, recipesFolder, storedOf, storeAfter } from './support/stored.mjs';

const { limits } = data;
const OWN = [['record:chore:sweep', 'record:chore', { chore: 'sweep the floor', minutes: 10 }],
  ['record:chore:mop', 'record:chore', { chore: 'mop', minutes: 20 }]];

/** A bakery: the list, a view by rules, its own two rows, and a recipes folder of four documents (or the given files). */
async function bakery({ sources, files, views = true, extra } = {}) {
  const folder = await recipesFolder(files ?? { 'bread.md': recipe('bread', 40), 'buns.md': recipe('buns', 25),
    'scones.md': recipe('scones', 15), 'tart.md': recipe('tart', 55) });
  const list = choresList(sources ?? [{ source: 'documents', of: '/', root: folder.root }], extra);
  const base = [['list:chores', 'list', list], ...OWN];
  if (views) {
    base.push(['list-view:quick', 'list-view', { list_id: 'chores', view: { rules: { kind: 'rule', field: 'minutes', operator: 'less_than', params: { value: 30 } }, sort: [{ field: 'minutes', direction: 'desc' }] } }]);
  }
  return { folder, records: () => base, stored: () => storedOf(base) };
}

/** Refreshes and then stores what the store would hold: the caller's write-back of the keep rows. */
async function refreshAndStore(b, input = {}) {
  const first = await refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), ...input }, {});
  return { answer: first, stored: { records: storeAfter(b.stored().records, first.keep) } };
}

test('a refresh answers each document as a keep row of the list, its id <source>~<its id> and its values whole', async () => {
  const b = await bakery();
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored() });
  assert.deepEqual(answer.sources, [{ source: 'documents', rows: 4, written: 4, removed: 0, unchanged: 0 }]);
  const bread = answer.keep.find(row => row.id === 'record:chore:documents~%2Fbread.md');
  assert.equal(bread.type, 'record:chore');
  assert.equal(bread.expected, null);
  assert.equal(bread.value['note.chore'], 'bake bread');
  assert.equal(bread.value['note.minutes'], 40);
  assert.equal(answer.keep.some(row => row.id === 'record:chore:sweep'), false, 'own rows are never touched by a refresh');
});

test('a read runs no tool and reads no folder: it pages the records it is handed, own rows and source rows, nothing lost or repeated', async () => {
  const b = await bakery();
  const { stored } = await refreshAndStore(b);
  const gone = ({ records: stored.records.map(record => record.id === 'list:chores'
    ? { ...record, value: choresList([{ source: 'documents', of: '/', root: '/no-such-folder-for-this-read' }]) } : record) });
  const seen = [];
  let after;
  do {
    const page = readListView({ list: 'chores', names: NAMES, stored: gone, limit: 3, after });
    seen.push(...page.rows.map(row => row.id));
    after = page.next ?? undefined;
  } while (after);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 6);
  assert.ok(seen.includes('sweep') && seen.includes('documents~%2Fbread.md'));
  const bread = readListView({ list: 'chores', names: NAMES, stored, limit: 50 }).rows.find(row => row.id === 'documents~%2Fbread.md');
  assert.equal(bread.source, 'documents');
  assert.equal(bread.record_id, 'record:chore:documents~%2Fbread.md');
});

test('a second refresh writes nothing that is unchanged, and removes the rows the folder no longer has', async () => {
  const b = await bakery();
  const { stored, answer } = await refreshAndStore(b);
  assert.equal(answer.keep.length, 4);
  const again = await refreshRowSources({ names: NAMES, list: 'chores', stored });
  assert.deepEqual(again.keep, []);
  assert.equal(again.sources[0].unchanged, 4);
});

test('a changed document is kept with the value the store held (expected), and a removed one is kept as a removal', async () => {
  const b = await bakery();
  const { stored } = await refreshAndStore(b);
  await b.folder.write('bread.md', recipe('bread', 45));
  rmSync(`${b.folder.root}/scones.md`);
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored });
  const bread = answer.keep.find(row => row.id === 'record:chore:documents~%2Fbread.md');
  assert.equal(bread.value['note.minutes'], 45);
  assert.equal(bread.expected.value['note.minutes'], 40);
  const scones = answer.keep.find(row => row.id === 'record:chore:documents~%2Fscones.md');
  assert.equal(scones.value, null);
  assert.equal(scones.expected.value['note.chore'], 'bake scones');
  assert.equal(answer.keep.length, 2);
});

test('a store that moved a record refuses the keep row that expected the old value', async () => {
  const b = await bakery();
  const { stored, answer } = await refreshAndStore(b);
  await b.folder.write('bread.md', recipe('bread', 45));
  const next = await refreshRowSources({ names: NAMES, list: 'chores', stored });
  const moved = { records: stored.records.map(record => record.id === 'record:chore:documents~%2Fbread.md'
    ? { ...record, value: { ...record.value, 'note.minutes': 99 } } : record) };
  assert.throws(() => storeAfter(moved.records, next.keep), error => error.code === 'expected_mismatch' && error.id === 'record:chore:documents~%2Fbread.md');
  assert.ok(answer.keep.length === 4);
});

test('a changed-path refresh reads only the named documents and leaves the others as they are', async () => {
  const b = await bakery();
  const { stored } = await refreshAndStore(b);
  await b.folder.write('bread.md', recipe('bread', 50));
  await b.folder.write('buns.md', recipe('buns', 99));
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored,
    changes: { documents: { paths: ['/bread.md'], removed: [] } } });
  assert.deepEqual(answer.keep.map(row => row.id), ['record:chore:documents~%2Fbread.md']);
  assert.equal(answer.keep[0].value['note.minutes'], 50);
});

test('a changes entry naming a source the refresh does not select, a traversal or an empty change is refused', async () => {
  const b = await bakery();
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), changes: { nope: { paths: ['/a.md'], removed: [] } } }), /changes can narrow/);
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), changes: { documents: { paths: ['/../a.md'], removed: [] } } }), /changes can narrow|distinct absolute paths/);
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), changes: { documents: { paths: [], removed: [] } } }), /distinct absolute paths/);
});

test('a scoped refresh settles only the selected sources and refuses an unknown source id', async () => {
  const b = await bakery();
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), source_ids: ['ghost'] }), /does not declare/);
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: b.stored(), source_ids: [] }), /nonempty array/);
});

test('a missing stored list of records is refused, never read as an empty store', async () => {
  const b = await bakery();
  assert.throws(() => readListView({ list: 'chores', names: NAMES }), error => error.code === 'bad_input');
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores' }), error => error.code === 'bad_input');
  await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored: { records: [{ id: 'x' }] } }), error => error.code === 'bad_input');
});

test('a view keeps the rows its rules keep, in its sort, and says how many rows it read', async () => {
  const b = await bakery();
  const { stored } = await refreshAndStore(b);
  const answer = readListView({ view: 'list-view:quick', names: NAMES, stored });
  assert.deepEqual(answer.rows.map(row => row.values.minutes), [20, 10]);
  assert.equal(answer.of, 6);
  assert.equal(answer.complete, true);
});

test('a view whose rules keep nothing answers no rows', async () => {
  const b = await bakery({ views: false });
  const { stored } = await refreshAndStore(b);
  const view = [['list-view:none', 'list-view', { list_id: 'chores', view: { rules: { kind: 'rule', field: 'minutes', operator: 'less_than', params: { value: 1 } } } }]];
  const answer = readListView({ view: 'list-view:none', names: NAMES, stored: { records: [...stored.records, ...storedOf(view).records] } });
  assert.deepEqual(answer.rows, []);
});

test('a page never gathers more rows than the reader bound, and keeps its cursor past it', async () => {
  const many = Object.fromEntries(Array.from({ length: limits.rows_per_read + 3 }, (_, i) => [`r${String(i).padStart(5, '0')}.md`, recipe(`chore ${i}`, i)]));
  const b = await bakery({ files: many, views: false });
  const { stored } = await refreshAndStore(b);
  const page = readListView({ list: 'chores', names: NAMES, stored, limit: 5000 });
  assert.equal(page.rows.length, limits.rows_per_read);
  assert.ok(page.next);
});

test('a read refuses a list with more row sources than the list may declare', async () => {
  const sources = Array.from({ length: limits.row_sources_per_list + 1 }, () => ({ source: 'documents', of: '/' }));
  const b = await bakery({ sources });
  assert.throws(() => readListView({ list: 'chores', names: NAMES, stored: b.stored() }), /at most/);
});

test('a source kind no tool serves is refused before any read', async () => {
  const b = await bakery({ sources: [{ source: 'namespace-documents', of: '/' }] });
  assert.throws(() => readListView({ list: 'chores', names: NAMES, stored: b.stored() }), error => error.code === 'bad_list');
});

test('a declared native address reads only its own prefix and keeps local ids, and refresh writes only that address', async () => {
  const b = await bakery({ views: false, extra: { row_records: { type: 'record:physical', prefix: 'account:library/' } } });
  const records = [...b.records(), ['account:library/sweep', 'record:physical', { chore: 'sweep', minutes: 1 }], ['record:chore:other', 'record:chore', { chore: 'x', minutes: 2 }]];
  const stored = storedOf(records);
  const page = readListView({ list: 'chores', names: NAMES, stored, limit: 10 });
  assert.deepEqual(page.rows.map(row => row.record_id), ['account:library/sweep']);
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored });
  assert.ok(answer.keep.every(row => row.type === 'record:physical' && row.id.startsWith('account:library/documents~')));
});

test('an invalid native address declaration fails visibly', async () => {
  const b = await bakery({ views: false, extra: { row_records: { type: 'record:physical', prefix: '' } } });
  assert.throws(() => readListView({ list: 'chores', names: NAMES, stored: b.stored() }), /row_records.prefix/);
});
