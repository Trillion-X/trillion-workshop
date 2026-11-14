// packages/group/read-data/board-health.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  boardHealth,
  boardHealthText,
  cardIdsWithHealthIssues,
  boardHasHealthIssues,
  healthGrade,
  healthSignalDetails,
  type HealthSignal,
} from './board-health';

const card = (memberId: string, text = memberId, tags?: string[]): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: tags ? { tags } : {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

// A signal with a fixed result — lets the reducer math be exact + readable.
const fixed = (id: string, weight: number, affected: string[], eligible: number): HealthSignal =>
  ({ id, label: id, weight, detect: () => ({ affected, eligible }) });

describe('board-health — reducer (exact math via injected signals)', () => {
  const items = [card('a'), card('b'), card('c'), card('d')];

  it('all-clean signals → 100 / Excellent, nothing to fix', () => {
    const h = boardHealth(items, [fixed('x', 1, [], 4), fixed('y', 2, [], 4)]);
    expect(h.score).toBe(100);
    expect(h.grade).toBe('Excellent');
    expect(boardHealthText(items, undefined, [fixed('x', 1, [], 4)])).toBe('## Board health\n- Score: 100/100 (Excellent)\n- Nothing to fix');
  });

  it('single signal, half affected → 50 / Fair', () => {
    const h = boardHealth(items, [fixed('half', 1, ['a', 'b'], 4)]);
    expect(h.score).toBe(50);
    expect(h.grade).toBe('Fair');
  });

  it('weighted average across signals', () => {
    // sig1: ratio 1 weight 1; sig2: ratio 0 weight 3 → penalty = (1*1 + 3*0)/4 = 0.25 → score 75 (Good).
    const h = boardHealth(items, [fixed('bad', 1, ['a', 'b', 'c', 'd'], 4), fixed('good', 3, [], 4)]);
    expect(h.score).toBe(75);
    expect(h.grade).toBe('Good');
  });

  it('a not-applicable signal (eligible 0) neither penalizes nor dilutes', () => {
    // sig1 ratio 1 weight 1 (applicable); sig2 eligible 0 (excluded) → score = 0, not diluted to 50.
    const h = boardHealth(items, [fixed('bad', 1, ['a', 'b', 'c', 'd'], 4), fixed('na', 1, ['x'], 0)]);
    expect(h.score).toBe(0);
    expect(h.grade).toBe('Needs work');
    expect(h.breakdown.find((b) => b.id === 'na')!.applicable).toBe(false);
  });

  it('all signals not applicable → null score / "No cards"', () => {
    const h = boardHealth(items, [fixed('na', 1, [], 0)]);
    expect(h.score).toBeNull();
    expect(h.grade).toBe('No cards');
  });

  it('ratio clamps at 1 even if a detector over-reports', () => {
    const h = boardHealth(items, [fixed('over', 1, ['a', 'b', 'c'], 2)]); // 3 affected of 2 eligible
    expect(h.breakdown[0].ratio).toBe(1);
    expect(h.score).toBe(0);
  });

  it('healthGrade bands', () => {
    expect(healthGrade(95)).toBe('Excellent');
    expect(healthGrade(80)).toBe('Good');
    expect(healthGrade(60)).toBe('Fair');
    expect(healthGrade(10)).toBe('Needs work');
  });

  it('cardIdsWithHealthIssues unions affected + honest empty', () => {
    const sigs = [fixed('s1', 1, ['a', 'b'], 4), fixed('s2', 1, ['b', 'c'], 4)];
    expect(cardIdsWithHealthIssues(items, sigs)).toEqual(['a', 'b', 'c']);
    expect(boardHasHealthIssues(items, sigs)).toBe(true);
    expect(boardHasHealthIssues(items, [fixed('clean', 1, [], 4)])).toBe(false);
  });
});

describe('board-health — default signal catalog (integration)', () => {
  it('a connected, tagged, unambiguous board is clean (score 100)', () => {
    const items = [card('a', 'Alpha', ['x']), card('b', 'Beta', ['y']), conn('e1', 'a', 'b')];
    expect(boardHealth(items).score).toBe(100);
    expect(boardHasHealthIssues(items)).toBe(false);
  });

  it('an orphan card drags the score below 100 and is flagged + selectable', () => {
    const items = [card('a', 'Alpha', ['x']), card('b', 'Beta', ['y']), conn('e1', 'a', 'b'), card('c', 'Gamma', ['z'])];
    const h = boardHealth(items);
    expect(h.score).not.toBeNull();
    expect(h.score!).toBeLessThan(100);
    expect(h.breakdown.find((b) => b.id === 'orphans')!.affected).toBe(1);
    expect(cardIdsWithHealthIssues(items)).toContain('c');
  });

  it('a redundant CONNECTOR is scored but not put in a card selection', () => {
    const items = [card('a', 'Alpha', ['x']), card('b', 'Beta', ['y']), conn('e1', 'a', 'b'), conn('e2', 'a', 'b')];
    expect(boardHealth(items).breakdown.find((b) => b.id === 'duplicate-connectors')!.affected).toBe(1);
    expect(cardIdsWithHealthIssues(items).every((id) => id !== 'e2')).toBe(true);
  });

  it('untagged only counts once the board uses tags', () => {
    const noTags = [card('a', 'Alpha'), card('b', 'Beta'), conn('e1', 'a', 'b')];
    expect(boardHealth(noTags).breakdown.find((b) => b.id === 'untagged')!.applicable).toBe(false);
    const someTags = [card('a', 'Alpha', ['x']), card('b', 'Beta'), conn('e1', 'a', 'b')];
    const untagged = boardHealth(someTags).breakdown.find((b) => b.id === 'untagged')!;
    expect(untagged.applicable).toBe(true);
    expect(untagged.affected).toBe(1);
  });
});

describe('healthSignalDetails — the ids-bearing SSOT the score + the health lens both read', () => {
  it('returns the affected IDS (not just counts) per signal, with matching ratio/applicable', () => {
    const signals: HealthSignal[] = [
      fixed('a', 1, ['x', 'y'], 10), // 2/10 affected
      fixed('b', 1, [], 0), // eligible 0 → not applicable
    ];
    const details = healthSignalDetails([card('x'), card('y'), card('z')], signals);
    expect(details.map((d) => d.id)).toEqual(['a', 'b']);
    expect(details[0].affected).toEqual(['x', 'y']); // IDS preserved
    expect(details[0].ratio).toBeCloseTo(0.2);
    expect(details[0].applicable).toBe(true);
    expect(details[1].applicable).toBe(false); // eligible 0
    expect(details[1].ratio).toBe(0);
  });

  it('is the SSOT boardHealth derives from — count breakdown === details.affected.length', () => {
    const signals: HealthSignal[] = [fixed('a', 1, ['x', 'y'], 10), fixed('b', 2, ['z'], 4)];
    const items = [card('x'), card('y'), card('z')];
    const details = healthSignalDetails(items, signals);
    const breakdown = boardHealth(items, signals).breakdown;
    for (const b of breakdown) {
      expect(b.affected).toBe(details.find((d) => d.id === b.id)!.affected.length);
    }
  });
});
