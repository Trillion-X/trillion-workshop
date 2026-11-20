/**
 * #232 Reel-plan caption integration (author-reel-plan #225 + place-captions #231 + karaoke #230): the capstone
 * now produces a FINISHED CAPTIONED reel, not an unwired primitive. When the caller supplies grouped caption
 * `lines`, authorReelPlan reuses the subject track it already computed for the reframe (no second detect-track
 * run) to place the caption in the clear region and authors the karaoke ASS, exposed as `plan.captions`.
 * applyPlanToEdl drops it onto `edl.subtitles`. Zero new render code (L069): the capstone composes the existing
 * producers; captions are DATA the existing burn consumes (anti-primitive-without-product: the #230/#231 producers
 * are now applied to the reel-plan product surface).
 *
 * Proof (L155, definitive offline render): a clip with a bright subject block in the TOP third. authorReelPlan
 * with caption lines places the caption at the BOTTOM (clear of the subject) and authors karaoke; applyPlanToEdl
 * wires it onto the EDL; the rendered reel shows the RED karaoke caption in the bottom half, away from the subject.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorReelPlan, applyPlanToEdl } from '../../do-work/author-reel-plan.mjs';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
const PY = '/opt/homebrew/anaconda3/bin/python3';
const W = 640, H = 360, FPS = 24;
let work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
function redHalves(file, t) {
  const png = join(work, `p-${t}.png`);
  ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const py = `from PIL import Image
im=Image.open('${png}').convert('RGB'); w,h=im.size; px=im.load(); tp=bt=0
for y in range(0,h,2):
  for x in range(0,w,2):
    R,G,B=px[x,y]
    if R>140 and G<90 and B<90:
      (tp:=tp+1) if y<h//2 else (bt:=bt+1)
print(tp,bt)`;
  return execFileSync(PY, ['-c', py], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
}

const LINES = [{ start: 0, end: 2, words: [{ text: 'HELLOHELLO', start: 0.2, end: 1.2 }, { text: 'WORLDWORLD', start: 1.2, end: 2.0 }] }];

before(() => {
  work = tempFolder(join(tmpdir(), 'reelcap-'));
  clip = join(work, 'clip.mp4');
  // subject = white block in the TOP third; the reel-plan should place the caption at the BOTTOM.
  // real (non-silent) audio so the plan's master_loudnorm has signal to normalize (loudnorm NaNs on pure silence).
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2.5:r=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2.5:sample_rate=48000',
    '-filter_complex', '[0:v]drawbox=x=0:y=0:w=iw:h=ih/3:color=white:t=fill[v]',
    '-map', '[v]', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

test('the capstone plan carries captions: placement clear of the subject + a karaoke ASS (or null without lines)', () => {
  const plan = authorReelPlan(clip, { lines: LINES, width: W, height: H, aspectW: 16, aspectH: 9, captionStyle: { size: 40, highlight: '#ff0000', base: '#ffffff' } });
  assert.ok(plan.captions, 'captions authored when lines are given');
  assert.equal(plan.captions.placement.edge, 'bottom', 'subject in the top third -> caption at the bottom');
  assert.match(plan.captions.subtitles.ass, /\{\\k\d+\}/, 'the caption is a karaoke ASS with per-word \\k tags');
  const noCap = authorReelPlan(clip, { width: W, height: H, aspectW: 16, aspectH: 9 });
  assert.equal(noCap.captions, null, 'no lines -> no captions (unchanged behavior)');
});

test('OFFLINE RENDER: applyPlanToEdl wires the caption onto the EDL and the reel burns it clear of the subject (L155)', () => {
  const plan = authorReelPlan(clip, { lines: LINES, width: W, height: H, aspectW: 16, aspectH: 9, captionStyle: { size: 40, highlight: '#ff0000', base: '#ffffff' } });
  const edl0 = { base: { color: 'black' }, tracks: [], spine: { segments: [{ kind: 'clip', id: 's0', source: clip, in: 0, out: 2.5 }] }, encode: { width: W, height: H, fps: FPS } };
  const edl = applyPlanToEdl(edl0, plan);
  assert.ok(edl.subtitles && edl.subtitles.ass, 'applyPlanToEdl set edl.subtitles');
  const f = join(work, 'edl.json'); const out = join(work, 'out.mp4');
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  const [rt, rb] = redHalves(out, 0.7);
  assert.ok(rb > rt + 30, `the reel's karaoke caption is in the bottom half, clear of the top subject (topRed ${rt} vs bottomRed ${rb})`);
});
