// The rows and their functions against the stand-in records door (tools/records-door/test/fake-door.mjs), with the
// made-up classifier program (test/made_up_worker.py) in place of a model, and the Python tests (test/test_*.py: the
// MLX forward, the classifier program, the whole program on a made-up model). Every input is made up. A run's inputs
// are read as rows and everything it keeps is written as rows, so a second door client, standing for another computer,
// reads and cancels it. The parts that need mlx, tokenizers or blake3 skip and say why; agreement with the decider's
// own PyTorch code (agree_with_reference.py) and the 303 x 132 wall time (benchmark.py) are run by hand on a Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import * as B from '../read-data/bulk-answer.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const file = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8'));
const rows = file.records.map(record => record.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasModules = names => python.status === 0 && spawnSync('python3', ['-c', names.map(name => `import ${name}`).join('; ')]).status === 0;

// ---- made-up rows

const MODEL = { id: 'record:classifier-model:made-up', type: 'record:classifier-model' };
const QUESTIONS = { id: 'record:question-set:made-up', type: 'record:question-set' };
const SETTINGS = { id: 'record:setting:bulk-answer~made-up', type: 'record:setting' };
const STATES = { type: 'record:line', prefix: 'record:line:made-up~', field: 'text' };
const INPUT = { model: MODEL, questions: QUESTIONS, settings: SETTINGS, states: STATES };

function seed({ count = 7, settings = {}, modelFolder }) {
  return [
    { ...MODEL, value: { classifier: 'made-up', weights: { folder: modelFolder } } },
    { ...QUESTIONS, value: { questions: { warm: { type: 'noul', instructions: 'Is the lamp warm?' }, late: { type: 'noul', instructions: 'Is the parcel late?' } } } },
    { ...SETTINGS, value: { layout: 'independent', dtype: 'float32', tokens_per_batch: 4096, max_state_tokens: 512, page_bytes: 300, ...settings } },
    ...Array.from({ length: count }, (_, i) => ({ id: `${STATES.prefix}${String(i).padStart(3, '0')}`, type: STATES.type, value: { text: `Made-up line ${i}.` } })),
    { id: 'record:line:other~000', type: STATES.type, value: { text: 'Not under the prefix.' } },
  ];
}

// Every right the four rows ask for, on the made-up kinds: one door, as the person's records are one.
const RIGHTS = [
  ...[MODEL, QUESTIONS, SETTINGS].map(row => ({ kind: row.type, id: row.id, operations: ['records:read'] })),
  { kind: STATES.type, prefix: STATES.prefix, operations: ['records:list'] },
  ...[B.RUN, B.PAGE, B.CANCEL].map(kind => ({ kind, prefix: `${kind}:`, operations: ['records:read', 'records:write'] })),
];

const madeUp = (action, request) => B.startWorker(action, request, { worker: join(here, 'made_up_worker.py') });

async function withDoor(records, fn) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  // Two clients of one door: the Mac that runs, and any other computer that reads and cancels.
  try { return await fn({ mac: openRecordsDoor({ descriptor: fake.descriptor }), elsewhere: openRecordsDoor({ descriptor: fake.descriptor }), fake }); }
  finally { await fake.close(); }
}

async function everyAnswer(door, jobId) {
  const first = await B.readABulkAnswerRun({ job_id: jobId }, { door });
  const answers = [];
  for (let page = first.pages ? 0 : null; page !== null;) {
    const got = await B.readABulkAnswerRun({ job_id: jobId, page }, { door });
    answers.push(...got.page.answers);
    page = got.page.next_page;
  }
  return { first, answers };
}

const skipPython = python.status === 0 ? false : 'needs python3';
let modelFolder;
test.before(() => { modelFolder = mkdtempSync(join(tmpdir(), 'made-up-model-')); });
test.after(() => rmSync(modelFolder, { recursive: true, force: true }));

// ---- the rows

