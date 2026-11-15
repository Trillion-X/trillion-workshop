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
const runtimePython = process.env.WORKSHOP_TEST_PYTHON ?? 'python3';
const python = spawnSync(runtimePython, ['--version'], { encoding: 'utf8' });
const hasModules = names => python.status === 0 && spawnSync(runtimePython, ['-I', '-B', '-c', names.map(name => `import ${name}`).join('; ')]).status === 0;

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

const madeUp = (action, request) => B.startWorker(action, request, { python: runtimePython, worker: join(here, 'made_up_worker.py') });

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
  assert.deepEqual(rows[0].invoke.outputs, [{
    name: 'snapshot', path: '/opt/answer-questions-about-many-states/.training-output/snapshot', keep_in: 'files',
    media_type: 'application/octet-stream', max_bytes: 8 * 1024 ** 3,
    tree: { files_from: 'files', max_files: 64, max_bytes: 8 * 1024 ** 3 },
  }]);
  // The inputs are the person's rows, by record id: each read right is that one row, the states one prefix.
  const rights = rows[1].invoke.records.rights;
  for (const field of ['model', 'questions', 'settings']) {
    assert.ok(rights.some(r => r.kind?.fill?.field === `${field}.type` && r.id?.fill?.field === `${field}.id` && r.operations.join() === 'records:read'), field);
  }
  assert.ok(rights.some(r => r.kind?.fill?.field === 'states.type' && r.prefix?.fill?.field === 'states.prefix' && r.operations.join() === 'records:list'));
  assert.deepEqual(rows[0].record_model.kinds.map(kind => kind.type), [B.RUN, B.PAGE, B.CANCEL, B.READY]);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['do-work/run_classifier.py', 'do-work/answer_many_states.py', 'do-work/questions_first/engine.py', 'do-work/questions_first/backbone.py', 'read-data/run-classifier.mjs', 'read-data/bulk-answer.mjs']) {
    assert.doesNotMatch(readFileSync(join(folder, name), 'utf8'), /decider-2b|Mapika/, name);
  }
});

test('both Mac rows declare the restored native model loader dependencies', () => {
  for (const row of rows.slice(0, 2)) {
    const setup = row.invoke.get_it.join('\n');
    for (const dependency of ['mlx==0.32.3', 'mlx-lm==0.32.2', 'transformers==5.22.2']) {
      assert.ok(setup.split(/\s+/).includes(dependency), `${row.id}: ${dependency}`);
    }
  }
});

test('the worker disables Python bytecode writes', { skip: skipPython }, async () => {
  const child = madeUp('check-bytecode-flag', {});
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout.trim()), { dont_write_bytecode: true });
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

test('two clients admitting the same absent run start only one worker', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, elsewhere, fake }) => {
    let arrivals = 0, release;
    const bothRead = new Promise(resolve => { release = resolve; });
    const together = door => {
      let first = true;
      return { ...door, async read(type, id) {
        const value = await door.read(type, id);
        if (type === B.RUN && first) {
          first = false;
          if (++arrivals === 2) release();
          await bothRead;
        }
        return value;
      } };
    };
    let starts = 0;
    const start = (action, request) => {
      starts++;
      assert.equal([...fake.kept.values()].filter(row => row.type === B.RUN).length, 1, 'the claim committed before spawn');
      return madeUp(action, request);
    };
    const outcomes = await Promise.all([mac, elsewhere].map(door => B.answerManyStates(INPUT, { door: together(door) }, { start })));
    assert.equal(starts, 1);
    assert.equal(outcomes[0].job_id, outcomes[1].job_id);
    assert.equal(outcomes.filter(outcome => outcome.already).length, 1);
    const kept = await B.readABulkAnswerRun({ job_id: outcomes[0].job_id }, { door: mac });
    assert.equal(kept.status, 'finished');
    const claim = fake.calls.find(call => call.method === 'records:write');
    assert.equal(claim.input.records.find(row => row.type === B.RUN).expected, null);
    const claims = fake.calls.filter(call => call.method === 'records:write' && call.input.records.some(row => row.type === B.RUN && row.expected === null));
    assert.equal(claims.length, 2);
    assert.notEqual(claims[0].key, claims[1].key, 'independent outer calls do not share the admission request key');
  });
});

