import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestPosterTime, scoreFrames } from '../do-work/pick-poster-frame.mjs';

const maker = fileURLToPath(new URL('../do-work/save-cover-frame.mjs', import.meta.url));
const available = ['ffprobe', 'ffmpeg'].every(name => spawnSync(name, ['-version']).status === 0);

// A WebM written to a pipe carries no duration: one black second, then two seconds of a test picture.
function unknownDurationWebm(directory) {
  const path = join(directory, 'unknown-duration.webm');
  writeFileSync(path, execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=10:d=1[a];testsrc2=s=160x90:r=10:d=2[b];[a][b]concat=n=2:v=1:a=0', '-c:v', 'libvpx', '-b:v', '200k', '-f', 'webm', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 }));
  return path;
}

test('an unknown-duration WebM chooses a readable scene after its black opening', { skip: !available }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'cover-frame-'));
  try {
    const fixture = unknownDurationWebm(directory);
    const duration = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fixture], { encoding: 'utf8' }).trim();
    assert.equal(duration, 'N/A', 'the fixture exercises the unknown-duration path');
    const frames = scoreFrames(fixture);
    assert.equal(frames.find(frame => frame.t === 0)?.score, 0);
    assert.ok(frames.some(frame => frame.t > 0 && frame.score > 0));
    assert.ok(bestPosterTime(fixture).t > 0);
    const output = join(directory, 'cover.jpg');
    const made = JSON.parse(execFileSync(process.execPath, [maker, '--video', fixture, '--output', output, '--width', '160'], { encoding: 'utf8' }));
    const jpeg = readFileSync(output);
    assert.ok(made.time > 0, 'the black opening frame was not chosen');
    assert.equal(made.chosen_by, 'sharpness and exposure');
    assert.equal(made.width, 160);
    assert.equal(made.height, 90);
    assert.equal(made.bytes, jpeg.byteLength);
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