test('the classifier runs on the person\'s Mac, and its run is read and cancelled from any computer', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states',
    'tool:read-a-bulk-answer-run', 'tool:cancel-a-bulk-answer-run']);
  const exports = rows.map(row => row.invoke.argv.at(-1));
  assert.deepEqual(exports, ['getAClassifierReady', 'answerManyStates', 'readABulkAnswerRun', 'cancelABulkAnswerRun']);
  for (const [i, row] of rows.entries()) {
    assert.equal(typeof B[exports[i]], 'function', exports[i]);
    assert.equal(row.invoke.argv[1], '/opt/records-door/do-work/run-an-export.mjs');
    assert.equal(row.invoke.records.fd, 3);
    assert.ok(!JSON.stringify(row).includes('jobs_folder'), `${row.id} names no folder of runs`);
  }
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.ok(row.invoke.files.package_files[0].paths.includes('do-work'), `${row.id} packs the classifier program`);
  }
  for (const row of rows.slice(2)) {
    assert.equal(row.invoke.kind, 'container');
    assert.deepEqual(row.placements, ['placement:small-container']);
  }
  assert.equal(rows[1].invoke.max_run_ms, B.LONGEST_RUN_MS);
  // The inputs are the person's rows, by record id: each read right is that one row, the states one prefix.
  const rights = rows[1].invoke.records.rights;
  for (const field of ['model', 'questions', 'settings']) {
    assert.ok(rights.some(r => r.kind?.fill?.field === `${field}.type` && r.id?.fill?.field === `${field}.id` && r.operations.join() === 'records:read'), field);
  }
  assert.ok(rights.some(r => r.kind?.fill?.field === 'states.type' && r.prefix?.fill?.field === 'states.prefix' && r.operations.join() === 'records:list'));
  assert.deepEqual(rows[0].record_model.kinds.map(kind => kind.type), [B.RUN, B.PAGE, B.CANCEL, B.READY]);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['do-work/answer_many_states.py', 'do-work/questions_first/engine.py', 'do-work/questions_first/backbone.py', 'read-data/bulk-answer.mjs']) {
    assert.doesNotMatch(readFileSync(join(folder, name), 'utf8'), /decider-2b|Mapika/, name);
  }
});

// ---- a run kept as rows

test('a run reads its inputs as rows and writes its status and every answer as bounded pages', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, elsewhere, fake }) => {
    const before = readdirSync(folder, { recursive: true }).sort();
    const done = await B.answerManyStates(INPUT, { door: mac }, { start: madeUp });
    assert.equal(done.status, 'finished');
    assert.deepEqual([done.states_done, done.states], [7, 7]);
    assert.ok(done.pages > 1, 'the answers are cut into pages');
    const { first, answers } = await everyAnswer(elsewhere, done.job_id);
    assert.deepEqual([first.status, first.states_done, first.pages, first.classifier_answers_as], ['finished', 7, done.pages, 'made-up']);
    assert.deepEqual(answers.map(a => a.state), seed({ modelFolder }).filter(r => r.id.startsWith(STATES.prefix)).map(r => r.id));
    assert.deepEqual(answers[3].answers.warm, { type: 'noul', noul: 0.253 });
    for (const [id, record] of fake.kept) {
      if (record.type !== B.PAGE) continue;
      assert.ok(Buffer.byteLength(JSON.stringify(record.value.answers)) <= 300 + record.value.answers.length, `${id} holds at most page_bytes of answers`);
    }
    // Every write the run sent was a write of its own kinds, each with a key of its own.
    const writes = fake.calls.filter(call => call.method === 'records:write');
    assert.ok(writes.every(call => call.input.records.every(r => [B.RUN, B.PAGE, B.CANCEL].includes(r.type))));
    assert.equal(new Set(writes.map(call => call.key)).size, writes.length);
    assert.deepEqual(readdirSync(folder, { recursive: true }).sort(), before, 'the run left no file in the tool\'s folder');
  });
});

test('the same rows name the same run; other rows name another', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, fake }) => {
    const a = await B.answerManyStates(INPUT, { door: mac }, { start: madeUp });
    const b = await B.answerManyStates(INPUT, { door: mac }, { start: () => assert.fail('a finished run is not run again') });
    assert.equal(b.job_id, a.job_id);
    assert.equal(b.already, true);
    fake.kept.set(`${STATES.prefix}999`, { id: `${STATES.prefix}999`, type: STATES.type, value: { text: 'Another line.' } });
    const c = await B.answerManyStates(INPUT, { door: mac }, { start: madeUp });
    assert.notEqual(c.job_id, a.job_id);
    assert.equal(c.states, 8);
  });
});

