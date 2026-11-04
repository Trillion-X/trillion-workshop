// Filmcraft handoff uses its real app job, mounted sources and current task readback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { editorHandoff, editIdOf, editorHandoffSettings } from '../src/editor-handoff.mjs';
import { filmcraftEditJob } from '../../media-composition/do-work/filmcraft-edit-job.mjs';
import { handleMediaEditor } from '../src/work-media-editor.mjs';
import accountTools from '../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json' with { type: 'json' };
const identity = n => `1f:${String(n).repeat(64)}`;
const FIRST = identity(1), SECOND = identity(2), PROJECT = identity('f');
const EDIT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const savedEdit = () => ({ title: 'Pottery & friends', captions: [], panels: { 'send-to-editor': { editor: 'premiere' } },
  edl: { encode: { width: 1920, height: 1080 }, spine: { segments: [
    { kind: 'clip', id: 'first', source: FIRST, in: 1.5, out: 4 },
    { kind: 'clip', id: 'second', source: SECOND, in: 0, out: 2 },
    { kind: 'clip', id: 'repeated', source: FIRST, in: 4, out: 5 },
  ] } } });
function account({ edit = savedEdit(), state = 'completed', names = true } = {}) {
  const facts = new Map(edit ? [[`media_edit:${EDIT_ID}`, edit]] : []), requests = [];
  const task = { task_id: 'task-filmcraft', tool_id: 'tool:run-an-app-job', state, output: { app: 'filmcraft', ok: true, files: [{ key: 'project', identity: PROJECT, name: 'Pottery & friends.fcproj', bytes: 100 }] } };
  const store = { readFact: key => facts.get(key), writeFact: (key, value) => facts.set(key, value),
    locate: async id => [FIRST, SECOND].includes(id) && names ? { identity: id, names: [id === FIRST ? '/Pottery/first.mp4' : '/Pottery/second.mov'], byte_length: 1000 } : id === identity(7) ? { identity: id, names: ['/edits/export.mp4'], media_type: 'video/mp4', byte_length: 1234 } : null,
    byName: async name => name === '/edits/export.mp4' ? { identity: identity(7), names: [name], media_type: 'video/mp4', byte_length: 1234 } : { identity: identity(8), names: [name], media_type: 'text/plain' },
    runJob: async input => { requests.push(input); return task; }, readJob: async id => id === task.task_id ? task : null,
  };
  return { handoff: editorHandoff(store, { now: () => new Date('2026-10-12T00:00:00Z') }), facts, requests, task };
}

