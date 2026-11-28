// test/ask-by-database.test.mjs
//
// The page's ask over one kept session per database (read-data/ask-by-database.ts): the list of pursuits comes from the
// pages database's session with each pursuit's database; each chosen pursuit's data is asked of its own database's session
// (start input dbs = that one database); the answers join into one shape; a database that fails is named in `unread` and
// the others are still drawn; every one failing refuses the ask with its words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askByDatabase, joinAnswers } from '../read-data/ask-by-database.ts';

const status = (name, place) => ({ name, mark: 'done', tone: null, counts_as_done: false, closed: false, place });
const answers = {
  runs_it: { tasks: [{ id: 'a', title: 'A', parent: null, status: 'Done' }], statuses: [status('Done', 1), status('To do', 2)], shows: [], facts: [], fact_kinds: [{ name: 'said', label: 'Said', place: 1, tone: null }],
    changes: [{ task: 'a', at: '2026-11-19T20:00:00Z', kind: 'made', status: 'Done' }] },
  garden_it: { tasks: [{ id: 'e', title: 'E', parent: null, status: 'To do' }], statuses: [status('Done', 1)], shows: [], facts: [], fact_kinds: [{ name: 'said', label: 'Said', place: 1, tone: null }],
    changes: [{ task: 'e', at: '2026-11-19T19:00:00Z', kind: 'made', status: 'To do' }] },
};
const pursuits = [{ id: 'bakery', label: 'Bakery', database: 'runs_it', tables: { changes: 'task_changes_kept' } }, { id: 'garden', label: 'Garden', database: 'garden_it', tables: {} }, { id: 'other', label: 'Other', database: 'not_asked', tables: {} }];

function session(fail = []) {
  const calls = [];
  const call = async (name, args, input) => {
    calls.push({ name, args, input });
    assert.equal(input.dbs.length, 1, 'a session holds one database, so one place');
    assert.deepEqual(args.dbs, input.dbs);
    if (name === 'data') assert.ok(args.pursuits.every(one => one.database === input.dbs[0].database), 'a session is asked only for its own database');
    const database = input.dbs[0].database;
    if (name === 'pursuits') return { items: pursuits };
    if (fail.includes(database)) throw new Error(`${database} refused`);
    return answers[database];
  };
  return { call, calls };
}
const dbs = ['runs_it', 'garden_it'];

test('pursuits are asked of the pages database alone and name their databases; one not asked for is left out', async () => {
  const { call, calls } = session();
  const ask = askByDatabase({ call, dbs, pagesDatabase: 'runs_it' });
  assert.deepEqual(JSON.parse(await ask('pursuits')).map(one => one.id), ['bakery', 'garden']);
  assert.deepEqual(calls.map(one => [one.name, one.input.dbs[0].database]), [['pursuits', 'runs_it']]);
});

test('two pursuits in two databases join into one shape, each asked of its own database', async () => {
  const { call, calls } = session();
  const joined = JSON.parse(await askByDatabase({ call, dbs, pagesDatabase: 'runs_it' })('data?p=bakery,garden'));
  assert.deepEqual(joined.tasks.map(task => task.id), ['a', 'e']);
  assert.deepEqual(joined.changes.map(change => change.task), ['e', 'a'], 'changes in time order');
  assert.deepEqual(joined.statuses.map(one => one.name), ['Done', 'To do'], 'each status once');
  assert.deepEqual(joined.fact_kinds.map(one => one.name), ['said']);
  assert.equal(joined.unread, undefined);
  const asked = calls.filter(one => one.name === 'data');
  assert.deepEqual(asked.map(one => [one.input.dbs[0].database, one.args.pursuits]), [
    ['runs_it', [{ id: 'bakery', database: 'runs_it', tables: { changes: 'task_changes_kept' } }]], ['garden_it', [{ id: 'garden', database: 'garden_it', tables: {} }]]]);
});

test('one database failing leaves the other drawn and names the failed pursuit with its own words', async () => {
  const { call } = session(['garden_it']);
  const joined = JSON.parse(await askByDatabase({ call, dbs, pagesDatabase: 'runs_it' })('data?p=bakery,garden'));
  assert.deepEqual(joined.tasks.map(task => task.id), ['a']);
  assert.deepEqual(joined.unread, [{ ids: ['garden'], label: 'Garden', error: 'garden_it refused' }]);
});

test('every database failing refuses the ask with their words; no pursuit chosen draws an empty page', async () => {
  const { call } = session(dbs);
  await assert.rejects(askByDatabase({ call, dbs, pagesDatabase: 'runs_it' })('data?p=bakery,garden'), /Bakery: runs_it refused; Garden: garden_it refused/);
  const none = JSON.parse(await askByDatabase({ call: session().call, dbs, pagesDatabase: 'runs_it' })('data?p='));
  assert.deepEqual([none.tasks, none.changes], [[], []]);
});

test('joinAnswers of nothing is the empty shape', () => {
  assert.deepEqual(joinAnswers([]), { tasks: [], statuses: [], shows: [], changes: [], facts: [], fact_kinds: [] });
});

test('a session that answers nothing is a failure with words, never a read of null', async () => {
  const silent = async () => null;
  await assert.rejects(askByDatabase({ call: silent, dbs, pagesDatabase: 'runs_it' })('pursuits'), /answered no pursuits/);
  const { call } = session();
  const half = async (name, args, input) => (name === 'data' && input.dbs[0].database === 'garden_it' ? null : call(name, args, input));
  const joined = JSON.parse(await askByDatabase({ call: half, dbs, pagesDatabase: 'runs_it' })('data?p=bakery,garden'));
  assert.deepEqual(joined.unread, [{ ids: ['garden'], label: 'Garden', error: 'the session answered nothing' }]);
  assert.deepEqual(joined.tasks.map(task => task.id), ['a']);
});
