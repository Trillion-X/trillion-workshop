/**
 * #210 Transcript-FREE one-click "remove silence": bridge #209's AUDIO silence detection into the SHIPPED
 * remove-span cleanup path. Transcript silence removal already ships (read-data/auto-cleanup.ts: detect gaps
 * between WORD records -> CleanupSpan -> cleanupSpansInAuthorOrder -> remove-span decisions -> the remove-span
 * fold ripples the timeline closed). auto-cleanup needs a transcript; #209 detect-silence needs only the raw
 * audio. `silencesToCleanupSpans` maps audio silences into the SAME CleanupSpan shape, so audio-only clips get
 * the identical one-click cleanup through the EXISTING author ordering + fold. ZERO new author/render code
 * (L069: both silence sources converge on the one remove-span primitive; this test rebuilds nothing).
 *
 * Proof (L155): a real clip with TWO silent gaps. detectSilence (audio) -> silencesToCleanupSpans -> the
 * SHIPPED cleanupSpansInAuthorOrder (descending by start, so each ripple keeps earlier coords valid) -> author
 * remove-span decisions -> composeTimeline applies the SHIPPED remove-span fold. Assert (a) the compose model
 * duration collapses by exactly the removed length, and (b) a REAL offline render is that much shorter and
 * byte-deterministic.
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
import { detectSilence, silencesToCleanupSpans } from '../../do-work/detect-silence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, cleanupSpansInAuthorOrder, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
const durOf = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
// remove-span decision in the canonical shape composeTimeline consumes (mirrors fold-remove-span.test.mjs).
const removeSpan = (s) => ({ action: 'remove-span', parameters: { start: s.start, end: s.end }, span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-12T00:00:00.000Z', label: 'remove-span' });

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'brg-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs'); const ac = join(dir, 'ac.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'auto-cleanup.ts'), `--outfile=${ac}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
  ({ cleanupSpansInAuthorOrder } = await import(ac));

  work = tempFolder(join(tmpdir(), 'brg-render-'));
  // loud(0.5) + SIL(0.6) + loud(0.5) + SIL(0.6) + loud(0.5) = 2.7s, two silent gaps to exercise the ordering.
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=2.7:r=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.5',
    '-filter_complex', '[1:a][2:a][3:a][4:a][5:a]concat=n=5:v=0:a=1[a]', '-map', '0:v', '-map', '[a]',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2.7, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions, markers: [],
});

test('audio silences -> shipped cleanup ordering + remove-span fold collapses the compose model (transcript-free)', () => {
  const { silences } = detectSilence(clip, { thresholdDb: -40, minSilenceSec: 0.3 });
  assert.equal(silences.length, 2, `two silent gaps detected (${JSON.stringify(silences)})`);
  const spans = cleanupSpansInAuthorOrder(silencesToCleanupSpans(silences, { pad: 0.02 })); // SHIPPED ordering (right-to-left)
  assert.ok(spans.length === 2 && spans[0].start > spans[1].start, 'author order is descending by start (ripple-safe)');
  const removed = spans.reduce((s, x) => s + (x.end - x.start), 0);

  const comp = composeTimeline(view(spans.map(removeSpan)));
  const full = composeTimeline(view([]));
  // the shipped remove-span fold shortens the timeline by exactly the removed length.
  assert.ok(Math.abs((full.durationSeconds - comp.durationSeconds) - removed) < 0.05,
    `model collapsed by the removed length (full ${full.durationSeconds.toFixed(2)} - cut ${comp.durationSeconds.toFixed(2)} ~= ${removed.toFixed(2)})`);
});

test('OFFLINE RENDER: transcript-free silence removal produces a shorter, deterministic video (L155)', () => {
  const { silences } = detectSilence(clip, { thresholdDb: -40, minSilenceSec: 0.3 });
  const spans = cleanupSpansInAuthorOrder(silencesToCleanupSpans(silences, { pad: 0.02 }));
  const removed = spans.reduce((s, x) => s + (x.end - x.start), 0);

  const buildRender = (name, decisions) => {
    const comp = composeTimeline(view(decisions));
    const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
    const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(f, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const full = buildRender('full', []);
  const cut = buildRender('cut', spans.map(removeSpan));
  const cut2 = buildRender('cut2', spans.map(removeSpan));

  const fullDur = durOf(full), cutDur = durOf(cut);
  assert.ok(fullDur - cutDur > removed - 0.25, `render collapsed by ~the removed silence (full ${fullDur.toFixed(2)} -> cut ${cutDur.toFixed(2)}, removed ~${removed.toFixed(2)})`);
  assert.ok(cutDur < fullDur - 0.8, 'the silence-removed render is clearly shorter');
  assert.equal(hashFile(cut), hashFile(cut2), 'two transcript-free silence-removed renders are byte-identical');
});
