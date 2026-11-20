// The shelf: newest first, pages that neither skip nor repeat, the kind filter, counts with the fallback kind, and a story
// taken down that is never listed again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shelfOf, shelfPage, storyCounts, takeDown } from '../read-data/story-shelf.mjs';
import settings from '../read-data/story-settings.json' with { type: 'json' };

const story = (index, kind = 'money') => ({
  id: `0000000000000000000${index}`.slice(-20),
  title: `Story ${index}`,
  kind,
  published_at: `2026-11-${String(10 + index).padStart(2, '0')}T09:00:00Z`,
});
const stories = [story(0), story(1, 'sport-and-training'), story(2), story(3, 'sport-and-training'), story(4)];

test('the shelf lists the newest story first', () => {
  assert.deepEqual(shelfOf(stories).map(item => item.title), ['Story 4', 'Story 3', 'Story 2', 'Story 1', 'Story 0']);
});

test('a page cut continues from its cursor without skipping or repeating a story', () => {
  const first = shelfPage(stories, { limit: 2 });
  assert.deepEqual(first.stories.map(item => item.title), ['Story 4', 'Story 3']);
  assert.ok(first.next);
  const second = shelfPage(stories, { limit: 2, after: first.next });
  assert.deepEqual(second.stories.map(item => item.title), ['Story 2', 'Story 1']);
  const last = shelfPage(stories, { limit: 2, after: second.next });
  assert.deepEqual(last.stories.map(item => item.title), ['Story 0']);
  assert.equal(last.next, null);
});

test('a kind filter keeps only that kind, newest first', () => {
  assert.deepEqual(shelfPage(stories, { kind: 'money' }).stories.map(item => item.title), ['Story 4', 'Story 2', 'Story 0']);
});

test('counts list every kind, zero when none, and an unlisted kind under the fallback', () => {
  const fallback = settings.kinds.find(kind => kind.fallback).id;
  const counts = storyCounts([...stories, { id: 'f'.repeat(20), kind: 'astrology', published_at: '2026-11-01T00:00:00Z' }]);
  assert.equal(counts.money, 3);
  assert.equal(counts['sport-and-training'], 2);
  assert.equal(counts[fallback], 1);
  assert.equal(counts['work-and-career'], 0);
  assert.equal(Object.keys(counts).length, settings.kinds.length);
});

test('a story taken down is gone from the shelf, the counts and the pages, and stays marked withdrawn', () => {
  const taken = takeDown(stories[4], '2026-11-20T12:00:00Z');
  const after = stories.map(item => (item.id === stories[4].id ? taken : item));
  assert.equal(shelfOf(after).some(item => item.id === stories[4].id), false);
  assert.equal(storyCounts(after).money, 2);
  assert.equal(shelfPage(after, { limit: 10 }).stories.length, 4);
  assert.equal(taken.withdrawn, true);
  assert.equal(taken.published, false);
});
