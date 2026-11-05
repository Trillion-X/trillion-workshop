// Checks the rows name scripts that exist and runs the Python tests of this tool (test/test_sort.py) on made-up
// channels, videos and recorded YouTube replies. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map((r) => r.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('each row names a script that exists', () => {
  assert.deepEqual(rows.map((r) => r.id), [
    'tool:plan-sorting-youtube-watch-later-into-playlists',
    'tool:read-my-youtube-watch-later-and-playlists',
    'tool:make-youtube-playlists-from-a-sort-plan',
  ]);
  assert.equal(rows[0].invoke.kind, 'computer');
  assert.ok(existsSync(join(folder, 'do-work', 'plan_sort.py')));
  for (const row of rows.slice(1)) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    const script = row.invoke.run.match(/tools\/sort-youtube-watch-later-into-playlists\/(do-work\/\w+\.py)/)[1];
    assert.ok(existsSync(join(folder, script)), script);
  }
  for (const script of ['list_signed_in_accounts.py', 'verify_sort.py']) assert.ok(existsSync(join(folder, 'do-work', script)), script);
});

test('the Python tests of sort-youtube-watch-later-into-playlists pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', join(folder, 'test', 'test_sort.py')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