test('a saved cut becomes one Filmcraft project job with references, trims, order and original edit intact', async () => {
  const edit = savedEdit(), before = structuredClone(edit), { handoff, requests } = account({ edit });
  const sent = await handoff.send({ edit: EDIT_ID, frame_rate: 25 }, { requestKey: 'outer-task' });
  assert.equal(sent.state, 'completed'); assert.equal(sent.file.identity, PROJECT); assert.equal(sent.editor, 'Filmcraft');
  assert.equal(sent.clips, 3); assert.equal(sent.seconds, 5.52);
  assert.deepEqual(edit, before, 'preparation never changes the saved edit');
  const request = requests[0];
  assert.equal(request.tool_id, 'tool:run-an-app-job'); assert.equal(request.request_key, 'filmcraft-edit:outer-task');
  const job = request.input;
  assert.equal(job.app, 'filmcraft'); assert.equal(job.files.outputs[0].name, 'Pottery & friends.fcproj');
  assert.deepEqual(job.files.inputs, [
    { key: 'source-0', identity: FIRST, access: 'namespace', name: '/Pottery/first.mp4', byte_length: 1000 },
    { key: 'source-1', identity: SECOND, access: 'namespace', name: '/Pottery/second.mov', byte_length: 1000 },
  ]);
  const imports=job.steps.filter(step => step.operation === 'command_run' && step.arguments?.id==='file.import');
  assert.equal(imports.length, 2, 'repeated sources import once');
  assert.deepEqual(imports.map(step=>step.arguments.params.paths), [[{input_file:'source-0'}],[{input_file:'source-1'}]]);
  assert.ok(imports.every(step=>step.expect.path==='answer.errors.length' && step.expect.is===0));
  assert.deepEqual(job.steps[0], { operation: 'command_batch', arguments: { steps: [
    { id: 'file.newProject', params: { name: edit.title } },
    { id: 'project.ingestSettings', params: { enabled: false } },
    { id: 'project.ingestSettings', params: {} },
  ], stop_on_error: true }, expect: { path: 'answer.results.2.result.enabled', is: false } });
  assert.deepEqual(job.steps.find(step => step.arguments?.id === 'file.newSequence').arguments.params, { name: 'Pottery & friends', width: 1920, height: 1080, fps: 25 });
  const cuts = job.steps.filter(step => step.arguments?.id === 'timeline.place').map(step => step.arguments.params);
  assert.deepEqual(cuts.map(cut => cut.item), [{ from_step: 1, path: 'answer.items.0' }, { from_step: 2, path: 'answer.items.0' }, { from_step: 1, path: 'answer.items.0' }]);
  assert.deepEqual(cuts.map(cut => cut.seconds), [0, 2.52, 4.52]);
  assert.equal(cuts[0].sourceIn, Math.round(38 / 25 * 254016000000));
  assert.equal(cuts[0].duration, Math.round(63 / 25 * 254016000000));
  assert.equal(job.steps.at(-1).arguments.id, 'file.saveAs');
  assert.doesNotMatch(JSON.stringify(job), /xml|Premiere|copy|Volumes/);
});

test('queued is followed by the exact saved task and cannot claim a project before it exists', async () => {
  const { handoff, task, requests } = account({ state: 'waiting-for-computer' });
  const first = await handoff.send({ edit: EDIT_ID }, { requestKey: 'same-press' });
  assert.equal(first.file, undefined); assert.equal(first.task_id, task.task_id);
  task.state = 'completed';
  assert.equal((await handoff.status(EDIT_ID)).file.identity, PROJECT);
  assert.equal(requests.length, 1, 'reading status never resends the edit');
  task.output.files = [];
  await assert.rejects(handoff.status(EDIT_ID), /save a project/);
  task.state = 'failed'; task.error = 'The Namespace mount is unavailable.';
  assert.deepEqual((await handoff.status(EDIT_ID)).said, task.error);
});
test('retired editors, unnamed clips and unsupported compositions stop before any app job', async () => {
  const cases = [
    { input: { editor: 'premiere' }, pattern: /Choose an editor/ },
    { names: false, pattern: /no name/ },
    { edit: null, pattern: /not saved/ },
    { edit: { ...savedEdit(), captions: [{ text: 'Keep this caption', start: 0, end: 1 }] }, pattern: /cannot yet preserve/ },
    { edit: { ...savedEdit(), edl: { ...savedEdit().edl, audio_graph: { music_bed: { artifact: SECOND } } } }, pattern: /cannot yet preserve/ },
    { edit: { ...savedEdit(), edl: { encode: { width: 1920, height: 1080 }, spine: { segments: [{ ...savedEdit().edl.spine.segments[0], speed: 2 }] } } }, pattern: /cannot yet preserve/ },
  ];
  for (const one of cases) {
    const { handoff, requests } = account(one);
    await assert.rejects(handoff.send({ edit: EDIT_ID, ...one.input }, { requestKey: 'refusal' }), one.pattern);
    assert.equal(requests.length, 0);
  }
  assert.throws(() => editIdOf('../x'), /Name the edit/);
  const { handoff, requests } = account();
  await assert.rejects(handoff.send({ edit: EDIT_ID }), /request key/); assert.equal(requests.length, 0);
});
test('an oversized or malformed composition is refused intact, never truncated', () => {
  const edl = savedEdit().edl;
  assert.throws(() => filmcraftEditJob({ edl: { ...edl, spine: { segments: Array.from({ length: 40 }, () => edl.spine.segments[0]) } } }), /larger than one/);
  assert.throws(() => filmcraftEditJob({ edl: { ...edl, spine: { segments: [{ ...edl.spine.segments[0], out: 1 }] } } }), /forward clip/);
  assert.throws(() => filmcraftEditJob({ edl: { ...edl, spine: { segments: [null] } } }), /forward clip/);
  assert.throws(() => filmcraftEditJob({ edl: { ...edl, spine: { segments: [{ ...edl.spine.segments[0], speed: 0 }] } } }), /cannot yet preserve/);
  assert.throws(() => filmcraftEditJob({ edl: { ...edl, spine: { segments: [{ ...edl.spine.segments[0], in: 40000, out: 40001 }] } } }), /too large for an exact/);
});

