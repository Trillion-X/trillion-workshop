// The edit grammar a frame-exact cut needs, rendered through video-compose on made-up sources (ffmpeg lavfi):
// a held still frame, an exact frame count, a narration placement brought to a loudness, a two-pass linear master,
// and the shot match that writes one LUT per measured clip.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureLoudness } from '../do-work/measure-loudness.mjs';
import { cubeText, lab, matchShots, rgbOf } from '../do-work/match-shots.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const made = mkdtempSync(join(tmpdir(), 'edit-grammar-'));
const ENCODE = { width: 64, height: 36, fps: '24/1', crf: 4, preset: 'ultrafast' };

function lavfi(name, graph, extra = []) {
  const out = join(made, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...graph.flatMap(g => ['-f', 'lavfi', '-i', g]), ...extra, out]);
  return out;
}

const run = promisify(execFile);

async function render(name, edl) {
  const out = join(made, `${name}.mp4`);
  const work = mkdtempSync(join(made, `${name}-work-`));
  const edlFile = join(made, `${name}.edl.json`);
  writeFileSync(edlFile, JSON.stringify(edl));
  await run(process.execPath, [join(root, 'do-work/video-compose.mjs'), '--edl', edlFile, '--out', out, '--workdir', work], { encoding: 'utf8', timeout: 240000 });
  return out;
}

const frameCount = file => Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file], { encoding: 'utf8' })).streams[0].nb_read_frames);
const frames = (file, w = 64, h = 36) => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const size = w * h * 3;
  return Array.from({ length: raw.length / size }, (_, k) => raw.subarray(k * size, (k + 1) * size));
};
const meanOf = px => [0, 1, 2].map(c => { let s = 0; for (let p = c; p < px.length; p += 3) s += px[p]; return s / (px.length / 3); });

// A moving picture: every frame differs from the one before it.
const moving = lavfi('moving.mp4', ['testsrc2=size=64x36:rate=24:duration=3'], ['-pix_fmt', 'yuv420p']);