test('a replaced attempt cannot publish an old page or overwrite the new final status', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, elsewhere, fake }) => {
    let releaseOld, pageReady;
    const held = new Promise(resolve => { releaseOld = resolve; });
    const reachedPage = new Promise(resolve => { pageReady = resolve; });
    let holdFirst = true;
    const oldDoor = { ...mac, async write(records, options) {
      if (holdFirst && records.some(record => record.type === B.PAGE)) {
        holdFirst = false;
        pageReady();
        await held;
      }
      return mac.write(records, options);
    } };
    const epoch = Date.parse('2026-11-08T06:00:00.000Z');
    const old = B.answerManyStates(INPUT, { door: oldDoor }, { start: madeUp, now: () => epoch })
      .then(result => ({ result }), error => ({ error }));
    try {
      await reachedPage;
      const current = await B.answerManyStates(INPUT, { door: elsewhere }, { start: madeUp, now: () => epoch + B.STALE_MS + 1 });
      assert.equal(current.status, 'finished');
      const before = structuredClone([...fake.kept]);
      releaseOld();
      const stale = await old;
      assert.equal(stale.error?.code, 'original_command_conflict');
      assert.deepEqual([...fake.kept], before, 'the losing page and failure cleanup change no newer record');
      assert.equal((await B.readABulkAnswerRun({ job_id: current.job_id }, { door: elsewhere })).status, 'finished');
    } finally { releaseOld(); await old; }
  });
});

test('an unknown claim outcome starts no worker and is not compensated with a new write', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, fake }) => {
    let writes = 0, starts = 0;
    const uncertain = { ...mac, async write(records, options) {
      writes++;
      await mac.write(records, options);
      throw Object.assign(new Error('synthetic unknown claim outcome'), { code: 'original_workspace_source_unavailable', outcome: 'unknown' });
    } };
    await assert.rejects(B.answerManyStates(INPUT, { door: uncertain }, { start: (action, request) => { starts++; return madeUp(action, request); } }), /unknown claim/);
    assert.equal(starts, 0);
    assert.equal(writes, 1);
    assert.equal(fake.calls.filter(call => call.method === 'records:write').length, 1);
  });
});

test('a lost claim response starts no worker even without a classified outcome', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, fake }) => {
    let starts = 0, writes = 0;
    const disconnected = { ...mac, async write(records, options) {
      writes++;
      await mac.write(records, options);
      throw new TypeError('synthetic claim response body lost');
    } };
    await assert.rejects(B.answerManyStates(INPUT, { door: disconnected }, { start: (action, request) => { starts++; return madeUp(action, request); } }), /response body lost/);
    assert.equal(starts, 0);
    assert.equal(writes, 1);
    assert.equal(fake.calls.filter(call => call.method === 'records:write').length, 1);
  });
});

test('an ambiguous progress write stops the worker without a compensating status write', { skip: skipPython }, async () => {
  await withDoor(seed({ modelFolder }), async ({ mac, fake }) => {
    let unknown = false, laterWrites = 0, starts = 0;
    const disconnected = { ...mac, async write(records, options) {
      if (unknown) laterWrites++;
      const receipt = await mac.write(records, options);
      if (records.some(row => row.type === B.PAGE)) {
        unknown = true;
        throw new TypeError('synthetic progress response body lost');
      }
      return receipt;
    } };
    await assert.rejects(B.answerManyStates(INPUT, { door: disconnected }, { start: (action, request) => { starts++; return madeUp(action, request); } }), /progress response body lost/);
    assert.equal(starts, 1);
    assert.equal(laterWrites, 0);
    assert.equal([...fake.kept.values()].find(row => row.type === B.RUN).value.status, 'running', 'a lost reply cannot establish a failed status');
    assert.equal(fake.calls.some(call => call.method === 'records:write' && call.key.endsWith(':failed')), false);
  });
});

