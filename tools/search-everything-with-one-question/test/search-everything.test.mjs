// The one search over the records and file names handed in: the fused merge, a lane not handed its input named
// unavailable, the type filter, a large list, the row's declared shape, and the row as the runner runs it: the function is
// called with its input only, so it reaches no store and runs no other tool. Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { searchEverything } from '../do-work/search-everything.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { packageFilesByRow } from '../../../test-helpers/tool-row-imports.mjs';
import { judgedTree, withEnv } from '../../../test-helpers/judged-tree.mjs';

const repo = resolve(import.meta.dirname, '../../..');

const RECORDS = [
  { id: 'c1', type: 'sample-contacts', value: { title: 'Sample contact', notes: 'met the merlinfalcon keeper' } },
  { id: 'i1', type: 'sample-invoices', value: { title: 'Sample invoice', notes: 'merlinfalcon feed, 3 bags' } },
  { id: 'p1', type: 'sample-places', value: { title: 'Sample place', notes: 'merlinfalcon aviary' } },
  { id: 'p2', type: 'sample-places', value: { title: 'Other place', notes: 'nothing here' } },
];
const FILES = { '/Notes/merlinfalcon care.txt': 'made-up care notes', '/Notes/other.txt': 'made up' };

const rowOf = id => rows.records.map(record => record.payload).find(payload => payload.id === id);

test('the lanes merge by reciprocal rank: each kind of record is its own lane, then the file whose name holds the word', async () => {
  const answer = await searchEverything({ question: 'merlinfalcon', records: RECORDS, files: FILES });
  assert.deepEqual(answer.unavailable, []);
  assert.deepEqual(answer.results.slice(0, 3).map(hit => hit.type).sort(), ['sample-contacts', 'sample-invoices', 'sample-places']);
  assert.deepEqual(answer.results.map(hit => hit.id).slice(3), ['file:/Notes/merlinfalcon care.txt']);
  const record = answer.results.find(hit => hit.record === 'c1');
  assert.deepEqual(record.found_in, ['written']);
  assert.equal(record.said, 'met the merlinfalcon keeper');
  assert.deepEqual(record.address, { id: 'c1', type: 'sample-contacts' }, 'the record is addressed by what opens it in the person\'s own store');
  const file = answer.results.find(hit => hit.path === '/Notes/merlinfalcon care.txt');
  assert.deepEqual(file.found_in, ['name']);
  assert.deepEqual(file.address, { path: '/Notes/merlinfalcon care.txt' });
  assert.ok(record.score > file.score, 'the records rank above a file name at weight 0.8');
});

test('a lane not handed its input is named unavailable, never guessed', async () => {
  const noFiles = await searchEverything({ question: 'merlinfalcon', records: RECORDS });
  assert.deepEqual(noFiles.unavailable, [{ lane: 'file-names', place: 'name', source: 'files', reason: 'no_files' }]);
  assert.ok(noFiles.results.every(hit => hit.source !== 'files'));
  const noRecords = await searchEverything({ question: 'merlinfalcon', files: FILES });
  assert.ok(noRecords.unavailable.some(item => item.lane === 'records' && item.reason === 'no_records'));
  assert.ok(noRecords.results.every(hit => hit.source === 'files'));
});

test('with a type only that kind is searched, and the file names are not asked', async () => {
  const answer = await searchEverything({ question: 'merlinfalcon', type: 'sample-places', records: RECORDS, files: FILES });
  assert.deepEqual(answer.unavailable, []);
  assert.deepEqual(answer.results.map(hit => hit.record), ['p1']);
  assert.deepEqual(answer.results[0].found_in, ['written']);
});

test('a search over 10,000 rows in three lists answers row 9731 first, in well under 2 seconds', async () => {
  const many = Array.from({ length: 10_000 }, (_, at) => ({ id: `r${at}`, type: ['list-a', 'list-b', 'list-c'][at % 3],
    value: { title: `row ${at}`, notes: at === 9731 ? 'kestrel nest by the dock' : `plain text ${at}` } }));
  const started = Date.now();
  const answer = await searchEverything({ question: 'kestrel', records: many });
  const elapsed = Date.now() - started;
  assert.equal(answer.results[0].record, 'r9731');
  assert.equal(answer.results.length, 1);
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
});

test('the rows declare the records and files they are handed, no store right, no door, and the sample input the runner test runs', () => {
  // What each row packs when it runs (its own entry program's reach, found by the tool-row walker), not the folder's uses_tools.
  const { env, ref } = judgedTree(repo);
  const reached = withEnv(env, () => packageFilesByRow({ repo, ref }));
  for (const id of ['tool:search-everything-with-one-question', 'tool:search-everything-in-a-small-container', 'tool:search-one-of-my-lists', 'tool:answer-the-search-page-route']) {
    const row = rowOf(id);
    assert.equal(row.stored, undefined, `${id} declares no store right`);
    assert.ok(row.input_schema.properties.records && row.input_schema.properties.files || id === 'tool:search-one-of-my-lists' && row.input_schema.properties.records, `${id} takes records`);
    assert.ok(!JSON.stringify(row).includes('"records:'), `${id} names no records method`);
    assert.ok(!JSON.stringify(row).includes('"stored"'), `${id} has no stored field`);
    // A row whose host runs the picture query encoder keeps that one ability (another tool's run); every other row runs
    // the plain function runner and is handed nothing but its input.
    const runs = row.invoke.records?.runs;
    if (runs) {
      assert.deepEqual(Object.keys(row.invoke.records).sort(), ['fd', 'runs'], `${id} is handed only the run of another tool`);
      assert.deepEqual(runs, ['tool:words-as-picture-vector'], `${id} may run only the picture query encoder`);
    } else {
      assert.equal(row.invoke.records, undefined, `${id} is handed no door`);
      assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs', `${id} runs the function runner`);
      assert.ok(row.invoke.files.package_files.every(files => files.package !== 'records-door'), `${id} does not pack the records door`);
      assert.ok(!(reached[id] ?? []).some(item => item.package === 'records-door'), `${id} does not reach the records door when it runs`);
    }
  }
  const sample = rowOf('tool:search-everything-with-one-question').verify.find(check => check.kind === 'sample-run');
  assert.deepEqual(sample.input.records.map(record => record.id), ['c1', 'i1', 'p1', 'p2']);
  assert.deepEqual(Object.keys(sample.input.files), ['/Notes/merlinfalcon care.txt', '/Notes/other.txt']);
});

test('no row, kit, port, doc or code of this folder names a records door operation, a door read or write, or a door address', () => {
  const folder = new URL('..', import.meta.url);
  const operation = /records:(read|write|list|search)\b|\bdoor\.(read|list|write|search)\b|values-door|own-records/;
  const named = readdirSync(folder, { recursive: true }).filter(name => /\.(json|md|mjs)$/.test(name) && !name.startsWith('test'))
    .filter(name => operation.test(readFileSync(new URL(name, folder), 'utf8')));
  assert.deepEqual(named, []);
});

test('the runner runs the row\'s function with the records and files in its input and answers the same hits', () => {
  const runner = new URL('../../workflows/do-work/run-a-function.mjs', import.meta.url).pathname;
  const file = new URL('../do-work/search-everything.mjs', import.meta.url).pathname;
  const ran = spawnSync(process.execPath, [runner, file, 'searchEverything'], {
    input: JSON.stringify({ question: 'merlinfalcon', records: RECORDS, files: FILES }), encoding: 'utf8',
  });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const { result } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result.results.map(hit => hit.id).slice(3), ['file:/Notes/merlinfalcon care.txt']);
  assert.deepEqual(result.unavailable, []);
});
