// Runs the cutter's own tests (test/run_tests.py: made-up recordings drawn by ffmpeg, a stand-in renderer, face reader,
// checker and speaker) and checks its rows name the script that exists and run on the person's computer.
// Needs python3 with numpy, soundfile, Pillow and blake3, and ffmpeg; without them the run test skips and says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const python = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const environment = JSON.parse(python(join(here, 'check_environment.py')).stdout.trim().split('\n').pop());
const skip = environment.ok ? false : `needs python3 with numpy, soundfile, Pillow and blake3, and ffmpeg (${environment.reason}); run the row's get_it commands`;

test('every row runs the one script on the person\'s computer', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:assemble-a-plan-into-a-cut', 'tool:voice-the-lines-of-my-plans', 'tool:regroup-a-plans-segments',
    'tool:apply-new-titles-to-my-plans', 'tool:string-my-cuts-into-one-reel']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    assert.match(row.invoke.run, /^python3 tools\/assemble-a-plan-into-a-cut\/do-work\/assemble\.py /);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(row.licence_class, 'licence:maker-own');
  }
  assert.ok(existsSync(join(folder, 'do-work', 'assemble.py')));
});

test('a cut and a reel are rendered by the Workshop tool media-composition, which the rows name', () => {
  for (const id of ['tool:assemble-a-plan-into-a-cut', 'tool:string-my-cuts-into-one-reel']) {
    assert.ok(rows.find(row => row.id === id).invoke.needs.some(need => need.includes('tools/media-composition')), id);
  }
  for (const script of ['render-an-edit.mjs', 'match-shots.mjs']) assert.ok(existsSync(join(folder, '..', 'media-composition', 'do-work', script)), script);
});

test('the cutter keeps its promises on made-up recordings', { skip, timeout: 900000 }, () => {
  const run = python(join(here, 'run_tests.py'));
  const summary = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true, JSON.stringify(summary.failures, null, 1) + run.stderr.slice(-3000));
  assert.ok(summary.ran >= 28, `${summary.ran} tests ran`);
});
