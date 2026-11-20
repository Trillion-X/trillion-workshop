/**
 * #230 Karaoke captions proof (author-karaoke-captions.mjs + video-compose `edl.subtitles.ass`): the word-by-word
 * highlight that carries social-video retention. The authorer turns caption-lines word timings into a libass `\k`
 * ASS string; video-compose burns it over the whole program with one generic `ass=` filter. Zero new render code
 * (L069): a karaoke reveal is an authored ASS string the existing libass burn consumes.
 *
 * Proof (L155, definitive offline render): one caption line with two words, "AAAAAAAA" spoken in [0,1] and
 * "BBBBBBBB" spoken in [1,2], highlighted RED over a WHITE base, centered so the first word sits left of frame
 * center and the second sits right. Render through video-compose, then count RED pixels per half at two times:
 * early (t=0.4, only the first word has begun to light) the red is on the LEFT; later (t=1.4, the highlight has
 * swept into the second word) the red on the RIGHT is far greater than it was early. The highlight moving with the
 * spoken word IS karaoke; a fabricated DATA string could not make a real libass render sweep on the timeline.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { karaokeAss } from '../../do-work/author-karaoke-captions.mjs';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
const PY = '/opt/homebrew/anaconda3/bin/python3';
const W = 640, H = 360, FPS = 24;
let work, clip, out;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

// [redLeftCount, redRightCount] of the output frame at time t (red = R>140, G<90, B<90), split at frame center.
function redHalves(file, t) {
  const png = join(work, `k-${t}.png`);
  ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const py = `from PIL import Image
im=Image.open('${png}').convert('RGB'); w,h=im.size; px=im.load(); l=r=0
for y in range(0,h,2):
  for x in range(0,w,2):
    R,G,B=px[x,y]
    if R>140 and G<90 and B<90:
      (l:=l+1) if x<w//2 else (r:=r+1)
print(l,r)`;
  return execFileSync(PY, ['-c', py], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
}

before(() => {
  work = tempFolder(join(tmpdir(), 'karaoke-'));
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=3:r=${FPS}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '3', '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const lines = [{ start: 0, end: 2, words: [
    { text: 'AAAAAAAA', start: 0, end: 1 },
    { text: 'BBBBBBBB', start: 1, end: 2 },
  ] }];
  const ass = karaokeAss(lines, { highlight: '#ff0000', base: '#ffffff', size: 54, alignment: 5, marginV: 0, playResX: W, playResY: H });
  const edl = {
    base: { color: 'black' }, tracks: [],
    spine: { segments: [{ kind: 'clip', id: 's0', source: clip, in: 0, out: 3 }] },
    subtitles: { ass }, encode: { width: W, height: H, fps: FPS },
  };
  const f = join(work, 'edl.json'); out = join(work, 'out.mp4');
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
});

test('PURE: karaokeAss emits per-word \\k tags and BGR colors sanitized into the ASS grammar', () => {
  const ass = karaokeAss([{ start: 0, end: 1, words: [{ text: 'hi{x}', start: 0, end: 0.5 }, { text: 'yo', start: 0.5, end: 1 }] }],
    { highlight: '#ff0000', base: '#00ff00' });
  assert.match(ass, /\{\\k50\}/, 'first word gets 50 centiseconds');
  assert.ok(ass.includes('&H000000FF&'), 'red highlight becomes BGR primary &H000000FF&');
  assert.ok(ass.includes('&H0000FF00&'), 'green base becomes BGR secondary &H0000FF00&');
  assert.ok(!/\{x\}/.test(ass.split('Text')[1] ?? ass), 'a literal brace in a word cannot open an override block');
});

test('OFFLINE RENDER: the highlight sweeps left to right across words on the timeline (L155)', () => {
  const [le, re] = redHalves(out, 0.4);   // early: first word beginning to light
  const [ll, rl] = redHalves(out, 1.4);   // later: highlight swept into the second word
  assert.ok(le > 40, `first word is highlighted early on the left (leftRed ${le})`);
  assert.ok(le > re, `early, the highlight is on the LEFT word (left ${le} vs right ${re})`);
  assert.ok(rl > re + 40, `later, the highlight reached the RIGHT word (rightRed ${rl} vs early ${re})`);
});
