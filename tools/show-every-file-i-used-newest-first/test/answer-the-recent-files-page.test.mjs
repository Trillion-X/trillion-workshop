// The Recent screen's route (tool:answer-the-recent-files-page), with old trillion's test/recent-files-store.test.mjs
// (tag old-trillion-before-worker-retire) ported: a use is kept and read back for a file the person keeps, and a file
// they do not keep is refused in words. There it ran through the person store's route; here the row runs as the
// container runs it, against the fake records door with exactly its rights and a made-up file. The old test's second
// case checked the account-action rows tool:recent-files and tool:record-file-use, which are not this row's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { recentFilesOver } from '../do-work/answer-the-recent-files-page.mjs';

const row = rowOf(rows, 'tool:answer-the-recent-files-page');
const route = (method, body = {}, query = {}) => ({ path: '/recent-files', method, query, body, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });
const door_files = { '/Recordings/serve.mp4': 'made-up video bytes', '/Notes/plan.md': 'made-up note' };

test('a use is kept and read back for a file the person keeps, and a file they do not keep is refused', async () => {
  const empty = await answerOf(row, route('GET'), { door_files });
  assert.equal(empty.status, 0, empty.error);
  assert.deepEqual(empty.result, { status: 200, body: { items: [], next_before: null, said: 'No files used yet.' } });

  const kept = await answerOf(row, route('POST', { file: '/Recordings/serve.mp4', kind: 'watched' }), { door_files });
  assert.equal(kept.result.status, 200, JSON.stringify(kept.result));
  assert.equal(kept.result.body.recorded, true);
  assert.equal(kept.result.body.file.last_words, 'Watched');
  assert.equal(kept.result.body.file.title, 'serve.mp4');
  const identity = kept.result.body.file.identity;
  assert.deepEqual(kept.kept.map(record => [record.id, record.type, record.value.kind]), [[`recent-file-use:${identity}:watched`, 'recent-file-use', 'watched']]);

  const refused = await answerOf(row, route('POST', { file: '/Nowhere/else.mp4', kind: 'opened' }), { door_files, records: kept.kept });
  assert.deepEqual(refused.result, { status: 400, body: { error: '/Nowhere/else.mp4 is not in your files.' } });
  assert.deepEqual(refused.kept, kept.kept, 'a refused use keeps nothing');
  const badWord = await answerOf(row, route('POST', { file: '/Notes/plan.md', kind: 'Opened It' }), { door_files, records: kept.kept });
  assert.equal(badWord.result.status, 400);
  assert.match(badWord.result.body.error, /one short word/);

  const listed = await answerOf(row, route('GET', {}, { limit: '5' }), { door_files, records: kept.kept });
  assert.deepEqual(listed.result.body.items.map(item => [item.title, item.last_kind]), [['serve.mp4', 'watched']]);
  assert.equal(listed.result.body.said, '1 file used, newest first.');
});

test('a file used again is one row with each kind\'s newest time, paged newest first, and a file no longer kept drops out', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00Z') });
  const files = new Map([['/a.mp4', { identity: 'id-a', names: ['/a.mp4'] }], ['/b.md', { identity: 'id-b', names: ['/b.md'] }]]);
  const http = find => async (_path, _method, body) => { const found = find(body.name ?? body.identity); if (!found) throw Object.assign(new Error('Not found'), { status: 404 }); return found; };
  const person = recentFilesOver({ namespaceHttp: http(ref => files.get(ref) ?? [...files.values()].find(file => file.identity === ref) ?? null) });
  for (const [file, kind] of [['/a.mp4', 'opened'], ['/b.md', 'edited'], ['/a.mp4', 'watched']]) {
    t.mock.timers.tick(1000);
    await person.record({ file, kind });
  }
  const first = await person.recent({ limit: 1 });
  assert.deepEqual(first.items.map(item => [item.identity, item.last_kind, Object.keys(item.kinds).sort()]), [['id-a', 'watched', ['opened', 'watched']]]);
  assert.ok(first.next_before);
  assert.deepEqual((await person.recent({ limit: 1, before: first.next_before })).items.map(item => item.identity), ['id-b']);
  assert.equal(person.changes().length, 3, 'one record per file and kind');

  const later = recentFilesOver({ uses: person.changes().map(write => write.value), namespaceHttp: http(ref => (ref === 'id-b' ? files.get('/b.md') : null)) });
  assert.deepEqual((await later.recent({})).items.map(item => item.identity), ['id-b']);
  assert.deepEqual(later.changes(), [], 'reading changes nothing');
});

test('the row lists and writes only recent-file-use records and only finds files', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'recent-file-use', operations: ['records:list', 'records:write'] }, { files: '/', operations: ['find_file'] }]);
  assert.equal(row.invoke.internet, false);
});