// Every render below is its own ffmpeg processes on its own files, so the tests run side by side.
describe('the edit grammar of a frame-exact cut', { concurrency: true }, () => {
  test('a still holds one source frame for exactly its frame count, and grades and moves like any clip', { timeout: 400000 }, async () => {
    const out = await render('still', { encode: ENCODE, spine: { segments: [{ id: 'held', kind: 'clip', source: moving, still: { at: 1.5 }, frames: 30 }] } });
    assert.equal(frameCount(out), 30);
    const all = frames(out);
    const most = f => f.reduce((m, v, k) => Math.max(m, Math.abs(v - all[0][k])), 0);
    assert.ok(all.every(f => most(f) <= 8), `every frame of a still is the same picture (largest step ${Math.max(...all.map(most))})`);
    const source = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', moving, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const [a, b] = [meanOf(all[0]), meanOf(source)];
    assert.ok(a.every((v, c) => Math.abs(v - b[c]) < 6), `the held picture is the source frame at 1.5 s (${a} vs ${b})`);

    const pushed = await render('still-pushed', { encode: ENCODE, spine: { segments: [{ id: 'held', kind: 'clip', source: moving, still: { at: 1.5, duration: 1 }, ken_burns: { zoom_from: 1, zoom_to: 1.5 } }] } });
    const moved = frames(pushed);
    assert.ok(Math.abs(moved.length - 24) <= 1, `a still of 1 s is 24 frames (${moved.length})`);
    assert.ok(moved.at(-1).reduce((m, v, k) => Math.max(m, Math.abs(v - moved[0][k])), 0) > 40, 'ken_burns moves over a held frame');
    assert.equal(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', pushed], { encoding: 'utf8' })).streams.length, 2, 'a still carries a silent sound track');
  });

  test('frames cuts a clip to an exact count and holds its last frame when the source runs short', { timeout: 400000 }, async () => {
    const cut = await render('frames-cut', { encode: ENCODE, spine: { segments: [{ id: 'a', kind: 'clip', source: moving, in: 0.5, out: 2.5, frames: 17 }] } });
    assert.equal(frameCount(cut), 17);
    const held = await render('frames-held', { encode: ENCODE, spine: { segments: [{ id: 'a', kind: 'clip', source: moving, in: 2.9, out: 3, frames: 12 }] } });
    assert.equal(frameCount(held), 12);
    const all = frames(held);
    assert.ok(all.at(-1).reduce((m, v, k) => Math.max(m, Math.abs(v - all.at(-4)[k])), 0) <= 8, 'the frames past the source are its last frame held');
    const refused = spawnSync(process.execPath, [join(root, 'do-work/video-compose.mjs'), '--edl', JSON.stringify({ encode: ENCODE, spine: { segments: [{ id: 'a', kind: 'clip', source: moving, frames: 2.5 }] } }), '--out', join(made, 'never.mp4')], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /frames must be a whole number/);
  });

  test('a narration placement is brought to its level within its gain bounds, then its own audio filters run', { timeout: 400000 }, async () => {
    const quiet = lavfi('quiet.wav', ['sine=frequency=440:sample_rate=48000:duration=4'], ['-af', 'volume=-30dB', '-ac', '1']);
    const black = lavfi('black.mp4', ['color=black:size=64x36:rate=24:duration=3'], ['-pix_fmt', 'yuv420p']);
    const before = measureLoudness(quiet, { from: 1, seconds: 2, channels: 2 }).integrated_lufs;
    const place = extra => ({ encode: ENCODE, spine: { segments: [{ id: 'b', kind: 'clip', source: black, frames: 72, muted: true }] }, audio_graph: { narration: [{ artifact: quiet, start: 0.5, in: 1, out: 3, ...extra }] } });
    const levelled = measureLoudness(await render('level', place({ level: { lufs: -16, gain_db: [-12, 45] } }))).integrated_lufs;
    assert.ok(Math.abs(levelled - -16) < 1.5, `the stretch is brought to -16 LUFS (${levelled}, from ${before})`);
    const bounded = measureLoudness(await render('level-bounded', place({ level: { lufs: -16, gain_db: [-12, 3] } }))).integrated_lufs;
    assert.ok(Math.abs(bounded - (before + 3)) < 1.5, `the gain stops at its highest bound (${bounded}, from ${before})`);
    const filtered = measureLoudness(await render('level-filtered', place({ level: { lufs: -16, gain_db: [-12, 45] }, audio_filters: 'volume=-10dB' }))).integrated_lufs;
    assert.ok(Math.abs(filtered - -26) < 1.5, `the placement's own filters run after its level (${filtered})`);
  });

  test('master_loudnorm_linear measures the program and applies one gain to it', { timeout: 400000 }, async () => {
    const tone = lavfi('tone.mp4', ['testsrc2=size=64x36:rate=24:duration=3', 'sine=frequency=330:sample_rate=48000:duration=3'], ['-af', 'volume=-24dB', '-pix_fmt', 'yuv420p', '-shortest']);
    const edl = { encode: ENCODE, spine: { segments: [{ id: 't', kind: 'clip', source: tone }] }, master_loudnorm: -16, master_true_peak_dbfs: -1.5, master_loudnorm_linear: true };
    const out = measureLoudness(await render('master-linear', edl));
    assert.ok(Math.abs(out.integrated_lufs - -16) < 1, `the program is at -16 LUFS (${out.integrated_lufs})`);
    assert.ok(out.true_peak_dbfs <= -1, `and under its true peak (${out.true_peak_dbfs})`);
  });

  test('L*a*b* round-trips and an identity transfer writes an identity LUT', () => {
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.9], [0.8, 0.1, 0.3]]) {
      rgbOf(lab(rgb)).forEach((v, c) => assert.ok(Math.abs(v - rgb[c]) < 1e-4, `${rgb} round-trips`));
    }
    const same = { mean: [50, 0, 0], std: [20, 5, 5] };
    const rows = cubeText(same, same, 1, 'identity', 3).trim().split('\n').slice(2).map(line => line.split(' ').map(Number));
    assert.equal(rows.length, 27);
    assert.deepEqual(rows[1].map(v => Math.round(v * 1000) / 1000), [0.5, 0, 0], 'red changes fastest and is unmoved');
  });

  test('the shot match brings the clips of one group toward one look, and a held frame takes its shot\'s LUT', { timeout: 400000 }, async () => {
    const dark = lavfi('dark.mp4', ['color=0x203050:size=64x36:rate=24:duration=2'], ['-pix_fmt', 'yuv420p']);
    const bright = lavfi('bright.mp4', ['color=0xd0b080:size=64x36:rate=24:duration=2'], ['-pix_fmt', 'yuv420p']);
    const edl = { encode: ENCODE, spine: { segments: [
      { id: 'one', kind: 'clip', source: dark, in: 0, out: 2, grade: 'eq=saturation=1.1', shot_match: { group: 'cut' } },
      { id: 'two', kind: 'clip', source: bright, in: 0, out: 2, shot_match: { group: 'cut' } },
      { id: 'hold', kind: 'clip', source: bright, still: { at: 1 }, frames: 12, shot_match: { like: 'two' } },
      { id: 'plain', kind: 'clip', source: dark, in: 0, out: 1 },
    ] } };
    const folder = join(made, 'luts');
    const matched = matchShots(edl, folder, { samples: 3 });
    const [one, two, hold, plain] = matched.spine.segments;
    assert.match(one.grade, /^eq=saturation=1\.1,lut3d=file=/, 'the LUT runs after the clip\'s own grade');
    assert.ok(existsSync(join(folder, 'one.cube')) && existsSync(join(folder, 'two.cube')));
    assert.equal(hold.grade, two.grade, 'a held frame takes the LUT of the shot it names');
    assert.deepEqual(plain, edl.spine.segments[3], 'a clip with no shot_match is untouched');
    assert.ok(!('shot_match' in one), 'the rendered edit carries no shot_match');
    assert.match(readFileSync(join(folder, 'one.cube'), 'utf8'), /^TITLE "shot match cut one"\nLUT_3D_SIZE 33\n/);

    const gap = (a, b) => Math.hypot(...a.map((v, c) => v - b[c]));
    const { shot_match: _a, ...first } = edl.spine.segments[0];
    const { shot_match: _b, ...second } = edl.spine.segments[1];
    const unmatched = frames(await render('unmatched', { encode: ENCODE, spine: { segments: [first, second] } }));
    const before = gap(meanOf(unmatched[0]), meanOf(unmatched[60]));
    const after = frames(await render('matched', matched));
    assert.ok(gap(meanOf(after[0]), meanOf(after[60])) < before / 2, 'the two shots end closer than half their first distance');

    assert.throws(() => matchShots({ ...edl, spine: { segments: [{ ...edl.spine.segments[2], shot_match: { like: 'nowhere' } }] } }, folder), /takes the shot match of nowhere/);
    assert.throws(() => matchShots({ ...edl, spine: { segments: [{ ...edl.spine.segments[0], reframe: { aspect_w: 9, aspect_h: 16 } }] } }, folder), /crop or blur fill/);
  });
});
