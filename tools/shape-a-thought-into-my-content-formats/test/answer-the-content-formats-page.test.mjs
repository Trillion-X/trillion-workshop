// The Formats page's routes (tool:answer-the-content-formats-page) run as the container runs them, with made-up files
// handed in: the saved list, the pursuits and the files (stored.files) are handed in, the sources are those files and
// pursuits, nothing is written, and the answers are the old route's (old trillion test/content-formats.test.mjs,
// tag old-trillion-before-worker-retire: its route cases, here through the row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import starters from '../data/content-format-starters.json' with { type: 'json' };

const row = rowOf(rows, 'tool:answer-the-content-formats-page');
const route = (path, method = 'GET', body = {}, more = {}) => ({ path, method, query: {}, body, ...more, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });
const starterCount = starters.formats.length + starters.writing_library.frameworks.length + starters.writing_library.templates.length;

test('an account that saved none reads every starter, and nothing is written by a read', async () => {
  const ran = await answerOf(row, route('/content-formats'));
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.status, 200);
  assert.equal(ran.result.body.formats.length, starterCount);
  assert.deepEqual(ran.result.body.example_kinds.map(kind => kind.id), ['own', 'customer', 'famous']);
  assert.deepEqual(ran.kept, []);
});

test('a save answers the list it checked and writes nothing, a refused list is 400, and reads answer from the saved list handed in', async () => {
  const saved = await answerOf(row, route('/content-formats', 'POST', { formats: [{ label: 'Kept', spec: 'Say it plainly.' }, { id: 'x_thread', removed: true }] }));
  assert.equal(saved.result.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.body.formats[0].label, 'Kept');
  assert.deepEqual(saved.result.body.removed_starters.map(one => one.id), ['x_thread']);
  const kept = [{ id: 'kept', label: 'Kept', spec: 'Say it plainly.', slots: [], tags: [] }, { id: 'x_thread', removed: true }];
  assert.deepEqual(saved.kept, [], 'nothing is stored by the run');
  assert.equal(saved.keep, undefined);

  const refused = await answerOf(row, route('/content-formats', 'POST', { formats: [{ label: 'Kept', spec: 'x' }, { label: 'No shape' }] }, { saved: kept }));
  assert.equal(refused.result.status, 400);
  assert.match(refused.result.body.error, /No shape: say how it goes/);
  assert.deepEqual(refused.kept, []);

  const read = await answerOf(row, route('/content-formats', 'GET', {}, { saved: kept }));
  assert.equal(read.result.body.formats[0].label, 'Kept');
  assert.ok(!read.result.body.formats.some(format => format.id === 'x_thread'));
});

test('the sources are the person\'s own recordings, notes and pursuits, and shape fills a format from the one named', async () => {
  const pursuits = [{ id: 'pursuit:podcast', title: 'Launch the podcast', now: 'Recording episode one.', recorded_at: '2026-09-01T00:00:00Z' }];
  const stored = {
    files: {
      '/Recordings from the web/Walk transcript.txt': 'Made-up header\nWhat I said\nI learned this today. It changed how I work.',
      '/Notes/Ideas/A note.md': { base64: Buffer.from('A sentence from the note.').toString('base64') },
      '/Notes/skip.png': 'not words',
      '/Elsewhere/Other.md': 'Not a source kind.',
    },
  };
  const sources = await answerOf(row, route('/content-formats/sources', 'GET', {}, { pursuits, stored }));
  assert.equal(sources.status, 0, sources.error);
  assert.equal(sources.result.status, 200, JSON.stringify(sources.result));
  const listed = sources.result.body.sources;
  assert.deepEqual(listed.map(one => `${one.kind}:${one.title}`).sort(), ['note:A note.md', 'pursuit:Launch the podcast', 'recording:Walk']);
  const recording = listed.find(one => one.kind === 'recording');

  const shaped = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'recording', id: recording.id }, format_ids: ['x_thread'] }, { pursuits, stored }));
  assert.equal(shaped.result.status, 200, JSON.stringify(shaped.result));
  assert.deepEqual(shaped.result.body.source, { kind: 'recording', label: 'recording', id: recording.id, title: 'Walk' });
  assert.equal(shaped.result.body.material, 'I learned this today.\nIt changed how I work.');
  assert.equal(shaped.result.body.scripts[0].lines[0].words, 'I learned this today.');
  assert.equal(shaped.result.body.before_writing.next_call.tool, 'find_workflow');

  const pursuit = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'pursuit', id: 'pursuit:podcast' }, format_ids: ['x_thread'] }, { pursuits, stored }));
  assert.match(pursuit.result.body.material, /Recording episode one/);
  const outside = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'note', id: 'private-other-person' } }, { pursuits, stored }));
  assert.equal(outside.result.status, 400);
  assert.match(outside.result.body.error, /not in this account/);
  assert.deepEqual(shaped.kept, [], 'shaping changes nothing');

  const notHanded = await answerOf(row, route('/content-formats/sources', 'GET', {}, { pursuits }));
  assert.deepEqual(notHanded.result.body.sources.map(one => one.kind), ['pursuit'], 'a file not handed in is not a source');
  const unread = await answerOf(row, route('/content-formats/shape', 'POST', { source: { kind: 'recording', id: recording.id } }, { pursuits }));
  assert.equal(unread.result.status, 400);
  assert.match(unread.result.body.error, /not in this account/);
});

test('follow answers how far the words heard reach, and an unknown spelling or method is 404', async () => {
  const followed = await answerOf(row, route('/content-formats/follow', 'POST', { script: 'One two three four.', heard: 'one two' }));
  assert.equal(followed.result.status, 200);
  assert.equal(followed.result.body.said, 2);
  assert.equal(followed.result.body.total, 4);
  assert.equal((await answerOf(row, route('/content-formats/unknown'))).result.status, 404);
  assert.equal((await answerOf(row, route('/content-formats/sources', 'POST'))).result.status, 404);
});

test('the row runs the function runner, reaches no door and mounts no records door', () => {
  assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.equal(row.invoke.records, undefined);
  assert.equal(row.stored, undefined);
  assert.ok(!row.invoke.files.package_files.some(item => item.package === 'records-door'));
  assert.ok(!row.uses_tools.includes('trillion-workshop/records-door'));
  assert.equal(row.invoke.may_reach, undefined);
});
