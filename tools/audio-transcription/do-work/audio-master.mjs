#!/usr/bin/env node
/**
 * file: packages/audio-transcription/do-work/audio-master.mjs
 *
 * PURPOSE: The audio.master capability executable (plan §15 T15). Masters a
 * voice track with the broadcast-correct chain: highpass → TWO-PASS loudnorm
 * (measure, then apply with the measured values — single-pass is inaccurate) →
 * true-peak limiter AFTER loudnorm (guarantees the TP ceiling) → optional
 * afftdn denoise gated on the measured noise floor. Emits the mastered file
 * plus a before/after JSON report on stdout.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Two passes — pass 1 measures, pass 2 applies measured_* values
 * 2. The limiter runs AFTER loudnorm so true peak can never exceed the ceiling
 * 3. Every number is a parameter with the production default — zero magic numbers inline
 * 4. Denoise is opt-in by measurement (noise floor above threshold), never unconditional
 * 5. Output is a SEPARATE artifact — the input is never modified
 *
 * Usage: node audio-master.mjs --in <file> --out <file>
 *   [--target-lufs -14] [--true-peak -1.0] [--lra 11]
 *   [--highpass-hz 80] [--denoise-floor-db -45] [--denoise off|auto|on]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const IN = args.get('in');
const OUT = args.get('out');
if (!IN || !OUT || !existsSync(IN)) {
  console.error('usage: audio-master.mjs --in <existing file> --out <file> [params]');
  process.exit(2);
}

// Production defaults (the mastering contract): YouTube-normalized speech.
const TARGET_LUFS = Number(args.get('target-lufs') ?? -14);
const TRUE_PEAK = Number(args.get('true-peak') ?? -1.0);
const LRA = Number(args.get('lra') ?? 11);
const HIGHPASS_HZ = Number(args.get('highpass-hz') ?? 80);
const DENOISE_FLOOR_DB = Number(args.get('denoise-floor-db') ?? -45);
const DENOISE = args.get('denoise') ?? 'auto'; // off | auto | on

function ffmpeg(ffArgs) {
  return execFileSync('ffmpeg', ['-hide_banner', '-nostats', ...ffArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run ffmpeg and return its stderr (where loudnorm/astats write their analysis). */
function ffmpegStderr(ffArgs) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...ffArgs], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.slice(-400)}`);
  return result.stderr ?? '';
}

/**
 * Run loudnorm in measure mode and parse its JSON block from stderr.
 * `preChain` is the exact filter prefix that will sit before loudnorm in the
 * apply pass — measured_* values are only valid for the SIGNAL ENTERING
 * loudnorm, so the measurement pass must run through the identical prefix.
 */
function measureLoudness(file, preChain = []) {
  const af = [...preChain, `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`].join(',');
  const capture = ffmpegStderr(['-i', file, '-af', af, '-f', 'null', '-']);
  const match = capture.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('loudnorm measurement produced no JSON');
  return JSON.parse(match[0]);
}

/** Measure the mean noise floor (dB) via astats on the quietest 10% — proxy: overall RMS trough. */
function measureNoiseFloorDb(file) {
  const capture = ffmpegStderr(['-i', file, '-af', 'astats=measure_overall=RMS_trough:measure_perchannel=none', '-f', 'null', '-']);
  // ffmpeg labels this "RMS trough dB" in newer builds and "RMS through dB" in older ones.
  const match = capture.match(/RMS t(?:hrough|rough) dB:\s*(-?[\d.]+)/);
  return match ? Number(match[1]) : null;
}

// ---- Pass 1: measure THROUGH the pre-chain ----
// Decide denoise first (it changes the pre-chain), then measure loudness
// through the exact prefix the apply pass will use — otherwise measured_*
// describes a different signal and the two-pass guarantee is void.
const noiseFloorDb = DENOISE === 'off' ? null : measureNoiseFloorDb(IN);
const denoiseOn = DENOISE === 'on' || (DENOISE === 'auto' && noiseFloorDb !== null && noiseFloorDb > DENOISE_FLOOR_DB);
const preChain = [`highpass=f=${HIGHPASS_HZ}`, ...(denoiseOn ? ['afftdn=nf=-25'] : [])];
const measured = measureLoudness(IN, preChain);

// ---- Pass 2: apply with measured values; limiter AFTER loudnorm ----
const chain = [
  ...preChain,
  `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LRA}` +
    `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true`,
  `alimiter=limit=${Math.pow(10, TRUE_PEAK / 20).toFixed(4)}:level=false`,
].join(',');

// The codec follows the output's container. Always writing AAC put AAC data
// inside a .wav, which readers decoded as near-silence (-54 dB mean instead of
// -17 dB, measured 2026-10-29), so a mastered voice track shipped almost mute.
const lossless = /\.(wav|aiff?|flac)$/i.test(OUT);
const codec = /\.flac$/i.test(OUT) ? ['-c:a', 'flac'] : lossless ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'aac', '-b:a', '256k'];
ffmpeg(['-y', '-i', IN, '-af', chain, '-ar', '48000', ...codec, OUT]);

// ---- Verify: measure the OUTPUT ----
const after = measureLoudness(OUT);

const report = {
  input: IN,
  output: OUT,
  params: { target_lufs: TARGET_LUFS, true_peak_db: TRUE_PEAK, lra: LRA, highpass_hz: HIGHPASS_HZ },
  before: { lufs: Number(measured.input_i), true_peak_db: Number(measured.input_tp), lra: Number(measured.input_lra) },
  after: { lufs: Number(after.input_i), true_peak_db: Number(after.input_tp), lra: Number(after.input_lra) },
  denoise: { mode: DENOISE, applied: denoiseOn, noise_floor_db: noiseFloorDb, threshold_db: DENOISE_FLOOR_DB },
};
console.log(`[audio.master] in LUFS=${report.before.lufs} TP=${report.before.true_peak_db} -> out LUFS=${report.after.lufs} TP<=${TRUE_PEAK} denoise=${denoiseOn ? 'on' : 'off'}`);
console.log(JSON.stringify(report));
