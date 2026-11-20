/**
 * #226 Aligned side-by-side (the mission's you-vs-Federer swing): compose align-clips with the split segment so
 * the two clips' contact moments COINCIDE in a phase-locked side-by-side. Zero new render code (L069): alignment
 * is per-source `in` (video-compose supports it) and the layout is the existing split.
 *
 * Proof (L155, definitive offline render): two clips, each a gray frame with a full-frame WHITE FLASH plus an
 * audio CLICK at its "contact" (A at 0.8s, B at 1.3s, a real 0.5s misalignment). authorAlignedSplit aligns by
 * the audio contact and sets each source's `in` so the flashes line up. In the rendered h-split, there is an
 * output frame where BOTH halves are white at once (the synced contact), i.e. max over frames of
 * min(leftLuma, rightLuma) is high. A control split with NO alignment (both in=0) never has both halves bright at
 * once (the flashes fall at different output times), so its min-of-halves peak is far lower. Fabricated DATA
 * could not make two real renders flash together.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAlignedSplit } from '../../do-work/author-aligned-split.mjs';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
let work, clipA, clipB;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
// a gray clip with a full-frame white flash + an audio click at `contact` seconds.
function flashClip(file, contact) {
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=3:r=24',
    '-f', 'lavfi', '-i', `aevalsrc=exprs='0.9*sin(1000*2*PI*t)*lt(abs(t-${contact}),0.03)':d=3:s=22050`,
    '-filter_complex', `[0]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${contact},${contact}+0.08)'[v]`,
    '-map', '[v]', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
}
// per-frame YAVG of one half of the video ('l' = left, 'r' = right), in frame order.
function halfLumas(file, side) {
  const x = side === 'l' ? '0' : 'iw/2';
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `fps=10,crop=iw/2:ih:${x}:0,signalstats,metadata=print:file=-`, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const vals = []; const re = /signalstats\.YAVG=([0-9.]+)/g; let m;
  while ((m = re.exec(out)) !== null) vals.push(Number(m[1]));
  return vals;
}
// render an EDL with one split segment; return the max over frames of min(leftLuma, rightLuma).
function renderAndPeakBoth(seg, name) {
  const edl = { base: { color: 'black' }, tracks: [], spine: { segments: [seg] }, encode: { width: 640, height: 240, fps: 24 } };
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  const L = halfLumas(out, 'l'), R = halfLumas(out, 'r');
  let best = 0;
  for (let i = 0; i < Math.min(L.length, R.length); i += 1) best = Math.max(best, Math.min(L[i], R[i]));
  return best;
}

before(() => {
  work = tempFolder(join(tmpdir(), 'abs-'));
  clipA = join(work, 'A.mp4'); flashClip(clipA, 0.8);
  clipB = join(work, 'B.mp4'); flashClip(clipB, 1.3);
});

test('authorAlignedSplit emits a split whose per-source in trims phase-lock the contacts (~0.5s offset)', () => {
  const seg = authorAlignedSplit(clipA, clipB, { lead: 0.5, durationSec: 1.5, layout: 'h', labelA: 'You', labelB: 'Federer' });
  assert.equal(seg.kind, 'split');
  assert.equal(seg.layout, 'h');
  assert.equal(seg.sources.length, 2);
  assert.ok(Math.abs(seg.alignment.offset - (-0.5)) < 0.08, `measured offset ~ -0.5 (${seg.alignment.offset})`);
  // both contacts land `lead` (0.5s) into their trimmed cells -> they coincide.
  assert.ok(Math.abs((seg.alignment.eventA - seg.sources[0].in) - 0.5) < 0.05, 'A contact is 0.5s into its cell');
  assert.ok(Math.abs((seg.alignment.eventB - seg.sources[1].in) - 0.5) < 0.05, 'B contact is 0.5s into its cell');
  assert.equal(seg.sources[0].label.text, 'You');
  assert.equal(seg.sources[1].label.text, 'Federer');
});

test('OFFLINE RENDER: aligned split flashes BOTH halves together; an unaligned split does not (L155)', () => {
  const aligned = authorAlignedSplit(clipA, clipB, { lead: 0.5, durationSec: 1.5, layout: 'h' });
  const control = { kind: 'split', layout: 'h', duration: 1.5, sources: [{ source: clipA, in: 0, out: 1.5 }, { source: clipB, in: 0, out: 1.5 }] };

  const alignedPeak = renderAndPeakBoth(aligned, 'aligned');
  const controlPeak = renderAndPeakBoth(control, 'control');

  assert.ok(alignedPeak > 200, `aligned: both halves flash together (min-of-halves peak ${alignedPeak.toFixed(1)})`);
  assert.ok(alignedPeak > controlPeak + 80, `alignment made the contacts coincide vs unaligned (${alignedPeak.toFixed(1)} vs ${controlPeak.toFixed(1)})`);
});
