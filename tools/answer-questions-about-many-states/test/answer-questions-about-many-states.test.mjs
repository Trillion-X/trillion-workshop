// The rows and their functions, with the made-up classifier program (test/made_up_worker.py) in place of a model, and
// the Python tests (test/test_*.py: the MLX forward, the classifier program, the whole program on a made-up model).
// Every input is made up. Each row takes what it works on in its request and returns its result in its answer; no run
// is handed no door. The parts that need mlx, tokenizers or blake3 skip and say why; agreement with the
// decider's own PyTorch code (agree_with_reference.py) and the 303 x 132 wall time (benchmark.py) are run by hand on a Mac.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import * as B from '../read-data/bulk-answer.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const file = JSON.parse(readFileSync(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8'));
const rows = file.records.map(record => record.payload);
const runtimePython = process.env.WORKSHOP_TEST_PYTHON ?? 'python3';
const python = spawnSync(runtimePython, ['--version'], { encoding: 'utf8' });
const hasModules = names => python.status === 0 && spawnSync(runtimePython, ['-I', '-B', '-c', names.map(name => `import ${name}`).join('; ')]).status === 0;
const skipPython = python.status === 0 ? false : 'needs python3';

// ---- made-up request

let modelFolder;
test.before(() => { modelFolder = tempFolder(join(tmpdir(), 'made-up-model-')); });
test.after(() => rmSync(modelFolder, { recursive: true, force: true }));

const request = (count = 7, settings = {}) => ({
  model: { classifier: 'made-up', weights: { folder: modelFolder } },
  questions: { warm: { type: 'noul', instructions: 'Is the lamp warm?' }, late: { type: 'noul', instructions: 'Is the parcel late?' } },
  settings: { layout: 'independent', dtype: 'float32', tokens_per_batch: 4096, max_state_tokens: 512, ...settings },
  states: Array.from({ length: count }, (_, i) => ({ id: `line-${String(i).padStart(3, '0')}`, state: `Made-up line ${i}.` })),
});

const madeUp = (action, input) => B.startWorker(action, input, { python: runtimePython, worker: join(here, 'made_up_worker.py') });

// ---- the rows

test('the classifier runs on the person\'s Mac and every row keeps no rows', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states']);
  const exports = rows.map(row => row.invoke.run.at(-1));
  assert.deepEqual(exports, ['getAClassifierReady', 'answerManyStates']);
  for (const [i, row] of rows.entries()) {
    assert.equal(typeof B[exports[i]], 'function', exports[i]);
    assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.ok(!('records' in row.invoke), `${row.id} is handed no records door`);
    assert.ok(!('record_model' in row), `${row.id} declares no kept record kinds`);
    assert.ok(!JSON.stringify(row).includes('jobs_folder'), `${row.id} names no folder of runs`);
    assert.ok(row.invoke.files.package_files[0].paths.includes('do-work'), `${row.id} packs the classifier program`);
  }
  assert.equal(rows[1].invoke.max_run_ms, 14_400_000);
  assert.deepEqual(rows[0].invoke.outputs, [{
    name: 'snapshot', path: '/opt/answer-questions-about-many-states/.training-output/snapshot', keep_in: 'files',
    media_type: 'application/octet-stream', max_bytes: 8 * 1024 ** 3,
    tree: { files_from: 'files', max_files: 64, max_bytes: 8 * 1024 ** 3 },
  }]);
  // The inputs are values handed in: the answer row asks for the model, the questions, the settings and the states.
  assert.deepEqual(rows[1].input_schema.required, ['model', 'questions', 'settings', 'states']);
  assert.deepEqual(rows[0].input_schema.required, ['model']);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['do-work/run_classifier.py', 'do-work/answer_many_states.py', 'do-work/questions_first/engine.py', 'do-work/questions_first/backbone.py', 'read-data/run-classifier.mjs', 'read-data/bulk-answer.mjs']) {
    assert.doesNotMatch(readFileSync(join(folder, name), 'utf8'), /decider-2b|Mapika/, name);
  }
});

test('the code reaches no records door and no page, run or cancel row', () => {
  const code = readFileSync(join(folder, 'read-data/bulk-answer.mjs'), 'utf8');
  assert.doesNotMatch(code, /\bdoor\.|records:|bulk-answer-(run|page|cancel)|classifier-ready/);
});

