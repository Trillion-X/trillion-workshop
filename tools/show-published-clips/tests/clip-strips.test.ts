// The published clips as strips (show/ClipStrips.tsx) on the answer tool:read-published-clips gives: before-and-after cards with both
// stills and the person and day under each, reels at one height, a clip with a missing still left out, a comparison of two
// different people left to the page's side-by-sides, and nothing drawn when no strip has a clip. Every name is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';
import { stripsOf, type PublishedClip } from '../do-work/clip-strips.ts';

const entry = new URL('./clip-strips-as-view.tsx', import.meta.url).pathname;
const pair = (id: string, leftPerson: string, rightPerson: string, leftDay: string, rightDay: string, extra: Partial<PublishedClip['pair']> = {}): PublishedClip => ({
  id, moment: 'comparison', kind: 'comparison', aspect: '16x9', cut_url: `/clips/${id}.mp4`,
  pair: { left: { person: leftPerson, day: leftDay, picture_url: `/clips/${id}-left.jpg` }, right: { person: rightPerson, day: rightDay, picture_url: `/clips/${id}-right.jpg`, ...extra } },
});
const reel: PublishedClip = { id: 'r1', moment: 'reel', kind: 'reel', aspect: '9x16', cut_url: '/clips/r1.mp4', picture_url: '/clips/r1.jpg' };
const clips = [pair('same', 'Ada', 'Ada', 'May 24, 2023', 'Jul 8, 2024'), pair('ref', 'Ada', 'A pro', 'May 24, 2023', 'May 24, 2023'), reel, { ...reel, id: 'r2', picture_url: null }, { ...reel, id: 'wide', aspect: '16x9' }];

test('each clip goes to its strip: the same person on two days, and reels of 9:16 with a cover', () => {
  const by = stripsOf(clips);
  assert.deepEqual(by.before_after.map(clip => clip.id), ['same']);
  assert.deepEqual(by.reels.map(clip => clip.id), ['r1']);
});

test('a before-and-after card draws both stills with the person and day under each; a reel draws its cover; titles are the row\'s', async () => {
  const html = await renderAView(entry, { clips, titles: { before_after: 'Transformations', reels: 'Reels' } });
  assert.match(html, /Transformations/);
  assert.match(html, /Reels/);
  assert.match(html, /Ada · May 24, 2023/);
  assert.match(html, /Ada · Jul 8, 2024/);
  assert.match(html, /data-clip-play="same"/);
  assert.match(html, /data-clip-play="r1"/);
  assert.doesNotMatch(html, /data-clip="ref"/);
  assert.doesNotMatch(html, /data-clip="r2"/);
});

test('strips are chosen and ordered by `strips`; no clip in any chosen strip draws nothing', async () => {
  const only = await renderAView(entry, { clips, strips: ['reels'], titles: { reels: 'Reels' } });
  assert.match(only, /Reels/);
  assert.doesNotMatch(only, /data-clip="same"/);
  assert.equal((await renderAView(entry, { clips: [] })).includes('data-clip'), false);
  assert.equal((await renderAView(entry, { clips: [reel], strips: ['before_after'] })).includes('data-clip'), false);
});
