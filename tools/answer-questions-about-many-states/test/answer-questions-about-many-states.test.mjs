// Runs this tool's Python tests (test/test_*.py: the MLX forward, the engine rows' program over a stand-in records door,
// a whole run through the real worker on a made-up model) and checks every row is one the engine runs. Every input is made up. The parts
// that need mlx, tokenizers or blake3 skip inside the Python tests and say why; agreement with the decider's own
// PyTorch code (agree_with_reference.py) and the 303 x 132 wall time (benchmark.py) are run by hand on a Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('every row is run by the engine: a computer run of the one stdlib script, with its records rights', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states',
    'tool:read-a-bulk-answer-run', 'tool:stop-a-bulk-answer-run']);
  const actions = [];
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.argv.slice(0, 3), ['python3', '-I', '/opt/answer-questions-about-many-states/do-work/run_in_engine.py']);
    actions.push(row.invoke.argv[3]);
    assert.ok(existsSync(join(folder, 'do-work', 'run_in_engine.py')));
    assert.equal(row.invoke.records.fd, 3);
    assert.deepEqual(row.placements, ['placement:your-computer']);
  }
  assert.deepEqual(actions, ['get-ready', 'answer', 'read', 'stop']);
  const [ready, answer, read, stop] = rows;
  assert.equal(ready.invoke.internet, true);                       // only fetching weights reaches the internet
  for (const row of [answer, read, stop]) assert.equal(row.invoke.internet, false);
  assert.deepEqual(answer.invoke.capabilities, ['start-a-program']);
  assert.ok(ready.invoke.kept_folder && answer.invoke.kept_folder);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['run_in_engine.py', 'worker.py', 'records_door.py', 'questions_first/engine.py', 'questions_first/backbone.py']) {
    const text = readFileSync(join(folder, 'do-work', name), 'utf8');
    assert.doesNotMatch(text, /decider-2b|Mapika/, name);
  }
});

test('the Python tests of answer-questions-about-many-states pass', { skip: python.status === 0 ? false : 'needs python3', timeout: 900000 }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
