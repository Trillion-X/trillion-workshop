// Runs the Python tests (a made-up camera file drawn by ffmpeg, served by a stand-in reader) and checks the row names the
// script that exists and runs on the person's computer. Without ffmpeg the run test skips and says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const haveFfmpeg = spawnSync('ffprobe', ['-version']).status === 0;

test('the row runs the one script on the person\'s computer, reads only its own settings rows, and holds no key or account', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:pull-a-time-window-from-a-stored-camera-file']);
  const [row] = rows;
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['start-a-program', 'change-a-folder']);
  assert.deepEqual(row.invoke.argv.slice(0, 5), ['node', '/opt/settings/do-work/run-with-settings.mjs', '--folder', 'pull-a-time-window-from-a-stored-camera-file', '--']);
  assert.ok(row.invoke.argv.includes('/opt/pull-a-time-window-from-a-stored-camera-file/do-work/pull_window.py'));
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'record:setting', prefix: 'record:setting:pull-a-time-window-from-a-stored-camera-file~', operations: ['records:read'] }]);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.ok(existsSync(join(folder, 'do-work', 'pull_window.py')));
  for (const file of ['do-work/pull_window.py', 'tool-rows.json']) assert.doesNotMatch(readFileSync(join(folder, file), 'utf8'), /\/Users\/|[0-9a-f]{64}/);
});

test('the script reads only headers, moov and the asked packets', { skip: haveFfmpeg ? false : 'needs ffmpeg and ffprobe', timeout: 900000 }, () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_pull_window.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(-3000));
  assert.match(run.stderr, /Ran (\d+) tests/);
});
