// Runs the Python tests and checks the row names the script that exists and runs on the person's computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the row runs the one script on the person\'s computer, over the folder they let it read, with its own settings only', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:name-the-recording-behind-transcript-lines']);
  const [row] = rows;
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.deepEqual(row.invoke.argv.slice(0, 2), ['python3', '-I']);
  assert.doesNotMatch(JSON.stringify(row.invoke), /run-with-settings|records-door/, 'the setting arrives in the request; nothing reads it for the tool');
  assert.ok(row.invoke.argv.includes('/opt/name-the-recording-behind-transcript-lines/do-work/name_recording.py'));
  assert.equal(row.invoke.records, undefined);
  assert.equal(row.result_selector, '$.result');
  assert.ok(existsSync(join(folder, 'do-work', 'name_recording.py')));
});

test('the script keeps its promises on a made-up archive', () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_name_recording.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
  assert.match(run.stderr, /Ran (\d+) tests/);
});
