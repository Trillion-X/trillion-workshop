// The colour grade files are supplied by the account and are not in this repository. A look that needs one stops
// with words that say so, never a stack trace; a look that needs none still renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const grade = fileURLToPath(new URL('../do-work/grade-a-video.mjs', import.meta.url));
const luts = fileURLToPath(new URL('../read-data/luts', import.meta.url));
const available = ['ffprobe', 'ffmpeg'].every(name => spawnSync(name, ['-version']).status === 0);

test('a look whose grade file the account has not supplied stops with a clear message', { skip: !available || existsSync(luts) }, () => {
  const work = mkdtempSync(join(tmpdir(), 'grade-'));
  try {
    const video = join(work, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', '-pix_fmt', 'yuv420p', video]);
    const run = spawnSync(process.execPath, [grade, '--video', video, '--output', join(work, 'graded.mp4'), '--looks', 'teal-and-orange'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /grade-teal-and-orange needs read-data\/luts\/06-color-wheels-teal-orange\.cube, which the account supplies; it is not in this repository/);
    assert.doesNotMatch(run.stderr, /^\s+at |file:\/\/|throw new Error/m, 'no stack trace and no source line');

    const plain = spawnSync(process.execPath, [grade, '--video', video, '--output', join(work, 'brighter.mp4'), '--brightness', '0.1'], { encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(plain.stdout.trim().split('\n').at(-1)).width, 160);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