for (const applied of [false, true]) {
  test(`a pending unknown heartbeat cannot be followed by failure cleanup (${applied ? 'applied' : 'not applied'})`, { skip: skipPython, timeout: 10000 }, async () => {
    await withDoor(seed({ count: 4, settings: { page_bytes: 1, made_up_seconds: 0.15 }, modelFolder }), async ({ mac, fake }) => {
      const epoch = Date.parse('2026-11-08T06:00:00.000Z');
      let clock = epoch, reached, release, closed, timer, unknown = false, laterWrites = 0;
      const ready = new Promise(resolve => { reached = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const childClosed = new Promise(resolve => { closed = resolve; });
      const delayed = { ...mac, async write(records, options) {
        if (unknown) laterWrites++;
        const run = records.find(row => row.type === B.RUN);
        if (run?.value.status === 'running' && run.value.updated_at === new Date(epoch + B.HEARTBEAT_MS + 1).toISOString()) {
          if (applied) await mac.write(records, options);
          reached();
          await held;
          unknown = true;
          throw Object.assign(new Error('synthetic pending heartbeat unknown'), { code: 'original_workspace_source_unavailable', outcome: 'unknown' });
        }
        const receipt = await mac.write(records, options);
        if (run?.expected && clock === epoch) setTimeout(() => { clock = epoch + B.HEARTBEAT_MS + 1; }, 0);
        return receipt;
      } };
      const running = B.answerManyStates(INPUT, { door: delayed }, { now: () => clock, pollMs: 5, start: (action, request) => {
        const child = madeUp(action, request); child.once('close', closed); return child;
      } }).then(result => ({ result }), error => ({ error }));
      try {
        await Promise.race([Promise.all([ready, childClosed]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pending heartbeat boundary not reached')), 5000); })]);
        clearTimeout(timer);
        await new Promise(resolve => setTimeout(resolve, 0));
        release();
        const outcome = await running;
        assert.equal(outcome.error?.outcome, 'unknown');
        assert.equal(laterWrites, 0);
        assert.equal([...fake.kept.values()].find(row => row.type === B.RUN).value.status, 'running');
      } finally { clearTimeout(timer); release(); await running; }
    });
  });
}

for (const phase of ['heartbeat', 'finished', 'failed']) {
  test(`a replaced attempt cannot publish its late ${phase}`, { skip: skipPython, timeout: 10000 }, async () => {
    await withDoor(seed({ count: 4, settings: { made_up_seconds: phase === 'heartbeat' ? 0.15 : 0 }, modelFolder }), async ({ mac, elsewhere, fake }) => {
      const epoch = Date.parse('2026-11-08T06:00:00.000Z');
      let oldTime = epoch, releaseOld, reached, readyTimer;
      const held = new Promise(resolve => { releaseOld = resolve; });
      const ready = new Promise(resolve => { reached = resolve; });
      let first = true;
      const oldDoor = { ...mac, async write(records, options) {
        const run = records.find(row => row.type === B.RUN);
        const target = phase !== 'heartbeat' ? run?.value.status === phase
          : run?.value.status === 'running' && run.value.updated_at === new Date(epoch + B.HEARTBEAT_MS + 1).toISOString()
            && !records.some(row => row.type === B.PAGE);
        if (first && target) { first = false; reached(); await held; }
        const result = await mac.write(records, options);
        if (phase === 'heartbeat' && run?.expected && oldTime === epoch) setTimeout(() => { oldTime = epoch + B.HEARTBEAT_MS + 1; }, 0);
        return result;
      } };
      const old = B.answerManyStates(INPUT, { door: oldDoor }, { start: phase === 'failed' ? () => { throw new Error('synthetic worker admission failure'); } : madeUp, now: () => oldTime, pollMs: 5 })
        .then(result => ({ result }), error => ({ error }));
      try {
        await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error(`synthetic ${phase} boundary was not reached`)), 5000); })]);
        clearTimeout(readyTimer);
        const winner = await B.answerManyStates(INPUT, { door: elsewhere }, { start: madeUp, now: () => epoch + B.STALE_MS + 1 });
        assert.equal(winner.status, 'finished');
        const before = structuredClone([...fake.kept]);
        releaseOld();
        assert.equal((await old).error?.code, 'original_command_conflict');
        assert.deepEqual([...fake.kept], before);
      } finally { clearTimeout(readyTimer); releaseOld(); await old; }
    });
  });
}

