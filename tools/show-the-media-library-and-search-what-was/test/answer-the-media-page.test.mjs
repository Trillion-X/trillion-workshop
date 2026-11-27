// The Media page's saved edits (tool:answer-the-media-page), with old trillion's tests at tag
// old-trillion-before-worker-retire ported: test/work-media.test.mjs ("a saved edit is person-scoped": saved, read
// back with its clips and captions, each clip kept as edited on Recent; "unsupported methods do not reach Media
// owners") and test/native-browser-media.test.mjs ("edit persistence ... retain the existing validation": the saved edit
// keeps its clip). Their render, transcribe and next-edit halves need a Workshop run or the Namespace's owners, which
// this row cannot reach: those requests answer 503 with words, checked below. The row runs as the container runs it,
// with no door; the saved edit is handed in, and the checked edit and the clips it used are answered, never stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = rowOf(rows, 'tool:answer-the-media-page');
const route = (path, method = 'GET', body = {}, query = {}) => ({ path, method, query, body, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });
const FILE = `1f:${'a'.repeat(64)}`;
const clip = { identity: FILE, name: 'Opening', start: 2, end: 8, bytes: '/clip', media_type: 'video/mp4', look_stack: 'golden-hour' };
const caption = { id: 'caption-1', text: 'Opening words', start: 0, end: 3 };
const edit = { id: 'edit-1', title: 'Opening cut', ratio: '9:16', clips: [clip], captions: [caption], textOverlays: [{ ...caption, id: 'text-1' }],
  edl: { subtitles: { ass: 'timed captions' }, text_overlays: [{ text: 'Title', start: 0, end: 2 }], spine: { segments: [{ source: 'untrusted-source', in: 99, out: 100 }] } }, file: `1f:${'b'.repeat(64)}` };

test('a saved edit is answered with its clips and captions and stored nowhere, each clip kept as edited, and a read answers the edit handed in', async () => {
  const saved = await answerOf(row, route('/media/edit', 'POST', edit));
  assert.equal(saved.status, 0, saved.error);
  assert.equal(saved.result.status, 200);
  assert.deepEqual(saved.kept, [], 'nothing is stored by the run');
  assert.equal(saved.calls.filter(call => call.method.startsWith('records:')).length, 0);
  const value = saved.result.body.edit;
  assert.equal(value.id, edit.id);
  assert.deepEqual([value.title, value.ratio, value.file], [edit.title, edit.ratio, edit.file]);
  assert.deepEqual(value.edl, edit.edl);
  assert.equal(typeof value.saved_at, 'string');
  assert.deepEqual(saved.result.file_uses, [{ file: FILE, kind: 'edited' }], 'the clip is answered as edited, for the caller to keep on Recent');

  const read = await answerOf(row, { ...route('/media/edit', 'GET', {}, { id: 'edit-1' }), edit: value });
  assert.equal(read.result.status, 200);
  assert.equal(read.result.body.edit.clips[0].start, 2);
  assert.deepEqual(read.result.body.edit.captions, [caption]);
  assert.deepEqual((await answerOf(row, route('/media/edit', 'GET', {}, { id: 'never-saved' }))).result, { status: 200, body: { edit: null } });
});

test('the edit is checked as the old route checked it, and a refused edit keeps nothing', async () => {
  const noClips = await answerOf(row, route('/media/edit', 'POST', { ...edit, clips: [] }));
  assert.deepEqual(noClips.result, { status: 400, body: { error: 'The edit needs clips with a source and valid start and end times.' } });
  assert.deepEqual(noClips.kept, []);
  assert.deepEqual((await answerOf(row, route('/media/edit', 'GET', {}, { id: '../x' }))).result, { status: 400, body: { error: 'Choose an edit.' } });
});

test('what needs a shared project, a Workshop run or the Namespace\'s owners answers 503 with words, never a made-up answer', async () => {
  const shared = await answerOf(row, route('/media/edit', 'GET', {}, { id: 'edit-1', space_id: 'membership-1' }));
  assert.equal(shared.result.status, 503);
  assert.match(shared.result.body.error, /shared project .* is not reachable/);
  const library = await answerOf(row, route('/media/library', 'GET', {}, { limit: '60', stored: 'true' }));
  assert.deepEqual(library.result, { status: 503, body: { error: 'The Media library is not reachable from this page\'s route tool yet.' } });
  // A render cannot start a Workshop run from here, so the old handler's own refusal of a run that did not start answers;
  // the old handler kept the clips as edited before starting it, and so are they answered here.
  const render = await answerOf(row, route('/media/render', 'POST', edit));
  assert.deepEqual(render.result, { status: 400, body: { error: 'That could not be started. Try again.' }, file_uses: [{ file: FILE, kind: 'edited' }] });
  assert.equal((await answerOf(row, route('/media/next-edit'))).result.status, 503);
});

test('the row opens no door: the file uses it answers are the caller\'s to record', async () => {
  assert.equal(row.invoke.records, undefined);
  assert.equal(row.invoke.may_reach, undefined);
  assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.ok(!row.invoke.files.package_files.some(spec => spec.package === 'records-door'));
  const kept = await answerOf(row, route('/recent-files', 'POST', { file: FILE, kind: 'viewed' }));
  assert.deepEqual(kept.result, { status: 200, body: { file: FILE, answered_for_the_caller: true }, file_uses: [{ file: FILE, kind: 'viewed' }] });
  assert.equal((await answerOf(row, route('/recent-files'))).result.status, 503, 'reading Recent is not reachable from this run');
});
