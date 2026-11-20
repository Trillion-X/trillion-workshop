/**
 * #231 Smart caption placement proof (place-captions.mjs + karaoke ASS margins): captions land in the CLEAR
 * region away from the subject. captionPlacement reads the detect-track subject center and returns ASS
 * {alignment, marginV} that karaokeAss (#230) consumes; the render burns them via edl.subtitles.ass. Zero new
 * render code (L069): placement is DATA fed to the existing caption authorer + burn.
 *
 * Proof (L155, definitive offline render): a clip with a bright WHITE subject block filling the TOP third (else
 * black). placeCaptionsForVideo runs detect-track, finds the subject high in frame, and places the caption at the
 * BOTTOM. Render a RED-highlight karaoke caption with that placement through video-compose; at a highlighted time
 * the RED caption pixels are in the BOTTOM third and essentially absent from the TOP third where the subject is,
 * so the caption does not collide with the subject. The mirror clip (subject in the BOTTOM third) places the
 * caption at the TOP. Fabricated DATA could not make a real render avoid a real subject block.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captionPlacement, placeCaptionsForVideo } from '../../do-work/place-captions.mjs';
import { karaokeAss } from '../../do-work/author-karaoke-captions.mjs';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
const PY = '/opt/homebrew/anaconda3/bin/python3';
const W = 480, H = 852, FPS = 24;
let work;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
// a clip with a white subject block filling the top third (`where`='top') or bottom third ('bottom').
function subjectClip(name, where) {
  const y = where === 'top' ? 0 : `2*ih/3`;
  const file = join(work, `${name}.mp4`);
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2.5:r=${FPS}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '2.5', '-filter_complex', `[0:v]drawbox=x=0:y=${y}:w=iw:h=ih/3:color=white:t=fill[v]`,
    '-map', '[v]', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  return file;
}
// [redTopThird, redBottomThird] of the output frame at time t (red = R>140,G<90,B<90).
function redThirds(file, t) {
  const png = join(work, `p-${t}-${Math.random().toString(36).slice(2)}.png`);
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
function renderWithPlacement(clip, placement, name) {
  const lines = [{ start: 0, end: 2, words: [{ text: 'HELLOHELLO', start: 0.2, end: 1.2 }, { text: 'WORLDWORLD', start: 1.2, end: 2.0 }] }];
  const ass = karaokeAss(lines, { highlight: '#ff0000', base: '#ffffff', size: 44, alignment: placement.alignment, marginV: placement.marginV, playResX: W, playResY: H });
  const edl = { base: { color: 'black' }, tracks: [], spine: { segments: [{ kind: 'clip', id: 's0', source: clip, in: 0, out: 2.5 }] }, subtitles: { ass }, encode: { width: W, height: H, fps: FPS } };
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
}

before(() => { work = tempFolder(join(tmpdir(), 'placecap-')); });

test('PURE: captionPlacement puts captions opposite the subject (top subject -> bottom caption, and vice versa)', () => {
  const hi = captionPlacement([{ y: 0.12 }, { y: 0.18 }, { y: 0.15 }], { frameHeight: 1920, marginFrac: 0.08 });
  assert.equal(hi.edge, 'bottom'); assert.equal(hi.alignment, 2); assert.equal(hi.marginV, 154);
  const lo = captionPlacement([{ y: 0.82 }, { y: 0.88 }], { frameHeight: 1920 });
  assert.equal(lo.edge, 'top'); assert.equal(lo.alignment, 8);
  assert.equal(captionPlacement([], {}).edge, 'bottom', 'no subject defaults to the bottom caption convention');
});

test('OFFLINE RENDER: subject in the TOP third -> the caption is placed in the BOTTOM, clear of the subject (L155)', () => {
  const clip = subjectClip('subj-top', 'top');
  const placement = placeCaptionsForVideo(clip);
  assert.ok(placement.subjectY < 0.45, `detect-track found the subject high in frame (y ${placement.subjectY})`);
  assert.equal(placement.edge, 'bottom');
  const out = renderWithPlacement(clip, placement, 'top');
  const [rt, rb] = redThirds(out, 0.7);
  assert.ok(rb > rt + 40, `caption RED is in the BOTTOM, away from the top subject (topRed ${rt} vs bottomRed ${rb})`);
});

test('OFFLINE RENDER: subject in the BOTTOM third -> the caption flips to the TOP (mirror)', () => {
  const clip = subjectClip('subj-bot', 'bottom');
  const placement = placeCaptionsForVideo(clip);
  assert.ok(placement.subjectY > 0.55, `detect-track found the subject low in frame (y ${placement.subjectY})`);
  assert.equal(placement.edge, 'top');
  const out = renderWithPlacement(clip, placement, 'bot');
  const [rt, rb] = redThirds(out, 0.7);
  assert.ok(rt > rb + 40, `caption RED flipped to the TOP, away from the bottom subject (topRed ${rt} vs bottomRed ${rb})`);
});
