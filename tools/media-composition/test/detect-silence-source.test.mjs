// find-silence (do-work/detect-silence.mjs) must fail with a named error for a source it cannot read. A missing or empty
// file used to come back as an answer with duration 0 and no silences, which looked like a clean recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectSilence } from '../do-work/detect-silence.mjs';

const script = resolve(import.meta.dirname, '..', 'do-work', 'detect-silence.mjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('a missing source fails with source_not_readable, not an empty answer', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'silence-')), 'absent.mp4');
  const run = spawnSync(process.execPath, [script, missing], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(run.stderr).error, 'source_not_readable');
  assert.throws(() => detectSilence(missing), error => error.code === 'source_not_readable');
});

test('an empty file fails with source_not_readable', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'silence-')), 'empty.mp4');
  writeFileSync(empty, '');
  const run = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).error, 'source_not_readable');
});

test('a clip with a quiet gap reports that gap as a silence', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  const clip = join(mkdtempSync(join(tmpdir(), 'silence-')), 'gap.wav');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,1)+gte(t\\,2.5)\\,0.5*sin(2*PI*440*t)\\,0):d=4:s=16000', clip]);
  assert.equal(made.status, 0);
  const found = detectSilence(clip, { thresholdDb: -30, minSilenceSec: 0.5 });
  assert.ok(found.duration > 3.9 && found.duration < 4.1, `duration ${found.duration}`);
  assert.equal(found.silences.length, 1);
  assert.ok(Math.abs(found.silences[0].start - 1) < 0.1 && Math.abs(found.silences[0].end - 2.5) < 0.1, JSON.stringify(found.silences));
});
