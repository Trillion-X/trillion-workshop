// Runs the Python tests (made-up word times) and checks the row runs the one script with its own settings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the row runs the one script on the person\'s computer, over the folder they let it change, with its own settings only', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:find-a-spoken-passage-in-word-times']);
  const [row] = rows;
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['change-a-folder']);
  assert.deepEqual(row.invoke.argv.slice(0, 5), ['node', '/opt/settings/do-work/run-with-settings.mjs', '--folder', 'find-a-spoken-passage-in-word-times', '--']);
  assert.ok(row.invoke.argv.includes('/opt/find-a-spoken-passage-in-word-times/do-work/word_times.py'));
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'record:setting', prefix: 'record:setting:find-a-spoken-passage-in-word-times~', operations: ['records:read'] }]);
  assert.ok(existsSync(join(folder, 'do-work', 'word_times.py')));
});

test('the script keeps its promises on made-up word times', () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_word_times.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
  assert.match(run.stderr, /Ran (\d+) tests/);
});
