/**
 * #223 Loudness QC PRODUCER (measure-loudness.mjs): the publish-readiness gate. Measures a finished file's
 * integrated loudness (LUFS) + true peak (dBFS) with ffmpeg ebur128, and a pure gate decides whether it hits the
 * platform target (~-14 LUFS, no clipping). PRODUCER only: the FIX is the existing #93 master loudnorm, so zero
 * new render code (L069). Measure (impure) split from gate (pure).
 *
 * Proof (L155, exact ground truth): a source and a copy attenuated by EXACTLY -20 dB. Loudness is defined so a
 * -20 dB gain lowers integrated LUFS by ~20 (and true peak by ~20), which the measurement recovers within ~1 LU
 * (a value that could not be faked). The louder file reads louder. The pure gate flags too-loud / too-quiet /
 * clipping / unmeasured. A file normalized to the -14 target passes the gate end to end.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudness, measureLoudnessAsync, loudnessGate, checkPublishLoudness } from '../../do-work/measure-loudness.mjs';

let work, loud, quiet, atTarget;
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

before(() => {
  work = tempFolder(join(tmpdir(), 'loud-'));
  loud = join(work, 'loud.m4a'); ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:d=3', '-c:a', 'aac', loud]);
  quiet = join(work, 'quiet.m4a'); ffmpeg(['-i', loud, '-af', 'volume=-20dB', '-c:a', 'aac', quiet]);   // exactly -20 dB down
  atTarget = join(work, 'target.m4a'); ffmpeg(['-i', loud, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', atTarget]); // normalized to -14 LUFS
});

test('a -20 dB attenuation lowers measured LUFS and true peak by ~20 (exact ground truth, L155)', () => {
  const L = measureLoudness(loud), Q = measureLoudness(quiet);
  assert.ok(L.integrated_lufs < 0 && L.integrated_lufs > -40, `loud integrated in range (${L.integrated_lufs})`);
  assert.ok(Math.abs((L.integrated_lufs - Q.integrated_lufs) - 20) < 1.2, `-20 dB drops LUFS by ~20 (${L.integrated_lufs} -> ${Q.integrated_lufs})`);
  assert.ok(Math.abs((L.true_peak_dbfs - Q.true_peak_dbfs) - 20) < 1.5, `-20 dB drops true peak by ~20 (${L.true_peak_dbfs} -> ${Q.true_peak_dbfs})`);
  assert.ok(L.integrated_lufs > Q.integrated_lufs, 'the louder file reads louder');
});

test('pure gate: flags too-loud / too-quiet / clipping / unmeasured; passes an in-spec file', () => {
  assert.deepEqual(loudnessGate({ integrated_lufs: -14, true_peak_dbfs: -3 }), { ok: true, reasons: [] });
  assert.deepEqual(loudnessGate({ integrated_lufs: -6, true_peak_dbfs: -3 }).reasons, ['too-loud']);
  assert.deepEqual(loudnessGate({ integrated_lufs: -25, true_peak_dbfs: -3 }).reasons, ['too-quiet']);
  assert.deepEqual(loudnessGate({ integrated_lufs: -14, true_peak_dbfs: 0.5 }).reasons, ['true-peak-clipping']);
  assert.deepEqual(loudnessGate({ integrated_lufs: null, true_peak_dbfs: null }).reasons, ['loudness-unmeasured']);
});

test('OFFLINE: a file normalized to the -14 target passes the publish gate (tolerance 2 LU)', () => {
  const res = checkPublishLoudness(atTarget, { targetLufs: -14, tolerance: 2, maxTruePeak: -1 });
  assert.ok(Math.abs(res.integrated_lufs - (-14)) < 2, `normalized file is ~-14 LUFS (${res.integrated_lufs})`);
  assert.equal(res.ok, true, `in-spec file passes the gate (${JSON.stringify(res.reasons)})`);
});

test('the non-blocking measurement reads the same summary as the blocking one, and a missing file rejects', async () => {
  const blocking = measureLoudness(loud), async_ = await measureLoudnessAsync(loud);
  assert.deepEqual(async_, blocking);
  await assert.rejects(measureLoudnessAsync(join(work, 'missing.m4a')));
});