test('both Mac rows declare the restored native model loader dependencies', () => {
  for (const row of rows) {
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

// ---- a run answers in its answer

test('a run returns every state\'s answers in its answer and leaves no file in the tool\'s folder', { skip: skipPython }, async () => {
  const before = readdirSync(folder, { recursive: true }).sort();
  const done = await B.answerManyStates(request(), undefined, { start: madeUp });
  assert.equal(done.status, 'finished');
  assert.deepEqual([done.states_done, done.states, done.classifier_answers_as], [7, 7, 'made-up']);
  assert.deepEqual(done.answers.map(a => a.id), request().states.map(s => s.id));
  assert.deepEqual(done.answers.map(a => a.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(done.answers[3].answers.warm, { type: 'noul', noul: 0.253 });
  assert.deepEqual(Object.keys(done.answers[0].answers).sort(), ['late', 'warm']);
  assert.deepEqual(readdirSync(folder, { recursive: true }).sort(), before, 'the run left no file in the tool\'s folder');
});

test('a state given without an id is answered by its index alone', { skip: skipPython }, async () => {
  const given = request(2);
  given.states = given.states.map(({ state }) => ({ state }));
  const done = await B.answerManyStates(given, undefined, { start: madeUp });
  assert.deepEqual(done.answers.map(a => Object.keys(a).sort()), [['answers', 'index'], ['answers', 'index']]);
});

test('what is wrong with the request is named before a worker starts', async () => {
  const refused = (input, words) => assert.rejects(B.answerManyStates(input, undefined, { start: () => assert.fail('no worker starts') }), words);
  await refused({ ...request(), model: 'record:classifier-model:made-up' }, /`model` is the model's value/);
  await refused({ ...request(), questions: { } }, /`questions` is the map/);
  await refused({ ...request(), settings: { layout: 'independent' } }, /`settings` has no `dtype`/);
  await refused({ ...request(), states: [] }, /at least one/);
  await refused({ ...request(), states: [{ id: 3, state: 'x' }] }, /`states\[0\]` is/);
});

test('worker-side validation is the answer\'s error', { skip: skipPython }, async () => {
  const bad = request();
  bad.model.classifier = 'nope';
  await assert.rejects(B.answerManyStates(bad, undefined, { start: madeUp }), /classifier families/);
});

test('a worker stopped by a signal returns the answers it finished, as cancelled', { skip: skipPython, timeout: 10000 }, async () => {
  const run = B.answerManyStates(request(20, { made_up_seconds: 0.2 }), undefined, {
    start: (action, input) => { const child = madeUp(action, input); setTimeout(() => child.kill('SIGTERM'), 700); return child; },
  });
  const done = await run;
  assert.equal(done.status, 'cancelled');
  assert.ok(done.states_done > 0 && done.states_done < 20, `${done.states_done} of 20 answered`);
  assert.equal(done.answers.length, done.states_done);
});

test('get-ready returns the naming of the weights and writes nothing', { skip: hasModules(['blake3']) ? false : 'needs python3 with blake3' }, async () => {
  writeFileSync(join(modelFolder, 'config.json'), '{"model_type": "made-up"}');
  const actions = [];
  let suppliedOutput;
  const ready = await B.getAClassifierReady({ model: request().model }, undefined, {
    start: (action, input) => {
      actions.push(action);
      suppliedOutput = input.snapshot_output;
      return madeUp(action, { ...input, snapshot_output: join(modelFolder, 'snapshot') });
    },
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(actions, ['get-ready-with-snapshot']);
  assert.equal(suppliedOutput, join(folder, '.training-output', 'snapshot'));
  assert.match(ready.identity, /^1f:[0-9a-f]{64}$/);
  assert.deepEqual(ready.files.map(f => f.name), ['config.json']);
  assert.equal(ready.classifier, 'made-up');
});

// ---- the Python tests, and the whole row on a made-up model

test('the Python tests of answer-questions-about-many-states pass', { skip: skipPython, timeout: 900000 }, () => {
  const run = spawnSync(runtimePython, ['-I', '-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

test('the start row, run as the engine runs it, answers a made-up model\'s states in its answer',
  { skip: process.env.WORKSHOP_TEST_PYTHON ? false : 'needs the declared classifier profile consumer', timeout: 900000 }, async () => {
    const classifierPython = process.env.WORKSHOP_TEST_PYTHON;
    const model = tempFolder(join(tmpdir(), 'made-up-decider-'));
    try {
      const made = spawnSync(classifierPython, ['-I', '-B', '-c', `import sys; sys.path[:0] = [${JSON.stringify(here)}, ${JSON.stringify(join(folder, 'do-work'))}]; import test_end_to_end as t; t.made_up_folder(${JSON.stringify(model)})`], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const input = { ...request(3), model: { classifier: 'questions-first-decider', weights: { folder: model } } };
      const started = await answerOf(rowOf(file, 'tool:answer-questions-about-many-states'), input, {
        python_environment: 'classifier-framework',
        stand_in_programs: { python3: 'exec "$WORKSHOP_TEST_PYTHON" "$@"' },
      });
      assert.equal(started.status, 0, JSON.stringify(started));
      assert.equal(started.result.status, 'finished');
      assert.equal(started.result.states_done, 3);
      assert.equal(started.result.classifier_answers_as, 'decider-made-up');
      const first = started.result.answers[0].answers;
      assert.deepEqual(Object.keys(first).sort(), ['late', 'warm']);
      assert.ok(first.warm.noul > 0 && first.warm.noul < 1);
      assert.deepEqual(started.kept ?? [], [], 'nothing written to the person\'s records');
      assert.ok(!existsSync(join(model, 'jobs')), 'nothing beside the model');
    } finally { rmSync(model, { recursive: true, force: true }); }
  });
