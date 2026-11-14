// @vitest-environment jsdom
// packages/group/show/TagAffinityReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TagAffinityReadout, tagGraphLayout, boardTagSets, boardTagSuggestions } from './TagAffinityReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, tags: string[]): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 60, h: 40, isSection: false, childCount: 0, extra: { tags } } as BoardItem);

const connector = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 10, h: 10, isSection: false, childCount: 0, extra: { fromMemberId: 'a', toMemberId: 'b', tags: ['ignore'] } } as BoardItem);

const board: BoardItem[] = [
  card('c1', ['design', 'ux']),
  card('c2', ['design', 'ux']),
  card('c3', ['design', 'ux', 'research']),
  card('c4', ['backend', 'db']),
  connector('e1'),
];

describe('boardTagSets', () => {
  it('excludes connectors and reads each card’s tags', () => {
    const sets = boardTagSets(board);
    expect(sets).toHaveLength(4); // the connector is dropped
    expect(sets).toContainEqual(['design', 'ux', 'research']);
  });
});

describe('tagGraphLayout', () => {
  it('lays out a node per distinct tag with finite coords, sized by frequency', () => {
    const { nodes } = tagGraphLayout(board, { size: 260 });
    const tags = nodes.map((n) => n.tag).sort();
    expect(tags).toEqual(['backend', 'db', 'design', 'research', 'ux']);
    for (const n of nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.r)).toBe(true);
    }
    // design (3 cards) is the most frequent → its node is the largest
    const design = nodes.find((n) => n.tag === 'design')!;
    const research = nodes.find((n) => n.tag === 'research')!;
    expect(design.count).toBe(3);
    expect(design.r).toBeGreaterThan(research.r);
  });
  it('edges only connect co-occurring tags, never across disjoint clusters', () => {
    const { edges } = tagGraphLayout(board);
    expect(edges.some((e) => (e.a === 'design' || e.b === 'design') && (e.a === 'ux' || e.b === 'ux'))).toBe(true);
    expect(edges.some((e) => (e.a === 'design' || e.b === 'design') && (e.a === 'backend' || e.b === 'backend'))).toBe(false);
    for (const e of edges) expect(e.opacity).toBeGreaterThan(0);
  });
  it('maxTags keeps only the most-frequent tags', () => {
    const { nodes } = tagGraphLayout(board, { maxTags: 2 });
    expect(nodes).toHaveLength(2);
    // the two most frequent are design (3) then ux (3) — deterministic tie-break by name
    expect(nodes.map((n) => n.tag).sort()).toEqual(['design', 'ux']);
  });
  it('is deterministic', () => {
    expect(tagGraphLayout(board)).toEqual(tagGraphLayout(board));
  });
  it('an untagged board lays out nothing', () => {
    expect(tagGraphLayout([card('x', []), connector('e')]).nodes).toHaveLength(0);
  });
});

describe('boardTagSuggestions', () => {
  it('suggests the tag most co-occurring with a card’s current tags', () => {
    const sugg = boardTagSuggestions(board, ['design'], { measure: 'count' });
    expect(sugg[0].tag).toBe('ux');
    expect(sugg[0].from).toBe('design');
  });
});

describe('TagAffinityReadout component', () => {
  it('renders the tag network + a ranked go-together list; clicking a node selects its cards', () => {
    const picks: string[] = [];
    const { container } = render(<TagAffinityReadout items={board} onPickTag={(t) => picks.push(t)} />);
    expect(container.querySelector('[data-tag-graph]')).toBeTruthy();
    const nodes = container.querySelectorAll('[data-tag-node]');
    expect(nodes.length).toBe(5);
    fireEvent.click(container.querySelector('[data-tag-node="design"]')!);
    expect(picks).toEqual(['design']);
    expect(container.textContent).toMatch(/together/);
  });
  it('shows a friendly empty state when no card is tagged', () => {
    const { container } = render(<TagAffinityReadout items={[card('x', [])]} />);
    expect(container.querySelector('[data-tag-graph]')).toBeNull();
    expect(container.textContent).toMatch(/tag a few cards/i);
  });
  it('renders the "you might also tag" strip for a focused card', () => {
    const { container } = render(<TagAffinityReadout items={board} focusTags={['design']} measure="count" />);
    expect(container.textContent).toMatch(/might also tag/i);
    expect(container.textContent).toMatch(/\+ ux/);
  });
  it('a suggestion chip WRITES via onAddTag when given (not select)', () => {
    const added: string[] = [];
    const picked: string[] = [];
    const { getByText } = render(
      <TagAffinityReadout items={board} focusTags={['design']} measure="count" onAddTag={(t) => added.push(t)} onPickTag={(t) => picked.push(t)} />,
    );
    fireEvent.click(getByText('+ ux'));
    expect(added).toEqual(['ux']); // the write handler fired
    expect(picked).toEqual([]); // NOT the select handler
  });
  it('a suggestion chip falls back to onPickTag when no onAddTag is given', () => {
    const picked: string[] = [];
    const { getByText } = render(
      <TagAffinityReadout items={board} focusTags={['design']} measure="count" onPickTag={(t) => picked.push(t)} />,
    );
    fireEvent.click(getByText('+ ux'));
    expect(picked).toEqual(['ux']);
  });
});
