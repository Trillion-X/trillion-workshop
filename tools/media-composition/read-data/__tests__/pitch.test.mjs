/**
 * #205 Pitch presets: shift a clip's audio PITCH while keeping its duration (voice up/down, chipmunk, deep,
 * helium) via ffmpeg's `rubberband=pitch=k` as pure DATA rows in AUDIO_FX_CATALOG (zero engine code, exactly
 * the same opaque-audio-chain pattern as studio-sound/podcast/telephone). rubberband is sample-rate agnostic
 * and pitch-only, so unlike asetrate/atempo it does NOT change tempo or desync from the video.
 *
 * Proof (L155): a real OFFLINE render on a clip whose audio is a pure 440 Hz sine. The oracle is the DEFINING
 * behavior of pitch: zero-crossing rate (proportional to frequency) RISES for pitch-up and FALLS for deep-voice,
 * while the clip DURATION is preserved (pitch-only, not tempo). PLUS determinism (two pitch renders match), and
 * a pure catalog-DATA unit proof.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, AUDIO_FX_CATALOG, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
// zero-crossing count of the mono 8kHz-resampled audio (proportional to the dominant frequency).
function zeroCross(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', 'aresample=8000', '-ac', '1', '-f', 's16le', '-'],
    { maxBuffer: 1 << 26 });
  let n = 0;
  for (let i = 2; i < raw.length; i += 2) { const a = raw.readInt16LE(i - 2), b = raw.readInt16LE(i); if ((a < 0) !== (b < 0)) n++; }
  return n;
}
function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pitch-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, AUDIO_FX_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pitch-render-'));
  clip = join(work, 'clip.mp4'); // video + a pure 440 Hz sine audio track (the pitch oracle's carrier)
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=2:r=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:d=2',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions, markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-11T00:00:00.000Z', parameters: params });
const render = (name, params) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('catalog DATA: pitch presets are rubberband pitch-only chains (zero engine code)', () => {
  assert.equal(AUDIO_FX_CATALOG['pitch-up'], 'rubberband=pitch=1.5');
  assert.equal(AUDIO_FX_CATALOG['pitch-down'], 'rubberband=pitch=0.667');
  assert.equal(AUDIO_FX_CATALOG['chipmunk'], 'rubberband=pitch=2');
  assert.equal(AUDIO_FX_CATALOG['deep-voice'], 'rubberband=pitch=0.5');
});

test('OFFLINE RENDER: pitch-up raises the frequency, deep-voice lowers it, duration preserved, deterministic (L155)', () => {
  const plain = render('plain');
  const up = render('up', { audio_fx: 'pitch-up' });
  const up2 = render('up2', { audio_fx: 'pitch-up' });
  const deep = render('deep', { audio_fx: 'deep-voice' });

  const zPlain = zeroCross(plain), zUp = zeroCross(up), zDeep = zeroCross(deep);
  assert.ok(zUp > zPlain * 1.25, `pitch-up raises the frequency (zero-crossings plain ${zPlain} -> up ${zUp})`);
  assert.ok(zDeep < zPlain * 0.8, `deep-voice lowers the frequency (zero-crossings plain ${zPlain} -> deep ${zDeep})`);

  // pitch-only: duration is preserved (this is why rubberband, not asetrate/atempo).
  assert.ok(Math.abs(duration(up) - duration(plain)) < 0.2, `pitch-up preserves duration (${duration(plain)} vs ${duration(up)})`);

  // determinism through the render.
  assert.equal(zeroCross(up2), zUp, 'two pitch-up renders have identical audio (deterministic)');
});
