// packages/group/show/selection-actions.test.ts
//
// Proves the DATA-driven selection action model: each action's run() delegates to the right leaf, and enabled()
// hides dead no-op rows (L118) — expand actions only when the board has connectors, "Select same <dim>" only
// when a seed carries that dimension's value, and the "same" rows are GENERATED from BOARD_DIMENSIONS (zero
// hand-listing).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { SELECTION_ACTIONS, enabledSelectionActions } from './selection-actions';

const note = (memberId: string, tags: string[] = []): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: { tags } } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

const byId = (id: string) => SELECTION_ACTIONS.find((a) => a.id === id)!;

describe('SELECTION_ACTIONS run()', () => {
  const items = [note('a', ['work']), note('b', ['work']), note('c', ['home']), conn('ab', 'a', 'b')];
  it('all → every member id; invert → the complement; clear → []', () => {
    expect(byId('all').run(items, [])).toEqual(['a', 'b', 'c', 'ab']);
    expect(byId('invert').run(items, ['a'])).toEqual(['b', 'c', 'ab']);
    expect(byId('clear').run(items, ['a', 'b'])).toEqual([]);
  });
  it('grow → +1 hop over the relation graph; connected → the whole component', () => {
    expect(byId('grow').run(items, ['a']).sort()).toEqual(['a', 'b']);
    expect(byId('connected').run(items, ['a']).sort()).toEqual(['a', 'b']);
  });
  it('same-tag (generated from BOARD_DIMENSIONS) → cards sharing the seed tag', () => {
    expect(byId('same-tag').run(items, ['a']).sort()).toEqual(['a', 'b']); // both 'work', c is 'home'
  });
});

describe('enabledSelectionActions gating (L118 — hide dead rows)', () => {
  it('with a selection + connectors: basic + expand + same-tag all present', () => {
    const items = [note('a', ['work']), note('b', ['work']), conn('ab', 'a', 'b')];
    const ids = enabledSelectionActions(items, ['a']).map((a) => a.id);
    expect(ids).toContain('grow');
    expect(ids).toContain('connected');
    expect(ids).toContain('same-tag');
    expect(ids).toContain('invert');
  });
  it('no connectors → expand actions hidden; no seed tag → same-tag hidden', () => {
    const items = [note('a'), note('b')]; // no connectors, seed a has no tags
    const ids = enabledSelectionActions(items, ['a']).map((a) => a.id);
    expect(ids).not.toContain('grow');
    expect(ids).not.toContain('connected');
    expect(ids).not.toContain('same-tag');
    expect(ids).toContain('invert'); // basic still available
    expect(ids).toContain('all');
  });
  it('empty selection → only "Select all" (nothing to invert/grow/match)', () => {
    const items = [note('a', ['work']), conn('x', 'a', 'a')];
    const ids = enabledSelectionActions(items, []).map((a) => a.id);
    expect(ids).toEqual(['all']);
  });
});
