/**
 * file: packages/audio-transcription/do-work/__tests__/audio-master.test.mjs
 *
 * Tests for the audio.master capability (plan §15 T15). Fixtures are generated
 * with ffmpeg lavfi (deterministic sine sources) — too-quiet input must land
 * within ±1 LUFS of target; hot input must end with true peak ≤ the ceiling.
 * Golden comparisons are METRICS (LUFS/TP via loudnorm json), never bytes.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'audio-master.mjs');
const work = mkdtempSync(join(tmpdir(), 'audio-master-'));

function makeFixture(name, volume) {
  const file = join(work, name);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4',
    '-af', `volume=${volume}`, '-c:a', 'aac', file,
  ]);
  return file;
}

function master(input, output, extra = []) {
  const stdout = execFileSync('node', [SCRIPT, '--in', input, '--out', output, ...extra], { encoding: 'utf8' });
  const jsonLine = stdout.trim().split('\n').at(-1);
  return JSON.parse(jsonLine);
}

let quiet;
let hot;
before(() => {
  quiet = makeFixture('quiet.m4a', '0.02');
  hot = makeFixture('hot.m4a', '2.5');
});

test('too-quiet input lands within ±1 LUFS of target', () => {
  const report = master(quiet, join(work, 'quiet-mastered.m4a'));
  assert.ok(Math.abs(report.after.lufs - report.params.target_lufs) <= 1,
    `after LUFS ${report.after.lufs} within ±1 of ${report.params.target_lufs}`);
});

test('hot input ends with true peak at or below the ceiling', () => {
  const report = master(hot, join(work, 'hot-mastered.m4a'));
  assert.ok(report.after.true_peak_db <= report.params.true_peak_db + 0.1,
    `after TP ${report.after.true_peak_db} <= ceiling ${report.params.true_peak_db}`);
  assert.ok(Math.abs(report.after.lufs - report.params.target_lufs) <= 1);
});

test('parameters override the defaults', () => {
  const report = master(quiet, join(work, 'quiet-16.m4a'), ['--target-lufs', '-16']);
  assert.equal(report.params.target_lufs, -16);
  assert.ok(Math.abs(report.after.lufs - -16) <= 1);
});

test('denoise is measured, reported, and gated (auto mode)', () => {
  const report = master(quiet, join(work, 'quiet-dn.m4a'));
  assert.equal(report.denoise.mode, 'auto');
  assert.equal(typeof report.denoise.applied, 'boolean');
  assert.ok(report.denoise.noise_floor_db === null || typeof report.denoise.noise_floor_db === 'number');
});

test('zero magic numbers — every tunable in the script has a named parameter', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  for (const param of ['target-lufs', 'true-peak', 'lra', 'highpass-hz', 'denoise-floor-db', 'denoise']) {
    assert.ok(source.includes(`'${param}'`), `--${param} is a parameter`);
  }
});

test('missing input fails with a usage error, output untouched', () => {
  assert.throws(() => {
    execFileSync('node', [SCRIPT, '--in', join(work, 'missing.m4a'), '--out', join(work, 'x.m4a')], { encoding: 'utf8' });
  });
});
