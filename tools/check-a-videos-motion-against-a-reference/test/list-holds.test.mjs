// The hold list: holds in the order they start with their start second, the longest first in the command's answer, the same
// still level and frame timing as the check, and the command's refusals. Videos are made here with ffmpeg; those tests skip,
// saying why, without it. Every number is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdsIn, longestHolds, measureMotion } from '../read-data/measure-motion.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const command = join(folder, 'do-work', 'list-holds.mjs');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:list-the-longest-still-holds-of-my-video');
const work = mkdtempSync(join(tmpdir(), 'list-holds-'));
const run = (...argv) => spawnSync('node', [command, ...argv], { encoding: 'utf8' });
const lastLine = ran => JSON.parse(ran.stdout.trim().split('\n').pop());
const ffmpegThere = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = ffmpegThere ? false : 'needs ffmpeg and ffprobe on the PATH; run the row\'s get_it steps';

test('the row runs on the person\'s computer and names the command that exists', () => {
  assert.ok(row, 'tool:list-the-longest-still-holds-of-my-video is in tool-rows.json');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /do-work\/list-holds\.mjs --video \{video\}/);
  assert.ok(existsSync(command));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
});

test('a hold is a run of frames that neither move nor cut, kept with the second it starts', () => {
  // frame changes at 10 frames a second, still level 1, cut level 25 (motion-measure.json)
  const changes = [0, 0, 0, 5, 0, 0, 0, 0, 0, 30, 0, 0];
  const { moving, holds } = holdsIn(changes, 1, 10);
  assert.deepEqual(moving, [false, false, true, true, true, false, false, false, false, false, false, false]);
  // frames 0-1 hold, 2-4 move (5 and its neighbours), 5-8 hold, 9 is a cut, 10-11 hold
  assert.deepEqual(holds, [{ seconds: 0.2, at: 0 }, { seconds: 0.4, at: 0.5 }, { seconds: 0.2, at: 1 }]);
});

test('a change at or under the still level is not movement, and a cut ends a hold without moving', () => {
  assert.deepEqual(holdsIn([1, 1, 1], 1, 1).holds, [{ seconds: 3, at: 0 }]);
  assert.deepEqual(holdsIn([1.01, 0, 0, 0], 1, 1).holds, [{ seconds: 2, at: 2 }]);
  assert.deepEqual(holdsIn([0, 26, 0], 1, 1), { moving: [false, false, false], holds: [{ seconds: 1, at: 0 }, { seconds: 1, at: 2 }] });
  assert.deepEqual(holdsIn([], 1, 24).holds, []);
});

function make(name, filter) {
  const path = join(work, name);
  const made = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15', '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=15',
    '-filter_complex', filter, '-pix_fmt', 'yuv420p', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return path;
}
// moves 2 s, holds 1 s, moves 1 s, holds 2 s, moves 1 s
const twoHolds = () => make('two-holds.mp4', '[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[1:v]trim=0:1,setpts=PTS-STARTPTS[b];[0:v]trim=2:3,setpts=PTS-STARTPTS[c];'
  + '[1:v]trim=0:2,setpts=PTS-STARTPTS[d];[0:v]trim=3:4,setpts=PTS-STARTPTS[e];[a][b][c][d][e]concat=n=5:v=1:a=0');

test('the longest hold comes first, each with the second it starts, and top keeps that many', { skip }, () => {
  const path = twoHolds();
  const listed = longestHolds(path);
  assert.equal(listed.holds.length, 2);
  const [long, short] = listed.holds;
  assert.ok(long.seconds > 1.8 && long.seconds < 2.1, `about two seconds held: ${long.seconds}`);
  assert.ok(long.at > 3.9 && long.at < 4.2, `the long hold starts at about 4 s: ${long.at}`);
  assert.ok(short.seconds > 0.8 && short.seconds < 1.1 && short.at > 1.9 && short.at < 2.2, JSON.stringify(short));
  assert.equal(listed.text, listed.holds.map(hold => `${hold.seconds.toFixed(2)}s@${hold.at.toFixed(2)}`).join('  '));
  assert.deepEqual(longestHolds(path, 0, null, 1).holds, [long]);
  assert.equal(longestHolds(path).still_threshold, measureMotion(path).still_threshold, 'the same still level as the check');
  assert.equal(Math.max(...listed.holds.map(hold => hold.seconds)), measureMotion(path).longest_hold_s, 'the same longest hold as the check');
});

test('the seconds asked for cut the video short, and a given still level is used', { skip }, () => {
  const path = twoHolds();
  const early = longestHolds(path, 3.5, 1.5);
  assert.equal(early.seconds, 3.5);
  assert.equal(early.still_threshold, 1.5);
  assert.equal(early.holds.length, 1, 'only the first hold is inside 3.5 s');
});

test('the command answers on its last line, and refuses what it cannot read with what to change', { skip }, () => {
  const ran = run('--video', twoHolds(), '--top', '1');
  assert.equal(ran.status, 0, ran.stderr);
  const { result } = lastLine(ran);
  assert.equal(result.holds.length, 1);
  assert.deepEqual(Object.keys(result), ['video', 'seconds', 'still_threshold', 'holds', 'text']);
  for (const [argv, message] of [
    [[], /usage/],
    [['--video', join(work, 'not-there.mp4')], /is not there/],
    [['--video', twoHolds(), '--top', '0'], /--top 0 is not a whole number above 0/],
    [['--video', twoHolds(), '--still', '-1'], /--still -1 is not a still level above 0/],
    [['--video', twoHolds(), '--seconds', 'soon'], /--seconds soon is not a number of seconds/],
    [['--frames', '3'], /Could not read --frames/],
  ]) {
    const refused = run(...argv);
    assert.equal(refused.status, 2, argv.join(' '));
    assert.match(lastLine(refused).error, message);
  }
});
