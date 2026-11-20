// Tests for the video face of a ref (read-data/video-ref-media.mjs) and for ShowRef handing a video to the shared player.
// The refs are made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { videoRefMedia } from '../read-data/video-ref-media.mjs';

test('a video ref is the player\'s video, played from its own address and named by its label', () => {
  assert.deepEqual(videoRefMedia('https://files.example.test/walk.mp4', 'Walk'), {
    id: 'https://files.example.test/walk.mp4', label: 'Walk', source_kind: 'video', playback_url: 'https://files.example.test/walk.mp4',
  });
});

test('a video ref in the page\'s own folder keeps its relative address', () => {
  assert.equal(videoRefMedia('clips/walk.mp4', 'Walk').playback_url, 'clips/walk.mp4');
});

test('ShowRef draws its video through the shared player and holds no raw video element', () => {
  const source = readFileSync(new URL('../show/ShowRef.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ MediaPlaybackSurface \} from '\.\/lazy-playback-surface'/);
  assert.match(source, /<MediaPlaybackSurface media=\{videoRefMedia\(shown\.src, label\)\}/);
  assert.doesNotMatch(source, /<video\b/);
});