for (const phase of ['active', 'expired']) {
test(`a stale ${phase} cancellation cannot erase the winning attempt cancellation or status`, { skip: skipPython, timeout: 10000 }, async () => {
  await withDoor(seed({ count: 20, settings: { made_up_seconds: 0.2 }, modelFolder }), async ({ mac, elsewhere, fake }) => {
    const { jobId } = await B.readInputs(INPUT, mac);
    const hex = jobId.slice(3), epoch = Date.parse('2026-11-08T06:00:00.000Z');
    const oldRun = { job_id: jobId, attempt: 'old-cancel-opponent', status: 'running', states_done: 0, states: 20, pages: 0,
      started_at: new Date(epoch).toISOString(), updated_at: new Date(epoch).toISOString(), longest_until: new Date(epoch + B.LONGEST_RUN_MS).toISOString() };
    fake.kept.set(B.runId(hex), { id: B.runId(hex), type: B.RUN, value: oldRun });
    let releaseOld, reached, launched;
    const held = new Promise(resolve => { releaseOld = resolve; });
    const ready = new Promise(resolve => { reached = resolve; });
    const started = new Promise(resolve => { launched = resolve; });
    const oldDoor = { ...mac, async write(records, options) { reached(); await held; return mac.write(records, options); } };
    const old = B.cancelABulkAnswerRun({ job_id: jobId }, { door: oldDoor }, { now: () => epoch + (phase === 'expired' ? B.STALE_MS + 1 : 1) })
      .then(result => ({ result }), error => ({ error }));
    let running;
    try {
      await ready;
      const now = () => epoch + B.STALE_MS + 1;
      running = B.answerManyStates(INPUT, { door: elsewhere }, { now, pollMs: 5, start: (action, request) => {
        const child = madeUp(action, request); launched(); return child;
      } }).then(result => ({ result }), error => ({ error }));
      await started;
      const winnerAttempt = fake.kept.get(B.runId(hex)).value.attempt;
      assert.notEqual(winnerAttempt, oldRun.attempt);
      assert.equal((await B.cancelABulkAnswerRun({ job_id: jobId }, { door: elsewhere }, { now })).status, 'cancelling');
      assert.equal((await running).result?.status, 'cancelled');
      const before = structuredClone([...fake.kept]);
      releaseOld();
      assert.equal((await old).error?.code, 'original_command_conflict');
      assert.deepEqual([...fake.kept], before);
      assert.equal(fake.kept.get(B.cancelId(hex)).value.attempt, winnerAttempt);
    } finally { releaseOld(); await old; if (running) await running; }
  });
});
}

test('revoked write rights stop progress without publishing answers or an unfenced failure', { skip: skipPython }, async () => {
  const rights = RIGHTS.map(right => ({ ...right, operations: [...right.operations] }));
  const fake = await startFakeDoor({ rights, records: seed({ modelFolder }) });
  const door = openRecordsDoor({ descriptor: fake.descriptor });
  try {
    await assert.rejects(B.answerManyStates(INPUT, { door }, { start: (action, request) => {
      for (const right of rights) right.operations = right.operations.filter(operation => operation !== 'records:write');
      return madeUp(action, request);
    } }), error => error.code === 'current_workspace_rights_refused');
    assert.equal([...fake.kept.values()].filter(row => row.type === B.PAGE).length, 0);
    assert.equal(fake.calls.filter(call => call.method === 'records:write').length, 2, 'only admission and the refused checked transition');
  } finally { await fake.close(); }
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
  await withDoor(rowsNow, async ({ elsewhere }) => {
    await assert.rejects(B.readABulkAnswerRun({ job_id: 'abc' }, { door: elsewhere }), /1f:<64 hex>/);
    await assert.rejects(B.readABulkAnswerRun({ job_id: `1f:${'b'.repeat(64)}` }, { door: elsewhere }), /no run/);
    await assert.rejects(B.cancelABulkAnswerRun({ job_id: `1f:${'b'.repeat(64)}` }, { door: elsewhere }), /no run/);
  });
});

