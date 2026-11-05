// Runs the Python tests (a made-up library, bank, concept files and judged files) and checks the row names the script
// that exists and runs on the person's computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the row runs the one script on the person\'s computer, over the folder they let it change, with its own settings only', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:rank-library-formats-against-concepts']);
  const [row] = rows;
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['change-a-folder']);
  assert.deepEqual(row.invoke.argv.slice(0, 5), ['node', '/opt/settings/do-work/run-with-settings.mjs', '--folder', 'rank-library-formats-against-concepts', '--']);
  assert.ok(row.invoke.argv.includes('/opt/rank-library-formats-against-concepts/do-work/rank_formats.py'));
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'record:setting', prefix: 'record:setting:rank-library-formats-against-concepts~', operations: ['records:read'] }]);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.ok(existsSync(join(folder, 'do-work', 'rank_formats.py')));
});

test('the defaults name no person, film or place', () => {
  const text = readFileSync(join(folder, 'do-work', 'rank_formats.py'), 'utf8');
  assert.doesNotMatch(text, /\/Users\/|\bhis\b|\bher\b/);
});

test('the script keeps its promises on a made-up library', () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_rank_formats.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
  assert.match(run.stderr, /Ran (\d+) tests/);
});
