/**
 * #209 Silence-removal / jump-cut: `do-work/detect-silence.mjs` finds silent intervals (ffmpeg silencedetect)
 * and emits their complement, the non-silent KEEP spans. Each keep span becomes a normal trimmed segment, so
 * removing silence renders through the EXISTING multi-segment spine with zero new render code (L069).
 *
 * Proof (L155), three layers:
 *  (1) PURE unit: keepSpansFromSilences complements silent intervals correctly (interior gap, edges, overlap, pad).
 *  (2) REAL detect: detectSilence on a loud/silence/loud clip finds exactly one silent interval in the middle.
 *  (3) OFFLINE RENDER: feed the keep spans as trimmed segments, render, and the output DURATION collapses from
 *      2.0s to the keep total (~1.2s), the middle 0.8s of silence is gone, and two renders are byte-identical.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepSpansFromSilences, detectSilence } from '../../do-work/detect-silence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
const dur = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'sil-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'sil-render-'));
  // LOUD (0.6s tone) + SILENCE (0.8s) + LOUD (0.6s tone) = 2.0s. The middle silence is what jump-cut removes.
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=2:r=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.6', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.8', '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.6',
    '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]', '-map', '0:v', '-map', '[a]',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

test('PURE unit: keepSpansFromSilences complements silent intervals (interior, edges, overlap, pad)', () => {
  // one interior silence, no pad => two keep spans on either side.
  assert.deepEqual(keepSpansFromSilences([{ start: 0.6, end: 1.4 }], 2, { pad: 0 }),
    [{ in: 0, out: 0.6 }, { in: 1.4, out: 2 }]);
  // silence at the head => single tail keep span.
  assert.deepEqual(keepSpansFromSilences([{ start: 0, end: 0.5 }], 2, { pad: 0 }), [{ in: 0.5, out: 2 }]);
  // no silence => the whole clip is one keep span.
  assert.deepEqual(keepSpansFromSilences([], 2, { pad: 0 }), [{ in: 0, out: 2 }]);
  // overlapping/unsorted silences are merged.
  assert.deepEqual(keepSpansFromSilences([{ start: 1.2, end: 1.6 }, { start: 1.0, end: 1.3 }], 2, { pad: 0 }),
    [{ in: 0, out: 1 }, { in: 1.6, out: 2 }]);
  // pad grows the keep spans INTO the silence on both sides (protects word onsets).
  assert.deepEqual(keepSpansFromSilences([{ start: 0.6, end: 1.4 }], 2, { pad: 0.05 }),
    [{ in: 0, out: 0.65 }, { in: 1.35, out: 2 }]);
});

test('REAL detect: silencedetect finds exactly the middle silent interval of a loud/silence/loud clip', () => {
  const { silences, duration } = detectSilence(clip, { thresholdDb: -40, minSilenceSec: 0.3 });
  assert.ok(Math.abs(duration - 2) < 0.15, `duration ~2s (${duration})`);
  assert.equal(silences.length, 1, `exactly one silent interval (${JSON.stringify(silences)})`);
  assert.ok(silences[0].start > 0.4 && silences[0].start < 0.8, `silence starts ~0.6s (${silences[0].start})`);
  assert.ok(silences[0].end > 1.2 && silences[0].end < 1.6, `silence ends ~1.4s (${silences[0].end})`);
});

test('OFFLINE RENDER: removing silence collapses 2.0s -> ~keep total, silence gone, deterministic (L155)', () => {
  // template EDL (one segment over the whole clip), then clone it into the keep spans as trimmed segments.
  const comp = composeTimeline({
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
      { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
    ] }], editDecisions: [], markers: [],
  });
  const base = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true }).edl;
  const seg0 = base.spine.segments[0];

  const { silences, duration } = detectSilence(clip, { thresholdDb: -40, minSilenceSec: 0.3 });
  const keep = keepSpansFromSilences(silences, duration, { pad: 0.02 });
  const keepTotal = keep.reduce((s, k) => s + (k.out - k.in), 0);
  assert.ok(keep.length === 2 && keepTotal < 1.5, `two keep spans totalling ~1.2s (${JSON.stringify(keep)})`);

  const buildEdl = (name) => {
    const edl = JSON.parse(JSON.stringify(base));
    edl.spine.segments = keep.map((k, i) => ({ ...seg0, id: `keep${i}`, in: k.in, out: k.out }));
    const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(f, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const cut = buildEdl('cut');
  const cut2 = buildEdl('cut2');

  // the whole point: the rendered timeline is shorter by the removed silence.
  const cutDur = dur(cut);
  assert.ok(cutDur < 1.5, `silence-removed render is shorter than the 2.0s original (${cutDur.toFixed(2)}s)`);
  assert.ok(Math.abs(cutDur - keepTotal) < 0.3, `render duration matches the keep total (${cutDur.toFixed(2)} vs ${keepTotal.toFixed(2)})`);

  assert.equal(hashFile(cut), hashFile(cut2), 'two silence-removed renders of the same keep spans are byte-identical');
});
