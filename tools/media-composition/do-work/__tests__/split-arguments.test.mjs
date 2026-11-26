/**
 * file: tools/media-composition/do-work/__tests__/split-arguments.test.mjs
 *
 * A split with no timing of its own (no speed_ramp, speed_smooth or still; at 1x or at one segment speed) renders with exactly the
 * ffmpeg arguments it had before cell timing was added. The expected arguments below were recorded from the renderer
 * before that change (trillion-workshop 81c6ff2a3) for four such splits: a cropped, mirrored, labelled pair with
 * sound, a three-source grid, a weighted stack and a pair slowed to 0.4x. A shim on PATH writes down each ffmpeg call and then runs ffmpeg.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const ffmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();

// The arguments the renderer gave ffmpeg for each split before cell timing (CLIPS = the clip folder, WD = the workdir).
const BEFORE = [
  "-hide_banner -loglevel error -y -ss 0.5 -t 1 -i CLIPS/a.mp4 -ss 1 -t 1 -i CLIPS/b.mp4 -filter_complex [0:v]crop=200:240:60:0,scale=320:360,setsar=1,fps=30,format=yuv420p,drawtext=textfile='WD/label-pair-0.txt':expansion=none:x=11+(w-text_w-22)*(0):y=11+(h-text_h-22)*(0):fontsize=30:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=9[v0];[1:v]hflip,scale=320:360,setsar=1,fps=30,format=yuv420p,drawtext=textfile='WD/label-pair-1.txt':expansion=none:x=11+(w-text_w-22)*(1):y=11+(h-text_h-22)*(0):fontsize=18:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=5[v1];[v0][v1]hstack=inputs=2[vout];[0:a]amix=inputs=1:duration=longest:normalize=0[aout] -map [vout] -map [aout] -shortest -c:v libx264 -crf 30 -preset ultrafast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 256k WD/seg000.mp4",
  "-hide_banner -loglevel error -y -t 1 -i CLIPS/a.mp4 -t 1 -i CLIPS/b.mp4 -t 1 -i CLIPS/b.mp4 -filter_complex [0:v]scale=320:180,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=320:180,setsar=1,fps=30,format=yuv420p[v1];[2:v]scale=320:180,setsar=1,fps=30,format=yuv420p[v2];[v0][v1][v2]xstack=inputs=3:layout=0_0|320_0|0_180:fill=black[vout];[0:a]amix=inputs=1:duration=longest:normalize=0[aout] -map [vout] -map [aout] -shortest -c:v libx264 -crf 30 -preset ultrafast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 256k WD/seg001.mp4",
  "-hide_banner -loglevel error -y -ss 0 -t 0.8 -i CLIPS/b.mp4 -ss 1 -t 0.8 -i CLIPS/b.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -filter_complex [0:v]scale=640:240,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=640:120,setsar=1,fps=30,format=yuv420p[v1];[v0][v1]vstack=inputs=2[vout] -map [vout] -map 2:a -shortest -c:v libx264 -crf 30 -preset ultrafast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 256k WD/seg002.mp4",
  "-hide_banner -loglevel error -y -ss 0.5 -t 0.5 -i CLIPS/a.mp4 -ss 1 -t 0.5 -i CLIPS/b.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -filter_complex [0:v]setpts=PTS/0.4,scale=320:360,setsar=1,fps=30,format=yuv420p,drawtext=textfile='WD/label-slowed-0.txt':expansion=none:x=11+(w-text_w-22)*(0):y=11+(h-text_h-22)*(0):fontsize=18:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=5[v0];[1:v]setpts=PTS/0.4,scale=320:360,setsar=1,fps=30,format=yuv420p[v1];[v0][v1]hstack=inputs=2[vout] -map [vout] -map 2:a -shortest -c:v libx264 -crf 30 -preset ultrafast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 256k WD/seg003.mp4"
];

function edlFor(clips) {
  return {
    encode: { width: 640, height: 360, fps: 30, crf: 30, preset: 'ultrafast' },
    base: { kind: 'color', color: 'black' },
    spine: { segments: [
      { id: 'pair', kind: 'split', layout: 'h', sources: [
        { source: clips.a, in: 0.5, out: 1.5, crop: { w: 200, h: 240, x: 60, y: 0 }, label: { text: 'ONE', corner: 'tl', size: 30 } },
        { source: clips.b, in: 1.0, out: 2.0, flip: 'h', label: { text: 'TWO', corner: 'tr' } }] },
      { id: 'grid', kind: 'split', layout: 'grid', duration: 1, sources: [clips.a, clips.b, clips.b] },
      { id: 'weighted', kind: 'split', layout: 'v', weights: [2, 1], sources: [{ source: clips.b, in: 0, out: 0.8 }, { source: clips.b, in: 1, out: 1.8 }] },
      { id: 'slowed', kind: 'split', layout: 'h', speed: 0.4, sources: [{ source: clips.a, in: 0.5, out: 1.0, label: { text: 'SLOW' } }, { source: clips.b, in: 1, out: 1.5 }] },
    ] },
  };
}

test('a split with no timing of its own gives ffmpeg the same arguments as before cell timing', { skip: !ffmpeg && 'ffmpeg is needed' }, () => {
  const work = tempFolder(join(tmpdir(), 'split-arguments-'));
  const clips = join(work, 'clips');
  const wd = join(work, 'wd');
  const shim = join(work, 'shim');
  for (const folder of [clips, wd, shim]) mkdirSync(folder, { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-pix_fmt', 'yuv420p', '-shortest', join(clips, 'a.mp4')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4', '-pix_fmt', 'yuv420p', join(clips, 'b.mp4')]);
  const log = join(work, 'calls.txt');
  writeFileSync(join(shim, 'ffmpeg'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${ffmpeg}' "$@"\n`);
  chmodSync(join(shim, 'ffmpeg'), 0o755);
  const edlFile = join(work, 'edl.json');
  writeFileSync(edlFile, JSON.stringify(edlFor({ a: join(clips, 'a.mp4'), b: join(clips, 'b.mp4') })));
  const done = spawnSync('node', [SCRIPT, '--edl', edlFile, '--out', join(work, 'out.mp4'), '--workdir', wd], { encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(done.status, 0, done.stderr);
  const splits = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('-filter_complex'))
    .map((line) => line.split(wd).join('WD').split(clips).join('CLIPS'));
  assert.deepEqual(splits, BEFORE);
});
