// packages/group/read-data/board-importance.test.ts
import { describe, it, expect } from 'vitest';
import { importanceRanks, importanceValue, mostImportant } from './board-importance';
import type { BoardItem } from './group-board-model';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);
// A directed connector from -> to ("from endorses to").
const edge = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

describe('importanceRanks', () => {
  it('empty board → empty map; edgeless board → uniform 1/N', () => {
    expect(importanceRanks([]).size).toBe(0);
    const r = importanceRanks([card('a'), card('b'), card('c')]);
    expect(r.get('a')).toBeCloseTo(1 / 3, 6);
    expect(r.get('b')).toBeCloseTo(1 / 3, 6);
  });

  it('ranks sum to ~1 (rank is conserved, dangling mass redistributed)', () => {
    const items = [card('a'), card('b'), card('c'), card('d'), edge('e1', 'a', 'b'), edge('e2', 'c', 'b'), edge('e3', 'd', 'b')];
    const total = [...importanceRanks(items).values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('a card everyone points to outranks the cards pointing to it', () => {
    const items = [card('hub'), card('a'), card('b'), card('c'), edge('e1', 'a', 'hub'), edge('e2', 'b', 'hub'), edge('e3', 'c', 'hub')];
    const r = importanceRanks(items);
    expect(r.get('hub')!).toBeGreaterThan(r.get('a')!);
    expect(r.get('hub')!).toBeGreaterThan(r.get('b')!);
  });

  it('TRANSITIVITY beats raw degree — a card endorsed by the important cards outranks a card with MORE links to trivial leaves', () => {
    // Two big authorities H1, H2 (each pointed at by many leaves). H1 and H2 both point at `core`.
    // `spam` has MORE outgoing links, but only to trivial leaf cards. `core` (few links) must outrank `spam`.
    const items: BoardItem[] = [card('core'), card('spam'), card('h1'), card('h2')];
    // leaves feeding h1 and h2 → make them important
    for (let i = 0; i < 5; i += 1) {
      items.push(card(`l1_${i}`), edge(`e_l1_${i}`, `l1_${i}`, 'h1'));
      items.push(card(`l2_${i}`), edge(`e_l2_${i}`, `l2_${i}`, 'h2'));
    }
    // the two authorities endorse `core`
    items.push(edge('e_h1_core', 'h1', 'core'), edge('e_h2_core', 'h2', 'core'));
    // `spam` points to 6 trivial leaves (high out-degree, but endorses nobody important)
    for (let i = 0; i < 6; i += 1) items.push(card(`s_${i}`), edge(`e_s_${i}`, 'spam', `s_${i}`));
    const r = importanceRanks(items);
    expect(r.get('core')!).toBeGreaterThan(r.get('spam')!);
  });

  it('is deterministic (fixed iterations → identical ranks across runs)', () => {
    const build = () => [card('a'), card('b'), card('c'), edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')];
    expect([...importanceRanks(build()).entries()]).toEqual([...importanceRanks(build()).entries()]);
  });

  it('excludes connectors and sections from the ranking', () => {
    const items = [card('a'), { ...card('sec'), isSection: true } as BoardItem, edge('e1', 'a', 'a')];
    expect([...importanceRanks(items).keys()]).toEqual(['a']);
  });
});

describe('importanceValue / mostImportant', () => {
  const items = [card('hub'), card('a'), card('b'), edge('e1', 'a', 'hub'), edge('e2', 'b', 'hub')];
  it('importanceValue reads the map (0 when unranked)', () => {
    const r = importanceRanks(items);
    expect(importanceValue(r, 'hub')).toBe(r.get('hub'));
    expect(importanceValue(r, 'nope')).toBe(0);
  });
  it('mostImportant ranks highest-first with an id tie-break, and k caps', () => {
    expect(mostImportant(items)[0]).toBe('hub');
    expect(mostImportant(items, 1)).toEqual(['hub']);
  });
});
