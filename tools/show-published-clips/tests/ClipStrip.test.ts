import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('../show/ClipStrip.tsx', import.meta.url).pathname;
const clips = [
  { id: 'a', position: 0, title: 'First', still: 'a.jpg', video: 'a.mp4' },
  { id: 'b', position: 1, title: '', still: 'https://files.example/b.jpg', video: '/b.mp4' },
];

test('each clip is a still with its own tap target, and the strip scrolls sideways', async () => {
  const html = await renderAView(entry, { clips, filesBase: '/files/', title: 'Reels' });
  assert.equal((html.match(/data-clip-play=/g) ?? []).length, 2);
  assert.match(html, /Reels/);
  assert.match(html, /src="\/files\/a\.jpg"/);
  assert.match(html, /src="https:\/\/files\.example\/b\.jpg"/);
  assert.match(html, /overflow-x-auto/);
  assert.doesNotMatch(html, /<video/);
});

test('a playing clip shows its video in place of its still; the others keep their stills', async () => {
  const html = await renderAView(entry, { clips, filesBase: '/files/', playing: ['a'] });
  assert.match(html, /src="\/files\/a\.mp4"/);
  assert.doesNotMatch(html, /data-clip-play="a"/);
  assert.match(html, /data-clip-play="b"/);
});

test('no clips draws nothing at all', async () => {
  assert.equal(await renderAView(entry, { clips: [] }), '');
});

test('the strip is pure: no script and no inline style', async () => {
  assert.doesNotMatch(await renderAView(entry, { clips }), /<script|style=/);
});
