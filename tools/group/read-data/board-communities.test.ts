// packages/group/read-data/board-communities.test.ts
import { describe, it, expect } from 'vitest';
import { detectCommunities, communityGroups, communityCount, numberedCommunities } from './board-communities';
import type { BoardItem } from './group-board-model';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);
const edge = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);
// A triangle a-b-c (every pair linked) is a dense clique that must end up in one community.
const clique = (ids: string[], prefix: string): BoardItem[] => {
  const out = ids.map((id) => card(id));
  let k = 0;
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) out.push(edge(`${prefix}${k++}`, ids[i], ids[j]));
  return out;
};

describe('detectCommunities', () => {
  it('empty board → empty map', () => {
    expect(detectCommunities([]).size).toBe(0);
  });

  it('a card with no connectors is its own singleton community', () => {
    const c = detectCommunities([card('a'), card('b')]);
    expect(c.get('a')).toBe('a');
    expect(c.get('b')).toBe('b');
  });

  it('two dense cliques bridged by ONE edge split into TWO communities', () => {
    // clique {a,b,c} and clique {x,y,z}, joined by a single c–x bridge → dense-within / sparse-between.
    const items = [...clique(['a', 'b', 'c'], 'p'), ...clique(['x', 'y', 'z'], 'q'), edge('bridge', 'c', 'x')];
    const c = detectCommunities(items);
    // a,b,c share one label; x,y,z share another; the two labels differ.
    expect(c.get('a')).toBe(c.get('b'));
    expect(c.get('b')).toBe(c.get('c'));
    expect(c.get('x')).toBe(c.get('y'));
    expect(c.get('y')).toBe(c.get('z'));
    expect(c.get('a')).not.toBe(c.get('x'));
  });

  it('the canonical community id is the smallest member id', () => {
    const c = detectCommunities(clique(['m', 'a', 'z'], 'p'));
    expect(c.get('m')).toBe('a'); // {a,m,z} → canonical 'a'
    expect(c.get('z')).toBe('a');
  });

  it('is deterministic across runs', () => {
    const build = () => [...clique(['a', 'b', 'c'], 'p'), ...clique(['x', 'y', 'z'], 'q'), edge('br', 'c', 'x')];
    expect([...detectCommunities(build()).entries()].sort()).toEqual([...detectCommunities(build()).entries()].sort());
  });

  it('excludes connectors and sections', () => {
    const items = [card('a'), { ...card('sec'), isSection: true } as BoardItem, edge('e', 'a', 'a')];
    expect([...detectCommunities(items).keys()]).toEqual(['a']);
  });
});

describe('communityGroups / communityCount', () => {
  const items = [...clique(['a', 'b', 'c'], 'p'), ...clique(['x', 'y', 'z'], 'q'), edge('br', 'c', 'x'), card('lonely')];
  it('groups are sorted, largest-first, and count them', () => {
    const groups = communityGroups(items);
    expect(groups).toEqual([['a', 'b', 'c'], ['x', 'y', 'z'], ['lonely']]);
    expect(communityCount(items)).toBe(3);
  });
});

describe('numberedCommunities', () => {
  const items = [...clique(['a', 'b', 'c'], 'p'), ...clique(['x', 'y', 'z'], 'q'), edge('br', 'c', 'x'), card('lonely')];
  it('numbers multi-member clusters and pushes singletons to the empty pile', () => {
    const { keyOf, labelMap } = numberedCommunities(items);
    expect(keyOf(card('a'))).toBe('a'); // canonical id
    expect(labelMap.a).toBe('Cluster 1'); // 'a' sorts before 'x'
    expect(labelMap.x).toBe('Cluster 2');
    expect(keyOf(card('lonely'))).toBe(''); // singleton → Unclustered
  });
});
