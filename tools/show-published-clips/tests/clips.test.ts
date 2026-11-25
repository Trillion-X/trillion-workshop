import test from 'node:test';
import assert from 'node:assert/strict';
import { clipsOf, limitOf, readClips } from '../do-work/clips.ts';

const row = (id: string, position: number, extra: Record<string, unknown> = {}) => ({ id, position, title: `Clip ${id}`, still: `${id}.jpg`, video: `${id}.mp4`, published: true, ...extra });

test('only published clips with a still and a video are answered, in position order', () => {
  const { clips } = clipsOf([
    row('c', 3), row('a', 1), row('draft', 0, { published: false }), row('nostill', 2, { still: '' }), row('novideo', 2, { video: null }), row('b', 1),
  ]);
  assert.deepEqual(clips.map(clip => clip.id), ['a', 'b', 'c']);
});

test('at most the limit are answered', () => {
  assert.equal(clipsOf([row('a', 0), row('b', 1), row('c', 2)], 2).clips.length, 2);
});

test('the limit is 24 by default and a whole number from 1 to 100', () => {
  assert.equal(limitOf(undefined), 24);
  assert.equal(limitOf(100), 100);
  for (const bad of [0, 101, 1.5, '5']) assert.throws(() => limitOf(bad), /whole number from 1 to 100/);
});

test('the read asks the one table for published rows and shapes the answer', async () => {
  const asked: string[] = [];
  const answer = await readClips({ database: 'any', limit: 5 }, async sql => { asked.push(sql); return [row('a', 0)]; });
  assert.match(asked[0], /from clips where published order by position, id$/);
  assert.deepEqual(answer, { clips: [{ id: 'a', position: 0, title: 'Clip a', still: 'a.jpg', video: 'a.mp4' }] });
});

test('a limit out of range is refused before any statement is sent', async () => {
  let sent = 0;
  await assert.rejects(readClips({ database: 'any', limit: 500 }, async () => { sent += 1; return []; }), /limit must be/);
  assert.equal(sent, 0);
});