test('another computer cancels a run; the states it answered keep their pages', { skip: skipPython }, async () => {
  await withDoor(seed({ count: 20, settings: { made_up_seconds: 0.2 } , modelFolder }), async ({ mac, elsewhere }) => {
    const { jobId } = await B.readInputs(INPUT, elsewhere);
    const running = B.answerManyStates(INPUT, { door: mac }, { start: madeUp, pollMs: 50 });
    let seen = null;
    for (let i = 0; i < 200 && !seen?.states_done; i++) {
      await new Promise(done => setTimeout(done, 25));
      seen = await elsewhere.read(B.RUN, B.runId(jobId.slice(3)));
    }
    assert.equal(seen?.status, 'running', 'the run row is written while the run goes on');
    const asked = await B.cancelABulkAnswerRun({ job_id: jobId }, { door: elsewhere });
    assert.equal(asked.status, 'cancelling');
    const done = await running;
    assert.equal(done.status, 'cancelled');
    assert.ok(done.states_done > 0 && done.states_done < 20, `${done.states_done} of 20 answered`);
    const { first, answers } = await everyAnswer(elsewhere, jobId);
    assert.equal(first.status, 'cancelled');
    assert.equal(answers.length, done.states_done);
    assert.equal((await B.cancelABulkAnswerRun({ job_id: jobId }, { door: elsewhere })).status, 'cancelled');
  });
});

test('a run whose row stopped being written reads as failed, may be cancelled, and starts again', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, elsewhere, fake }) => {
    const { jobId } = await B.readInputs(INPUT, mac);
    const hex = jobId.slice(3);
    const stale = { job_id: jobId, attempt: 'crashed', status: 'running', states_done: 2, states: 7, pages: 1,
      started_at: '2026-11-06T00:00:00.000Z', updated_at: '2026-11-06T00:00:00.000Z', longest_until: '2026-11-06T04:00:00.000Z' };
    fake.kept.set(B.runId(hex), { id: B.runId(hex), type: B.RUN, value: stale });
    const now = () => Date.parse('2026-11-06T00:10:00.000Z');
    const read = await B.readABulkAnswerRun({ job_id: jobId }, { door: elsewhere }, { now });
    assert.equal(read.status, 'failed');
    assert.match(read.error, /start it again/);
    assert.equal((await B.cancelABulkAnswerRun({ job_id: jobId }, { door: elsewhere }, { now })).status, 'cancelled');
    fake.kept.set(B.runId(hex), { id: B.runId(hex), type: B.RUN, value: stale });
    const again = await B.answerManyStates(INPUT, { door: mac }, { start: madeUp, now });
    assert.equal(again.status, 'finished');
    assert.notEqual(fake.kept.get(B.runId(hex)).value.attempt, 'crashed');
  });
});

