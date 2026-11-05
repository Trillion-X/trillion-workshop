// Runs the Python tests of this tool (test/test_fine_tune.py) with made-up rules and lines, and checks each row names
// the script that exists. Building rows and reporting from kept scores run for real; training and scoring with a model
// need torch and a decider model folder, which these tests do not fetch, so only their refusals are tested.
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

test('each row runs on the person\'s computer and names a script that exists', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:build-training-rows-from-a-persons-rules', 'tool:train-a-small-model-on-a-persons-rules', 'tool:score-held-out-lines-with-a-small-model']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    const script = row.invoke.run.match(/tools\/fine-tune-a-small-model-on-a-persons-rules\/(do-work\/\w+\.py)/)[1];
    assert.ok(existsSync(join(folder, script)), script);
    assert.deepEqual(row.placements, ['placement:your-computer']);
  }
});

test('the Python tests of fine-tune-a-small-model-on-a-persons-rules pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', join(here, 'test_fine_tune.py')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
