// The Formats page's routes (tool:answer-the-content-formats-page) run as the container runs them, against the fake
// records door with exactly the row's rights and made-up records and files: the saved list is one record, the sources
// are the person's own files and pursuits, and the answers are the old route's (old trillion test/content-formats.test.mjs,
// tag old-trillion-before-worker-retire: its route cases, here through the row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import starters from '../data/content-format-starters.json' with { type: 'json' };

const row = rowOf(rows, 'tool:answer-the-content-formats-page');
const route = (path, method = 'GET', body = {}) => ({ path, method, query: {}, body, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });
const starterCount = starters.formats.length + starters.writing_library.frameworks.length + starters.writing_library.templates.length;

test('an account that saved none reads every starter, and nothing is written by a read', async () => {
  const ran = await answerOf(row, route('/content-formats'));
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.status, 200);
  assert.equal(ran.result.body.formats.length, starterCount);
  assert.deepEqual(ran.result.body.example_kinds.map(kind => kind.id), ['own', 'customer', 'famous']);
  assert.deepEqual(ran.kept, []);
});

test('a save keeps the list as one record, a refused save leaves it as it was, and later reads answer from it', async () => {
  const saved = await answerOf(row, route('/content-formats', 'POST', { formats: [{ label: 'Kept', spec: 'Say it plainly.' }, { id: 'x_thread', removed: true }] }));
  assert.equal(saved.result.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.body.formats[0].label, 'Kept');
  assert.deepEqual(saved.result.body.removed_starters.map(one => one.id), ['x_thread']);
  assert.deepEqual(saved.kept, [{ id: 'content-formats', type: 'content-formats', value: { formats: [{ id: 'kept', label: 'Kept', spec: 'Say it plainly.', slots: [], tags: [] }, { id: 'x_thread', removed: true }] } }]);

  const refused = await answerOf(row, route('/content-formats', 'POST', { formats: [{ label: 'Kept', spec: 'x' }, { label: 'No shape' }] }), { records: saved.kept });
  assert.equal(refused.result.status, 400);
  assert.match(refused.result.body.error, /No shape: say how it goes/);
  assert.deepEqual(refused.kept, saved.kept);
  assert.equal(refused.calls.filter(call => call.method === 'records:write').length, 0);

  const read = await answerOf(row, route('/content-formats'), { records: saved.kept });
  assert.equal(read.result.body.formats[0].label, 'Kept');
  assert.ok(!read.result.body.formats.some(format => format.id === 'x_thread'));
});

test('the sources are the person\'s own recordings, notes and pursuits, and shape fills a format from the one named', async () => {
  const sample = {
    records: [{ id: 'pursuit:podcast', type: 'pursuit', value: { title: 'Launch the podcast', now: 'Recording episode one.', recorded_at: '2026-09-01T00:00:00Z' } }],
    door_files: {
      '/Recordings from the web/Walk transcript.txt': 'Made-up header\nWhat I said\nI learned this today. It changed how I work.',
      '/Notes/Ideas/A note.md': 'A sentence from the note.',
      '/Notes/skip.png': 'not words',
      '/Elsewhere/Other.md': 'Not a source kind.',
    },
  };
  const sources = await answerOf(row, route('/content-formats/sources'), sample);
  assert.equal(sources.status, 0, sources.error);
  assert.equal(sources.result.status, 200, JSON.stringify(sources.result));
  const listed = sources.result.body.sources;
  assert.deepEqual(listed.map(one => `${one.kind}:${one.title}`).sort(), ['note:A note.md', 'pursuit:Launch the podcast', 'recording:Walk']);
  const recording = listed.find(one => one.kind === 'recording');

  const shaped = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'recording', id: recording.id }, format_ids: ['x_thread'] }), sample);
  assert.equal(shaped.result.status, 200, JSON.stringify(shaped.result));
  assert.deepEqual(shaped.result.body.source, { kind: 'recording', label: 'recording', id: recording.id, title: 'Walk' });
  assert.equal(shaped.result.body.material, 'I learned this today.\nIt changed how I work.');
  assert.equal(shaped.result.body.scripts[0].lines[0].words, 'I learned this today.');
  assert.equal(shaped.result.body.before_writing.next_call.tool, 'find_workflow');

  const pursuit = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'pursuit', id: 'pursuit:podcast' }, format_ids: ['x_thread'] }), sample);
  assert.match(pursuit.result.body.material, /Recording episode one/);
  const outside = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'note', id: 'private-other-person' } }), sample);
  assert.equal(outside.result.status, 400);
  assert.match(outside.result.body.error, /not in this account/);
  assert.deepEqual(shaped.kept, sample.records, 'shaping changes nothing');
});

test('follow answers how far the words heard reach, and an unknown spelling or method is 404', async () => {
  const followed = await answerOf(row, route('/content-formats/follow', 'POST', { script: 'One two three four.', heard: 'one two' }));
  assert.equal(followed.result.status, 200);
  assert.equal(followed.result.body.said, 2);
  assert.equal(followed.result.body.total, 4);
  assert.equal((await answerOf(row, route('/content-formats/unknown'))).result.status, 404);
  assert.equal((await answerOf(row, route('/content-formats/sources', 'POST'))).result.status, 404);
});

test('the row reads and writes only the saved list, lists only pursuits and reads only the source kinds\' folders', () => {
  const folders = row.invoke.records.rights.filter(item => item.files).map(item => item.files);
  const kinds = rows.records.length && JSON.parse(JSON.stringify(row.invoke.records.rights.filter(item => item.kind)));
  assert.deepEqual(kinds, [{ kind: 'content-formats', id: 'content-formats', operations: ['records:read', 'records:write'] }, { kind: 'pursuit', operations: ['records:list'] }]);
  assert.deepEqual(folders, ['/Recordings from the web/', '/Recordings from iPhone/', '/Notes/', '/Notes from members/']);
  assert.equal(row.invoke.internet, false);
});