test('what is wrong with the rows is named before anything is written', { skip: skipPython }, async () => {
  const refused = async (records, input, words) => withDoor(records, async ({ mac, fake }) => {
    await assert.rejects(B.answerManyStates(input, { door: mac }, { start: madeUp }), words);
    assert.equal(fake.calls.filter(call => call.method === 'records:write').length, 0);
  });
  const rowsNow = seed({ modelFolder });
  await refused(rowsNow.slice(1), INPUT, /the model row record:classifier-model:made-up .* is not in the person's records/);
  await refused(rowsNow.map(r => (r.id === QUESTIONS.id ? { ...r, value: { warm: {} } } : r)), INPUT, /holds no `questions` map/);
  await refused(seed({ settings: { page_bytes: 56_001 }, modelFolder }), INPUT, /from 1 to 56000/);
  await refused(rowsNow, { ...INPUT, states: { ...STATES, prefix: `${STATES.prefix}nothing~` } }, /no record:line rows start with/);
  await refused(rowsNow, { ...INPUT, states: { ...STATES, field: 'words' } }, /has no `words`/);
  await refused(rowsNow, { ...INPUT, model: 'record:classifier-model:made-up' }, /`model` is the row to read, as \{ type, id \}/);
  await refused(rowsNow.map(r => (r.id === MODEL.id ? { ...r, value: { ...r.value, classifier: 'nope' } } : r)), INPUT, /classifier families/);
  await withDoor(rowsNow, async ({ elsewhere }) => {
    await assert.rejects(B.readABulkAnswerRun({ job_id: 'abc' }, { door: elsewhere }), /1f:<64 hex>/);
    await assert.rejects(B.readABulkAnswerRun({ job_id: `1f:${'b'.repeat(64)}` }, { door: elsewhere }), /no run/);
    await assert.rejects(B.cancelABulkAnswerRun({ job_id: `1f:${'b'.repeat(64)}` }, { door: elsewhere }), /no run/);
  });
});

test('get-ready keeps the naming of the weights as a row beside the model row', { skip: hasModules(['blake3']) ? false : 'needs python3 with blake3' }, async () => {
  const fake = await startFakeDoor({ rights: [{ kind: MODEL.type, id: MODEL.id, operations: ['records:read'] }, { kind: B.READY, prefix: `${B.READY}:`, operations: ['records:write'] }],
    records: seed({ modelFolder }) });
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(modelFolder, 'config.json'), '{"model_type": "made-up"}');
    const ready = await B.getAClassifierReady({ model: MODEL }, { door: openRecordsDoor({ descriptor: fake.descriptor }) }, { start: madeUp });
    assert.equal(ready.ready, true);
    assert.match(ready.identity, /^1f:[0-9a-f]{64}$/);
    const kept = fake.kept.get(ready.record.id);
    assert.equal(kept.type, B.READY);
    assert.deepEqual(kept.value.model, MODEL);
    assert.deepEqual(kept.value.files.map(f => f.name), ['config.json']);
  } finally { await fake.close(); }
});

// ---- the Python tests, and the whole row on a made-up model

test('the Python tests of answer-questions-about-many-states pass', { skip: skipPython, timeout: 900000 }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

test('the start row, run as the engine runs it, answers a made-up model\'s states into rows that the read row reads',
  { skip: hasModules(['mlx.core', 'tokenizers', 'blake3']) ? false : 'needs mlx, tokenizers and blake3 (the row\'s get_it commands)', timeout: 900000 }, async () => {
    const model = mkdtempSync(join(tmpdir(), 'made-up-decider-'));
    try {
      const made = spawnSync('python3', ['-I', '-c', `import sys; sys.path[:0] = [${JSON.stringify(here)}, ${JSON.stringify(join(folder, 'do-work'))}]; import test_end_to_end as t; t.made_up_folder(${JSON.stringify(model)})`], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const records = seed({ count: 3, settings: { page_bytes: 1200 }, modelFolder: model }).map(r => (r.id === MODEL.id ? { ...r, value: { classifier: 'questions-first-decider', weights: { folder: model } } } : r));
      const started = await answerOf(rowOf(file, 'tool:answer-questions-about-many-states'), INPUT, { records });
      assert.equal(started.status, 0, JSON.stringify(started));
      assert.equal(started.result.status, 'finished');
      assert.equal(started.result.states_done, 3);
      const kept = started.kept;
      assert.ok(kept.some(r => r.type === B.PAGE));
      const read = await answerOf(rowOf(file, 'tool:read-a-bulk-answer-run'), { job_id: started.result.job_id, page: 0 }, { records: kept });
      assert.equal(read.result.classifier_answers_as, 'decider-made-up');
      const first = read.result.page.answers[0].answers;
      assert.deepEqual(Object.keys(first).sort(), ['late', 'warm']);
      assert.ok(first.warm.noul > 0 && first.warm.noul < 1);
      assert.ok(!existsSync(join(model, 'jobs')), 'nothing beside the model');
    } finally { rmSync(model, { recursive: true, force: true }); }
  });
