// Runs the folder's Python tests (test/test_benchmark.py: every script with made-up inputs, stand-in models and stand-in
// ffprobe and frame tool) and checks every row runs a script that exists here, on the person's computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('every row runs one of this folder\'s scripts on the person\'s computer', () => {
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    assert.deepEqual(row.placements, ['placement:your-computer']);
    const script = row.invoke.run.match(/do-work\/([a-z_{}]+)\.py/)[1];
    const steps = script === '{step}' ? row.description.match(/Steps: (.*)\.$/)[1].split(', ') : [script];
    for (const step of steps) assert.ok(existsSync(join(folder, 'do-work', `${step}.py`)), `${row.id}: ${step}.py`);
  }
});

test('the scripts do what their headers say, on made-up inputs', { timeout: 600_000 }, () => {
  const ran = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', join(folder, 'test'), '-p', 'test_*.py'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(ran.status, 0, ran.stderr.slice(-4000));
});
