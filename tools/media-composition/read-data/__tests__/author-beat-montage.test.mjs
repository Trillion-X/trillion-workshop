/**
 * #228 Beat-synced multi-clip montage (author-beat-montage.mjs): map N clips onto the intervals between beat cut
 * times so every clip change lands ON the beat (the music montage). Composes detect-beats (#217) + beat-sync cut
 * selection + the existing `clip` segment; zero new render code (L069): a montage is a spine of trimmed clip
 * segments the compositor concats, and WHERE the cuts fall is DATA (the beat list).
 *
 * Proof (L155, definitive offline render):
 *  1. PURE: montageSegments maps cut times to trimmed clip segments (durations = intervals; clips cycle; zero-
 *     length skipped).
 *  2. RENDER: three distinct-color clips over cuts [0,0.5,1,1.5] render to a video whose visible color changes
 *     EXACTLY at the cut times (red in [0,0.5), green in [0.5,1), blue in [1,1.5)), so the clip cut is on the beat.
 *  3. FULL CHAIN: a real 120 BPM click track, detect-beats, those beats as cuts, montage; the color still cycles
 *     per interval, proving the beat producer drives the montage end to end.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { montageSegments, authorBeatMontage } from '../../do-work/author-beat-montage.mjs';
import { detectBeats } from '../../do-work/detect-beats.mjs';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
const W = 160, H = 120, FPS = 24;
let work, red, green, blue, click;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
function colorClip(file, c) { ffmpeg(['-f', 'lavfi', '-i', `color=c=${c}:size=${W}x${H}:duration=3:rate=${FPS}`, '-pix_fmt', 'yuv420p', file]); }
// dominant channel index (0=R,1=G,2=B) of the output frame at time t.
function dominantAt(file, t) {
  const png = join(work, `p-${t}-${Math.random().toString(36).slice(2)}.png`);
  ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const rgb = execFileSync('/opt/homebrew/anaconda3/bin/python3', ['-c',
    `from PIL import Image;print(*Image.open('${png}').convert('RGB').getpixel((${W >> 1},${H >> 1})))`], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  return rgb.indexOf(Math.max(...rgb));
}
function render(edl, name) {
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
}

before(() => {
  work = tempFolder(join(tmpdir(), 'montage-'));
  red = join(work, 'red.mp4'); colorClip(red, 'red');
  green = join(work, 'green.mp4'); colorClip(green, 'green');
  blue = join(work, 'blue.mp4'); colorClip(blue, 'blue');
  click = join(work, 'click.m4a');
  ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=exprs='sin(1000*2*PI*t)*lt(mod(t,0.5),0.04)':d=3:s=22050`, '-c:a', 'aac', click]); // 120 BPM
});

test('PURE: montageSegments maps cut times to trimmed clip segments; clips cycle; zero-length skipped', () => {
  const segs = montageSegments([red, green, blue], [0, 0.5, 1.0, 1.5]);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.source, s.in, s.out]), [[red, 0, 0.5], [green, 0, 0.5], [blue, 0, 0.5]]);
  // more intervals than clips cycles; a duplicate cut time yields a zero-length interval that is skipped.
  const cyc = montageSegments([red, green], [0, 1, 1, 2, 3]);
  assert.deepEqual(cyc.map((s) => s.source), [red, green, red]);
});

test('OFFLINE RENDER: the montage color changes EXACTLY at the cut times (cuts land on the beat) (L155)', () => {
  const out = render(authorBeatMontage([red, green, blue], [0, 0.5, 1.0, 1.5], { width: W, height: H, fps: FPS }), 'grid');
  assert.equal(dominantAt(out, 0.25), 0, 'red in the first interval');
  assert.equal(dominantAt(out, 0.75), 1, 'green in the second interval');
  assert.equal(dominantAt(out, 1.25), 2, 'blue in the third interval');
});

test('FULL CHAIN: detect-beats then montage; the color cycles per detected-beat interval', () => {
  const beats = detectBeats(click).beats;
  assert.ok(beats.length >= 3, `detected beats (${beats.length})`);
  const cuts = beats.slice(0, 4);                         // three intervals from the first four beats
  const out = render(authorBeatMontage([red, green, blue], cuts, { width: W, height: H, fps: FPS }), 'chain');
  const midRel = (i) => (cuts[i] + cuts[i + 1]) / 2 - cuts[0];   // output time is relative to cuts[0]
  assert.equal(dominantAt(out, midRel(0)), 0, 'first detected-beat interval is red');
  assert.equal(dominantAt(out, midRel(1)), 1, 'second is green');
  assert.equal(dominantAt(out, midRel(2)), 2, 'third is blue');
});
