// A recording is seen on the computer that captured it: its still first, then its strip of frames and its waveform,
// in the browser preview maker's shape (computer/see-a-recording.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { programIn } from '../../watch-and-keep-a-live-camera/do-work/take-a-stream.mjs';
import { peaksOf, seeWith, seenAlready } from '../see-a-recording.mjs';

const rows = JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'));
const sizes = rows.seeing[0].sizes;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('peaks are the loudest sample of each equal part, scaled so the loudest part is 1, as the browser counts them', () => {
  assert.deepEqual(peaksOf(Float32Array.from([0.1, -0.2, 0.4, -0.1, 0.05, 0.05]), 3), [0.5, 1, 0.125]);
  assert.equal(peaksOf(new Float32Array(0), 3), null);
});

test('a video gives its still to onStill before the strip and waveform are made, and the whole preview after', async () => {
  const asked = [];
  const exec = async (program, args) => {
    const name = program.split('/').pop();
    if (name === 'probe-it') return JSON.stringify({ format: { duration: '40' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }, { codec_type: 'audio' }] });
    if (args.includes('-filter_complex')) { asked.push('strip'); return JPEG; }
    if (args.includes('s16le')) { asked.push('sound'); return Buffer.from(Int16Array.from([100, -200, 16000, 50]).buffer); }
    asked.push(`still at ${args[args.indexOf('-ss') + 1]}`);
    return JPEG;
  };
  let still = null;
  const made = await seeWith({ program: '/bin/see-it', probe: 'probe-it', sizes: { ...sizes, peak_count: 2 } }, 'clip.mov', exec, async value => { still = value; asked.push('still kept'); });
  assert.deepEqual(asked.slice(0, 2), ['still at 1.000', 'still kept'], 'the still, a tenth in (at most a second), is kept before anything else is made');
  assert.deepEqual(still, { duration: 40, poster: `data:image/jpeg;base64,${JPEG.toString('base64')}`, video_poster_version: 1 });
  assert.equal(made.frames.count, sizes.frame_count);
  assert.equal(made.frames.width, sizes.frame_width);
  assert.equal(made.frames.height, 284, 'a phone turned on its side is seen standing up');
  assert.deepEqual(made.peaks, [0.013, 1]);
  assert.ok(seenAlready(made, true));
});

test('a sound has a waveform and no still; a file with nothing to see answers null', async () => {
  const sound = async (program, args) => (program.endsWith('probe-it') ? JSON.stringify({ format: { duration: '3.5' }, streams: [{ codec_type: 'audio' }] }) : Buffer.from(Int16Array.from([1000, 2000]).buffer));
  const made = await seeWith({ program: '/bin/see-it', probe: 'probe-it', sizes: { ...sizes, peak_count: 2 } }, 'memo.m4a', sound);
  assert.deepEqual(made, { duration: 3.5, peaks: [0.5, 1] });
  assert.ok(seenAlready(made, false));
  assert.equal(seenAlready({ poster: 'x' }, true), false, 'a still with no length or presented frame is made again');
  const nothing = async program => (program.endsWith('probe-it') ? JSON.stringify({ format: {}, streams: [] }) : Buffer.alloc(0));
  assert.equal(await seeWith({ program: '/bin/see-it', probe: 'probe-it', sizes }, 'notes.bin', nothing), null);
});

// With the program this computer has (the folders the row names, then the computer's own PATH), a real clip is seen end to end.
const found = programIn(rows.seeing[0].search_path, rows.seeing[0].check[0]);
test('a real clip is seen by the program on this computer', { skip: !found && 'no seeing program here' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'seen-'));
  const clip = join(folder, 'clip.mp4');
  execFileSync(found, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-pix_fmt', 'yuv420p', clip]);
  const made = await seeWith({ ...rows.seeing[0], program: found, env: process.env }, clip);
  assert.ok(made.poster.startsWith('data:image/jpeg;base64,/9j/'));
  assert.equal(made.video_poster_version, 1);
  assert.ok(Math.abs(made.duration - 4) < 0.2);
  assert.equal(made.frames.height, 90);
  assert.equal(made.peaks.length, sizes.peak_count);
});