test('worker-side validation fails only its claimed attempt without entering answer work', { skip: skipPython }, async () => {
  const invalid = seed({ modelFolder }).map(r => r.id === MODEL.id ? { ...r, value: { ...r.value, classifier: 'nope' } } : r);
  await withDoor(invalid, async ({ mac, fake }) => {
    let stdout = '';
    await assert.rejects(B.answerManyStates(INPUT, { door: mac }, { start: (action, request) => {
      assert.equal([...fake.kept.values()].filter(row => row.type === B.RUN).length, 1);
      const child = madeUp(action, request);
      child.stdout.on('data', chunk => { stdout += chunk; });
      return child;
    } }), /classifier families/);
    assert.doesNotMatch(stdout, /"checked"|"answered"/);
    const run = [...fake.kept.values()].find(row => row.type === B.RUN).value;
    assert.equal(run.status, 'failed');
    assert.match(run.error, /classifier families/);
    assert.equal([...fake.kept.values()].filter(row => row.type === B.PAGE).length, 0);
    const writes = fake.calls.filter(call => call.method === 'records:write');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].input.records[0].expected.value.attempt, run.attempt);
  });
});

test('get-ready keeps the naming of the weights as a row beside the model row', { skip: hasModules(['blake3']) ? false : 'needs python3 with blake3' }, async () => {
  const fake = await startFakeDoor({ rights: [{ kind: MODEL.type, id: MODEL.id, operations: ['records:read'] }, { kind: B.READY, prefix: `${B.READY}:`, operations: ['records:write'] }],
    records: seed({ modelFolder }) });
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(modelFolder, 'config.json'), '{"model_type": "made-up"}');
    const actions = [];
    let suppliedOutput;
    const ready = await B.getAClassifierReady({ model: MODEL }, { door: openRecordsDoor({ descriptor: fake.descriptor }) }, {
      start: (action, request) => {
        actions.push(action);
        suppliedOutput = request.snapshot_output;
        return madeUp(action, { ...request, snapshot_output: join(modelFolder, 'snapshot') });
      },
    });
    assert.equal(ready.ready, true);
    assert.deepEqual(actions, ['get-ready-with-snapshot']);
    assert.equal(suppliedOutput, join(folder, '.training-output', 'snapshot'));
    assert.match(ready.identity, /^1f:[0-9a-f]{64}$/);
    const kept = fake.kept.get(ready.record.id);
    assert.equal(kept.type, B.READY);
    assert.deepEqual(kept.value.model, MODEL);
    assert.deepEqual(kept.value.files.map(f => f.name), ['config.json']);
  } finally { await fake.close(); }
});

// ---- the Python tests, and the whole row on a made-up model

test('the Python tests of answer-questions-about-many-states pass', { skip: skipPython, timeout: 900000 }, () => {
  const run = spawnSync(runtimePython, ['-I', '-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

test('the start row, run as the engine runs it, answers a made-up model\'s states into rows that the read row reads',
  { skip: process.env.WORKSHOP_TEST_PYTHON ? false : 'needs the declared classifier profile consumer', timeout: 900000 }, async () => {
    const classifierPython = process.env.WORKSHOP_TEST_PYTHON;
    const model = mkdtempSync(join(tmpdir(), 'made-up-decider-'));
    try {
      const made = spawnSync(classifierPython, ['-I', '-B', '-c', `import sys; sys.path[:0] = [${JSON.stringify(here)}, ${JSON.stringify(join(folder, 'do-work'))}]; import test_end_to_end as t; t.made_up_folder(${JSON.stringify(model)})`], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const records = seed({ count: 3, settings: { page_bytes: 1200 }, modelFolder: model }).map(r => (r.id === MODEL.id ? { ...r, value: { classifier: 'questions-first-decider', weights: { folder: model } } } : r));
      const started = await answerOf(rowOf(file, 'tool:answer-questions-about-many-states'), INPUT, {
        records, python_environment: 'classifier-framework',
        stand_in_programs: { python3: 'exec "$WORKSHOP_TEST_PYTHON" "$@"' },
      });
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
