// Runs the Python tests of this tool (one passing and one failing case per check, on small synthetic videos made with ffmpeg), one
// node test per Python test file and all at once, and checks that the row's command is a file in this folder and that the command
// refuses to run without the person's limits. The Python tests need python3 with numpy, OpenCV, Pillow, SciPy and blake3, and ffmpeg;
// without them they skip and say why.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const environment = JSON.parse(python(join(folder, 'test', 'check_environment.py')).stdout.trim().split('\n').pop() || '{"ok":false,"reason":"python3 did not run"}');
const skip = environment.ok ? false : `needs python3 with numpy, opencv-python, pillow, scipy and blake3, and ffmpeg (${environment.reason}); run the row's get_it commands`;
const limits = join(folder, 'test', 'fixtures', 'limits-for-generated-videos.json');

test('the row runs a script that is in this folder', () => {
  const script = row.invoke.run.match(/tools\/check-a-rendered-video\/(\S+\.py)/)?.[1];
  assert.ok(script, 'the run command names a script');
  assert.ok(existsSync(join(folder, script)), `${script} exists`);
});

const runFile = file => new Promise(resolve => {
  const child = spawn('python3', [join(folder, 'test', 'run_tests.py'), file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, stderr }));
});

describe('every check passes its passing case and fails its failing case on generated videos', { concurrency: true }, () => {
  for (const file of readdirSync(join(folder, 'test')).filter(name => /^test_.*\.py$/.test(name)).sort()) {
    test(`${file} passes`, { skip }, async () => {
      const run = await runFile(file);
      assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
    });
  }
});

test('the command exits 2 and says so when there is nothing to check', { skip }, () => {
  const run = python(join(folder, 'do-work', 'check_a_rendered_video.py'), 'batch', join(folder, 'test', 'fixtures'), '--limits', limits);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no videos found/);
});

test('the command refuses to run without the person\'s limits', { skip }, () => {
  const run = python(join(folder, 'do-work', 'check_a_rendered_video.py'), 'check', join(folder, 'test', 'check_environment.py'));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /required: --limits/);
});
