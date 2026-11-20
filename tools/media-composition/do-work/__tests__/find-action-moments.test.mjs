/**
 * file: packages/media-composition/do-work/__tests__/find-action-moments.test.mjs
 *
 * Tests find-action-moments on a made-up recording whose moments are known: a sharp sound while something moves
 * ranks first, an equally sharp sound in a still picture keeps three quarters of its strength and ranks second, and a
 * soft sound during large motion (someone walking past the lens) never outranks a clearly sharper sound.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findActionMoments } from '../find-action-moments.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** A click of `amplitude` at `at` seconds, as an aevalsrc term. */
const click = (at, amplitude) => `if(between(t,${at},${(at + 0.02).toFixed(2)}),${amplitude}*sin(2*PI*1500*t)*exp(-(t-${at})*200),0)`;

test('sound leads the ranking; motion only breaks near-ties', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  const video = join(tempFolder(join(tmpdir(), 'action-moments-')), 'made-up.mp4');
  // Still picture except a white box that sweeps across during [3.7, 4.3] (with the 4.0 s click) and [4.7, 5.5]
  // (with the soft 5.1 s click).
  const moving = "between(t,3.7,4.3)+between(t,4.7,5.5)";
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=24:d=6',
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${click(1, 0.9)}+${click(4, 0.85)}+${click(5.1, 0.4)}':s=22050:d=6`,
    '-vf', `drawbox=x='mod(t*900,300)':y=60:w=40:h=60:color=white:t=fill:enable='${moving}'`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

  const found = findActionMoments(video, { count: 3, minGap: 0.5 });
  const times = found.moments.map(moment => Math.round(moment.time * 10) / 10);
  assert.deepEqual(times, [4, 1, 5.1], JSON.stringify(found.moments));
  assert.equal(Math.round(found.best.time * 10) / 10, 4);
  const [withMotion, still] = found.moments;
  assert.ok(still.motion < 0.2 && withMotion.motion > 0.5, JSON.stringify(found.moments));
  assert.ok(still.strength >= 0.7 * still.sound, 'a still picture keeps most of a sharp sound\'s strength');
});
