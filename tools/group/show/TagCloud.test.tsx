// @vitest-environment jsdom
// packages/group/show/TagCloud.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  tagCloudEntries,
  TagCloud,
  TAG_CLOUD_SOURCES,
  cloudSourceById,
  contentWords,
  CLOUD_STOPWORDS,
} from './TagCloud';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const item = (memberId: string, extra: Record<string, unknown> = {}, kind = 'note', text = ''): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind, x: 0, y: 0, w: 40, h: 30, text, isSection: false, childCount: 0, extra } as BoardItem);

const tagSource = cloudSourceById('tags');

describe('tagCloudEntries', () => {
  it('tallies tags across items and sizes the most-frequent largest', () => {
    const items = [
      item('a', { tags: ['red', 'urgent'] }),
      item('b', { tags: ['red'] }),
      item('c', { tags: ['red', 'urgent'] }),
      item('d', { tags: ['blue'] }),
    ];
    const entries = tagCloudEntries(items, { valuesOf: tagSource.valuesOf, scale: 'linear' });
    expect(entries[0].value).toBe('red'); // 3 → most frequent, ranked first
    expect(entries[0].count).toBe(3);
    // red (3) is bigger than blue (1)
    const red = entries.find((e) => e.value === 'red')!;
    const blue = entries.find((e) => e.value === 'blue')!;
    expect(red.size).toBeGreaterThan(blue.size);
  });

  it('excludes connectors', () => {
    const items = [
      item('a', { tags: ['x'] }),
      item('edge', { tags: ['x'], fromMemberId: 'a', toMemberId: 'a' }),
    ];
    expect(tagCloudEntries(items, { valuesOf: tagSource.valuesOf })[0].count).toBe(1); // only 'a'
  });

  it('limit keeps the top-N tags', () => {
    const items = [item('a', { tags: ['a', 'a', 'a'] as never }), item('b', { tags: ['b', 'b'] }), item('c', { tags: ['c'] })];
    // tags is an array per item; craft counts via repeats
    const many = [
      item('1', { tags: ['a'] }), item('2', { tags: ['a'] }), item('3', { tags: ['a'] }),
      item('4', { tags: ['b'] }), item('5', { tags: ['b'] }), item('6', { tags: ['c'] }),
    ];
    expect(tagCloudEntries(many, { valuesOf: tagSource.valuesOf, limit: 2 }).map((e) => e.value)).toEqual(['a', 'b']);
  });

  it('empty board → no entries', () => {
    expect(tagCloudEntries([], { valuesOf: tagSource.valuesOf })).toEqual([]);
  });
});

describe('contentWords', () => {
  it('drops stopwords + short words, lowercases', () => {
    expect(contentWords('The quick brown FOX to a plan')).toEqual(['quick', 'brown', 'fox', 'plan']);
  });
  it('CLOUD_STOPWORDS contains common words', () => {
    expect(CLOUD_STOPWORDS.has('the')).toBe(true);
  });
});

describe('TagCloud component', () => {
  it('renders one chip per tag; clicking fires onPick', () => {
    const items = [item('a', { tags: ['red', 'blue'] }), item('b', { tags: ['red'] })];
    const picks: string[] = [];
    const { container, getByText } = render(
      <TagCloud items={items} source={tagSource} onPick={(v) => picks.push(v)} />,
    );
    expect(container.textContent).toContain('red');
    expect(container.textContent).toContain('blue');
    fireEvent.click(getByText('red'));
    expect(picks).toEqual(['red']);
  });
});

describe('TAG_CLOUD_SOURCES catalog', () => {
  it('ships tags/words/kind + resolves by id (fallback to tags)', () => {
    expect(TAG_CLOUD_SOURCES.map((s) => s.id)).toEqual(['tags', 'words', 'kind']);
    expect(cloudSourceById('words').id).toBe('words');
    expect(cloudSourceById('nope').id).toBe('tags');
  });
  it('the words source builds a word cloud from note text (stopwords dropped)', () => {
    const items = [item('a', {}, 'note', 'plan the launch'), item('b', {}, 'note', 'launch the launch plan')];
    const words = cloudSourceById('words');
    const entries = tagCloudEntries(items, { valuesOf: words.valuesOf, scale: 'linear' });
    expect(entries[0].value).toBe('launch'); // appears 3× → biggest
    expect(entries.some((e) => e.value === 'the')).toBe(false); // stopword dropped
  });
});
