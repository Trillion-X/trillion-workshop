import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from './render-a-view.ts';
import { videoAddress } from '../show/video-address.ts';

const entry = new URL('../show/SideBySide.tsx', import.meta.url).pathname;
const side = (label: string, video: string, start_s: number) => ({ label, video, start_s });
const pairs = [
  { id: 'p1', place: 0, featured: false, title: 'First pair', caption: 'Watch the turn.', left: side('One', 'a.mp4', 1.5), right: side('Two', 'https://files.example/b.mp4', 0) },
  { id: 'p2', place: 1, featured: false, title: '', caption: '', left: side('', 'c.mp4', 0), right: side('', '/d.mp4', 2) },
];

test('each pair draws two videos with their start marks and one play button', async () => {
  const html = await renderAView(entry, { pairs, filesBase: '/files/' });
  assert.equal((html.match(/data-side-by-side-video=/g) ?? []).length, 4);
  assert.equal((html.match(/data-side-by-side-play=/g) ?? []).length, 2);
  assert.match(html, /data-start-s="1.5"/);
  assert.match(html, /src="\/files\/a\.mp4"/);
  assert.match(html, /src="https:\/\/files\.example\/b\.mp4"/);
  assert.match(html, /src="\/d\.mp4"/);
  assert.match(html, /First pair/);
  assert.match(html, /Watch the turn\./);
});

test('the screen is pure: no script, no inline style, videos have no controls of their own', async () => {
  const html = await renderAView(entry, { pairs });
  assert.doesNotMatch(html, /<script|style=|controls/);
});

test('a pair that is one video draws one box and one play button', async () => {
  const html = await renderAView(entry, { pairs: [{ id: 'w', place: 0, title: 'Whole', caption: '', featured: false, video: side('', 'both.mp4', 0) }], filesBase: '/files/' });
  assert.equal((html.match(/data-side-by-side-video="whole"/g) ?? []).length, 1);
  assert.equal((html.match(/data-side-by-side-video="(left|right)"/g) ?? []).length, 0);
  assert.equal((html.match(/data-side-by-side-play=/g) ?? []).length, 1);
  assert.match(html, /src="\/files\/both\.mp4"/);
});

test('no pairs draws an empty list, not an error', async () => {
  assert.match(await renderAView(entry, { pairs: [] }), /data-side-by-side-list/);
});

test('a storage key gets the files base, a full address or rooted path does not', () => {
  assert.equal(videoAddress('k.mp4', '/f/'), '/f/k.mp4');
  assert.equal(videoAddress('/k.mp4', '/f/'), '/k.mp4');
  assert.equal(videoAddress('https://x/k.mp4', '/f/'), 'https://x/k.mp4');
});
