/**
 * #218 Clip-alignment (multi-source sync by a shared event): measure the strongest audio transient in two clips
 * and emit the per-clip `in` trims that make the events coincide, so a side-by-side plays the two swings in
 * phase. Zero new render code (L069): the alignment is just each clip's existing `segment.in` trim, which
 * video-compose applies as `-ss`. Shared onset envelope + PCM extraction with the beat producer (SSOT).
 *
 * Proof (L155, offline render with known ground truth): clip A has a loud click at 0.8s over a quiet tone, clip
 * B has the same click at 1.3s (a real 0.5s misalignment). (1) computeAlignmentOffset recovers offset ~ -0.5.
 * (2) OFFLINE RENDER: apply alignTrims(lead=0.5) as each clip's `segment.in`, render both through video-compose,
 * and re-detect the click in each rendered output: BOTH now land at ~0.5s (aligned within a couple frames),
 * whereas the RAW clips' events differ by ~0.5s. Fabricated data could not make a real render's transients
 * coincide. PLUS determinism.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAlignmentOffset, alignTrims, alignClips, detectStrongestOnset } from '../../do-work/align-clips.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 240, H = 160, FPS = 24;
let composeTimeline, materializeExportEdl, work, clipA, clipB;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
// a quiet 300 Hz bed with one loud 1200 Hz click at `at` seconds (a clap / racket contact), 3s, with video.
function clickClip(file, at) {
  ffmpeg(['-f', 'lavfi', '-i', `color=teal:s=${W}x${H}:d=3:r=${FPS}`,
    '-f', 'lavfi', '-i', `aevalsrc=exprs='0.2*sin(300*2*PI*t)+0.9*sin(1200*2*PI*t)*lt(abs(t-${at}),0.02)':d=3:s=22050`,
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'align-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'align-render-'));
  clipA = join(work, 'a.mp4'); clickClip(clipA, 0.8);
  clipB = join(work, 'b.mp4'); clickClip(clipB, 1.3);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 3, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
// render one clip trimmed to start at `inSec` (the alignment trim), return the rendered path.
const renderTrimmed = (src, name, inSec) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => src, { width: W, height: H, fps: FPS, deterministic: true });
  edl.spine.segments[0].in = inSec;            // the alignment trim (video-compose applies -ss)
  edl.spine.segments[0].out = inSec + 1.2;     // equal-length aligned windows
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('PURE: computeAlignmentOffset recovers the ~0.5s misalignment; alignTrims maps events to the lead', () => {
  const { eventA, eventB, offset } = computeAlignmentOffset(clipA, clipB);
  assert.ok(Math.abs(eventA - 0.8) < 0.08, `event A ~0.8s (${eventA})`);
  assert.ok(Math.abs(eventB - 1.3) < 0.08, `event B ~1.3s (${eventB})`);
  assert.ok(Math.abs(offset - (-0.5)) < 0.08, `offset ~ -0.5s (${offset})`);
  const { aIn, bIn } = alignTrims(eventA, eventB, { lead: 0.5 });
  assert.ok(Math.abs((eventA - aIn) - 0.5) < 1e-9 && Math.abs((eventB - bIn) - 0.5) < 1e-9, 'both events land 0.5s into the trimmed clip');
});

test('OFFLINE RENDER: applying the trims aligns the click to the same time in both clips (L155)', () => {
  // raw clips are genuinely out of phase.
  const rawA = detectStrongestOnset(clipA), rawB = detectStrongestOnset(clipB);
  assert.ok(Math.abs(rawA - rawB) > 0.35, `raw clips are misaligned (${rawA} vs ${rawB})`);

  const { aIn, bIn } = alignClips(clipA, clipB, { lead: 0.5 });
  const outA = renderTrimmed(clipA, 'alignedA', aIn);
  const outB = renderTrimmed(clipB, 'alignedB', bIn);

  const eA = detectStrongestOnset(outA), eB = detectStrongestOnset(outB);
  assert.ok(Math.abs(eA - 0.5) < 0.08, `aligned A click at ~0.5s (${eA})`);
  assert.ok(Math.abs(eB - 0.5) < 0.08, `aligned B click at ~0.5s (${eB})`);
  assert.ok(Math.abs(eA - eB) < 0.08, `the two clicks now coincide (${eA} vs ${eB})`);
});

test('determinism: alignment measurement is stable across runs', () => {
  assert.deepEqual(alignClips(clipA, clipB, { lead: 0.5 }), alignClips(clipA, clipB, { lead: 0.5 }));
});
