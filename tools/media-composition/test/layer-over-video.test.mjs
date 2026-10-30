// Sound and picture layers: the one translation (read-data/layers-to-edit.mjs) the two layering tools share, and a
// real render of layers over a video.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layerProblems, layersToEdit, layerSourcesAreFiles, soundFromMusicBed } from '../read-data/layers-to-edit.mjs';

const root = new URL('..', import.meta.url).pathname;
const A = `1f:${'a'.repeat(64)}`, B = `1f:${'b'.repeat(64)}`, C = `1f:${'c'.repeat(64)}`;

test('layers become the render engine\'s own sound placements and picture overlays', () => {
  const fields = layersToEdit({
    sounds: [{ file: A, start: 1, from: 2, to: 8, volume: 0.3, fade_in: 1, fade_out: 2, duck: true }, { file: B, start: 4, to: null }],
    pictures: [{ file: C, kind: 'image', start: 0, from: 0, to: 3, x: 1, y: 0, size: 0.2, opacity: 0.8 }, { file: A, kind: 'video', start: 2, from: 5, to: 9, size: 0.35 }],
    loudness: -14,
  }, { frameWidth: 1920, edl: { audio_graph: { replace_audio: null } } });
  assert.deepEqual(fields.audio_graph.narration, [
    { artifact: A, start: 1, in: 2, out: 8, volume: 0.3, fade_in: 1, fade_out: 2, duck: true },
    { artifact: B, start: 4, in: 0, volume: 1 },
  ]);
  assert.equal(fields.audio_graph.replace_audio, null, 'other sound choices already in the edit are kept');
  assert.deepEqual(fields.image_overlays, [{ layer_order: 0, start: 0, end: 3, width: 384, x: 'W*1-w/2', y: 'H*0-h/2', opacity: 0.8, image_path: C }]);
  assert.deepEqual(fields.video_overlays, [{ layer_order: 1, start: 2, end: 6, width: 672, x: 'W*0.5-w/2', y: 'H*0.5-h/2', opacity: 1, source_path: A, in: 5, out: 9 }]);
  assert.equal(fields.master_loudnorm, -14);
  assert.deepEqual(layersToEdit({}, { frameWidth: 1920 }), {}, 'no layers add nothing');
});

test('unusable layers are refused with every reason, and only file identities are laid over a video', () => {
  assert.deepEqual(layerProblems({ sounds: [{ file: A, start: 0 }], pictures: [{ file: C, kind: 'image', start: 0, from: 0, to: 2 }] }), []);
  const problems = layerProblems({ sounds: [{ start: -1, volume: 3 }], pictures: [{ file: C, kind: 'gif', start: 0, from: 2, to: 1, x: 4 }] });
  assert.equal(problems.length, 6, problems.join(' | '));
  assert.equal(layerSourcesAreFiles(layersToEdit({ sounds: [{ file: A, start: 0 }], pictures: [{ file: C, kind: 'image', start: 0, from: 0, to: 1 }] }, { frameWidth: 100 })), true);
  assert.equal(layerSourcesAreFiles({ audio_graph: { narration: [{ artifact: '/etc/passwd', start: 0 }] } }), false);
  assert.equal(layerSourcesAreFiles({ audio_graph: { narration: [{ tts_text: 'Hello', start: 0 }] } }), true, 'a voice spoken from words names no file');
});

test('a saved single music bed reads back as the sound layer that plays the same way', () => {
  assert.deepEqual(soundFromMusicBed({ artifact: A, trim: [2, 20], volume: 0.4, fade_in: { st: 0, d: 2 }, fade_out: { st: 14, d: 4 }, duck: true }),
    { file: A, label: 'Music', start: 0, from: 2, to: 20, volume: 0.4, fade_in: 2, fade_out: 4, duck: true });
  assert.equal(soundFromMusicBed(null), null);
});

test('the layering job renders sounds and pictures over a real video', { timeout: 120_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'layers-'));
  try {
    const at = name => join(work, name);
    const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    ff('-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-shortest', at('base.mp4'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=5', at('music.wav'));
    ff('-f', 'lavfi', '-i', 'color=red:s=200x100', '-frames:v', '1', at('logo.png'));
    const out = execFileSync(process.execPath, [join(root, 'do-work/layer-over-video.mjs'),
      '--video', at('base.mp4'),
      '--sounds', JSON.stringify([{ file: at('music.wav'), start: 0, volume: 0.5, fade_in: 0.5, fade_out: 0.5, duck: true }]),
      '--pictures', JSON.stringify([{ file: at('logo.png'), start: 0, x: 1, y: 0, size: 0.25 }]),
      '--output', at('layered.mp4')], { encoding: 'utf8' }).trim().split('\n').at(-1);
    const result = JSON.parse(out);
    assert.equal(result.width, 320);
    assert.equal(result.has_audio, true);
    assert.ok(Math.abs(result.duration_seconds - result.expected_duration_seconds) < 0.3, out);
    assert.equal(result.pictures, 1);
    // The logo sits in the top-right corner: a pixel there is red.
    const pixel = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', at('layered.mp4'), '-frames:v', '1', '-vf', 'crop=2:2:300:4', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60, `expected red, got ${[...pixel]}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