test('disabled ingest preserves the original clip capacity and operation bound', () => {
  const edit = savedEdit(), before = structuredClone(edit);
  const segments = Array.from({ length: 28 }, () => edit.edl.spine.segments[0]);
  const candidate = { ...edit, edl: { ...edit.edl, spine: { segments } } };
  const prepared = filmcraftEditJob(candidate);
  assert.equal(prepared.job.steps.length, 32);
  assert.equal(prepared.job.steps.filter(step => step.arguments?.id === 'timeline.place').length, 28);
  assert.throws(() => filmcraftEditJob({ ...candidate, edl: { ...candidate.edl,
    spine: { segments: [...segments, segments[0]] } } }), /larger than one/);
  assert.deepEqual(edit, before);
});
test('an exported video attaches to the original saved edit through the same account owner', async () => {
  const { handoff, facts } = account();
  const answer = await handoff.attachFinished({ edit: EDIT_ID, file: '/edits/export.mp4' });
  assert.equal(answer.finished.identity, identity(7));
  assert.deepEqual(facts.get(`media_edit_finished:${EDIT_ID}`), answer.finished);
  await assert.rejects(handoff.attachFinished({ edit: EDIT_ID, file: '/notes.txt' }), /must be a video/);
});
test('the tool descriptor and settings offer Filmcraft with queued-aware output and no caller mount path', () => {
  const tool = accountTools.records.find(row => row.payload.id === 'tool:send-edit-to-editor').payload;
  assert.deepEqual(tool.input_schema.properties.editor.enum, editorHandoffSettings.editors.map(row => row.id));
  assert.equal(tool.input_schema.properties.files_folder, undefined);
  assert.ok(tool.output_schema.required.includes('state')); assert.ok(!tool.output_schema.required.includes('file'));
});
test('page sends preserve a supplied press key, status reads are account scoped and cross-origin writes fail', async () => {
  const origin = 'https://app.gettrillion.ai', runs = [];
  const person = { fact: async () => null, editorHandoffStatus: async edit => ({ edit, task_id: 'task-filmcraft', state: 'waiting-for-computer' }),
    fetch: async () => Response.json({ error: 'the run is not asked of the store' }, { status: 500 }) };
  const runTool = async request => { runs.push(request); return { state: 'completed', output: { ok: true } }; };
  const ask = (path, init = {}) => handleMediaEditor(new Request(origin + path, init), { person, userId: 'u1', origin, url: new URL(origin + path), runTool });
  const post = from => ask('/work/api/media/send-to-editor', { method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify({ edit: EDIT_ID, editor: 'filmcraft', request_key: 'same-press' }) });
  assert.equal((await post('https://elsewhere.test')).status, 403);
  await post(origin); await post(origin);
  assert.equal(runs[0].request_key, runs[1].request_key); assert.equal(runs[0].input.request_key, undefined);
  assert.equal((await (await ask(`/work/api/media/send-to-editor?edit=${EDIT_ID}`)).json()).sent.edit, EDIT_ID);
});
