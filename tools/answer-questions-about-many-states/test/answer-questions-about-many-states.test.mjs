// Runs this tool's Python tests (test/test_*.py: the MLX forward, the lifecycle, the whole command on a made-up model)
// and checks each row runs on the person's computer through a script that exists. Every input is made up. The parts
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

test('each row runs on the person\'s Mac through the one script, one action each', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states',
    'tool:read-a-bulk-answer-run', 'tool:cancel-a-bulk-answer-run']);
  const actions = [];
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    const [, script, action] = row.invoke.run.match(/tools\/answer-questions-about-many-states\/(do-work\/\w+\.py) ([a-z-]+) --request \{input\}$/);
    assert.ok(existsSync(join(folder, script)), script);
    actions.push(action);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.ok(row.invoke.needs.includes('a Mac with Apple silicon'));
  }
  assert.deepEqual(actions, ['get-ready', 'start', 'read', 'cancel']);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['answer_many_states.py', 'questions_first/engine.py', 'questions_first/backbone.py']) {
    const text = readFileSync(join(folder, 'do-work', name), 'utf8');
    assert.doesNotMatch(text, /decider-2b|Mapika/, name);
  }
});

test('the Python tests of answer-questions-about-many-states pass', { skip: python.status === 0 ? false : 'needs python3', timeout: 900000 }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
