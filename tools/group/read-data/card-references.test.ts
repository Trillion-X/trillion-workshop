// packages/group/read-data/card-references.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  wikilinkTitles,
  buildTitleIndex,
  cardReferences,
  backlinksOf,
  referencesFrom,
  brokenReferences,
  brokenReferencesFrom,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-references.ts';
import type { BoardItem } from './group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text, extra: {} } as unknown as BoardItem);

describe('normalizeTitle', () => {
  it('lowercases, trims, collapses whitespace', () => {
    expect(normalizeTitle('  Buy A   House ')).toBe('buy a house');
  });
});

describe('wikilinkTitles', () => {
  it('extracts the inner titles of every [[…]], trimmed, in order', () => {
    expect(wikilinkTitles('see [[Buy a house]] then [[ Save money ]]')).toEqual(['Buy a house', 'Save money']);
  });
  it('ignores empty brackets and text with none', () => {
    expect(wikilinkTitles('[[]] and [[   ]]')).toEqual([]);
    expect(wikilinkTitles('a plain note')).toEqual([]);
  });
});

describe('buildTitleIndex', () => {
  it('maps normalized title → the FIRST card with it (reading order wins)', () => {
    const index = buildTitleIndex([card('a', 'Goal'), card('b', 'goal'), card('c', 'Other')]);
    expect(index.get('goal')).toBe('a'); // first wins
    expect(index.get('other')).toBe('c');
  });
  it('uses only the first line as the title', () => {
    const index = buildTitleIndex([card('a', 'Buy a house\nby 2027')]);
    expect(index.get('buy a house')).toBe('a');
  });
});

describe('cardReferences', () => {
  const items = [
    card('house', 'Buy a house'),
    card('money', 'Save money\nfor the down payment'),
    card('plan', 'Depends on [[Save money]] and [[Buy a house]]'),
    card('self', 'a note about [[itself]]\nitself'), // self-reference
    card('dead', 'blocked by [[Nonexistent]]'),
  ];

  it('resolves [[Title]] mentions to the titled cards (directed edges)', () => {
    const refs = cardReferences(items);
    expect(refs.filter((r) => r.from === 'plan').map((r) => r.to).sort()).toEqual(['house', 'money']);
  });
  it('drops self-references and unresolved titles', () => {
    const refs = cardReferences(items);
    expect(refs.some((r) => r.from === 'self')).toBe(false); // self-link dropped
    expect(refs.some((r) => r.from === 'dead')).toBe(false); // [[Nonexistent]] unresolved
  });
  it('emits one edge per (from,to) pair even with repeated mentions', () => {
    const refs = cardReferences([card('house', 'Buy a house'), card('x', '[[Buy a house]] again [[buy a house]]')]);
    expect(refs.filter((r) => r.from === 'x' && r.to === 'house')).toHaveLength(1);
  });
});

describe('backlinksOf / referencesFrom', () => {
  const items = [
    card('house', 'Buy a house'),
    card('a', 'plan for [[Buy a house]]'),
    card('b', 'also want [[Buy a house]]'),
  ];
  const refs = cardReferences(items);

  it('backlinksOf lists the cards linking TO a card, sorted', () => {
    expect(backlinksOf(refs, 'house')).toEqual(['a', 'b']);
    expect(backlinksOf(refs, 'a')).toEqual([]); // nothing links to a
  });
  it('referencesFrom lists the cards a card links to', () => {
    expect(referencesFrom(refs, 'a')).toEqual(['house']);
  });
});

describe('brokenReferences', () => {
  it('flags [[Title]] mentions that name no card, deduped per (card,title)', () => {
    const items = [card('house', 'Buy a house'), card('x', 'need [[Buy a house]] and [[Win lottery]] and [[win lottery]]')];
    expect(brokenReferences(items)).toEqual([{ from: 'x', title: 'Win lottery' }]);
  });
  it('is empty when every reference resolves', () => {
    expect(brokenReferences([card('house', 'Buy a house'), card('x', 'get [[Buy a house]]')])).toEqual([]);
  });
});

describe('brokenReferencesFrom', () => {
  it('lists only the DISTINCT broken titles typed by one card, display form preserved', () => {
    const items = [
      card('house', 'Buy a house'),
      card('x', 'need [[Buy a house]], [[Win lottery]], [[win lottery]] and [[Retire early]]'),
      card('y', 'also [[Move abroad]]'),
    ];
    expect(brokenReferencesFrom(items, 'x')).toEqual(['Win lottery', 'Retire early']); // [[Buy a house]] resolves; win-lottery deduped
    expect(brokenReferencesFrom(items, 'y')).toEqual(['Move abroad']);
    expect(brokenReferencesFrom(items, 'house')).toEqual([]); // house types no broken refs
  });
});
