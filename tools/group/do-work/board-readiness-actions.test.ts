// packages/group/do-work/board-readiness-actions.test.ts
import { describe, it, expect } from 'vitest';
import {
  boardReadiness,
  readyCardIds,
  boardHasReadyCards,
  nextActionsText,
  DEFAULT_PREREQ_SPEC,
} from './board-readiness-actions';
import type { BoardItem } from '../read-data/group-board-model';

// A card carrying a metric so cardCompletion is defined; `pct` in [0,1] via current/target.
const card = (memberId: string, text: string, pct?: number): BoardItem =>
  ({
    kind: 'note',
    memberId,
    x: 0,
    y: 0,
    w: 100,
    h: 40,
    text,
    extra: pct === undefined ? {} : { metric: { current: pct * 10, target: 10 } },
  } as unknown as BoardItem);
const section = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, isSection: true, x: 0, y: 0, w: 100, h: 40, text: '', extra: {} } as unknown as BoardItem);
// A DEPENDS-ON connector from -> to: "from depends-on to" => `to` gates `from` under DEFAULT_PREREQ_SPEC.
const dep = (memberId: string, from: string, to: string): BoardItem =>
  ({
    kind: 'connector',
    memberId,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    extra: { fromMemberId: from, toMemberId: to, relationKind: 'depends-on' },
  } as unknown as BoardItem);
const relatesTo = (memberId: string, from: string, to: string): BoardItem =>
  ({
    kind: 'connector',
    memberId,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    extra: { fromMemberId: from, toMemberId: to, relationKind: 'relates-to' },
  } as unknown as BoardItem);

describe('boardReadiness', () => {
  it('classifies done / ready / blocked from dependency edges + completion', () => {
    const items = [
      card('e', 'Finished thing', 1), // done
      card('a', 'Do A', 0), // depends on b (done) -> ready
      card('b', 'Prereq B', 1),
      dep('c1', 'a', 'b'),
      card('c', 'Do C', 0), // depends on d (half done) -> blocked
      card('d', 'Prereq D', 0.5),
      dep('c2', 'c', 'd'),
      card('f', 'Standalone', 0.2), // no deps -> ready
    ];
    const byId = Object.fromEntries(boardReadiness(items).map((r) => [r.cardId, r]));
    expect(byId.e.status).toBe('done');
    expect(byId.a.status).toBe('ready');
    expect(byId.b.status).toBe('done');
    expect(byId.c.status).toBe('blocked');
    expect(byId.c.blockedBy).toEqual(['d']);
    expect(byId.f.status).toBe('ready');
  });

  it('excludes connectors and sections from the classification', () => {
    const items = [card('a', 'A', 0), section('sec'), dep('c1', 'a', 'a')];
    const ids = boardReadiness(items).map((r) => r.cardId);
    expect(ids).toEqual(['a']); // the connector + section are not cards
  });

  it('a non-dependency relation (relates-to) does NOT gate under the default depends-on spec', () => {
    const items = [card('a', 'A', 0), card('b', 'B', 0.3), relatesTo('c1', 'a', 'b')];
    // b is incomplete but only RELATES to a — not a prerequisite -> a is ready, not blocked.
    expect(boardReadiness(items).find((r) => r.cardId === 'a')?.status).toBe('ready');
  });

  it('the default prereq spec is depends-on / childEndpoint to', () => {
    expect(DEFAULT_PREREQ_SPEC).toEqual({ relationKind: 'depends-on', childEndpoint: 'to' });
  });
});

describe('readyCardIds / boardHasReadyCards', () => {
  const items = [
    card('a', 'A', 0),
    card('b', 'B', 1),
    dep('c1', 'a', 'b'), // a ready (b done)
    card('z', 'Z', 0.1), // ready (no deps)
  ];
  it('readyCardIds is the sorted ready frontier', () => {
    expect(readyCardIds(items)).toEqual(['a', 'z']);
  });
  it('boardHasReadyCards is true when a frontier exists', () => {
    expect(boardHasReadyCards(items)).toBe(true);
  });
  it('boardHasReadyCards is false when every unfinished card is blocked', () => {
    const blockedOnly = [card('a', 'A', 0), card('b', 'B', 0.5), dep('c1', 'a', 'b')];
    // a blocked by b; b itself is ready though... so use a chain where the only unfinished is blocked:
    const chain = [card('a', 'A', 0), card('b', 'B', 0.5), card('m', 'M', 1), dep('c1', 'a', 'b'), dep('c2', 'b', 'a')];
    expect(boardHasReadyCards(chain)).toBe(false); // a<->b mutually block; m is done
    expect(boardHasReadyCards(blockedOnly)).toBe(true); // b (0.5, no deps) is ready
  });
});

describe('nextActionsText', () => {
  it('renders Ready + Blocked sections by human label', () => {
    const items = [
      card('a', 'Book the venue', 0),
      card('b', 'Get budget approved', 1),
      dep('c1', 'a', 'b'), // a ready
      card('c', 'Send invites', 0),
      card('d', 'Finalize guest list', 0.5),
      dep('c2', 'c', 'd'), // c blocked on d
    ];
    const text = nextActionsText(items, DEFAULT_PREREQ_SPEC, 'Party');
    expect(text).toContain('# Party');
    // 'a' (deps cleared) AND 'd' (no deps, half-done) are both actionable now; 'c' waits on 'd'.
    expect(text).toContain('## Ready to start (2)');
    expect(text).toContain('- Book the venue');
    expect(text).toContain('- Finalize guest list');
    expect(text).toContain('## Blocked (1)');
    expect(text).toContain('- Send invites — waiting on: Finalize guest list');
  });

  it('is the honest empty line when there are no actionable cards', () => {
    expect(nextActionsText([], DEFAULT_PREREQ_SPEC)).toBe('No actionable cards');
    // a board of only done cards -> nothing ready, nothing blocked.
    expect(nextActionsText([card('a', 'A', 1)], DEFAULT_PREREQ_SPEC)).toBe('No actionable cards');
  });
});
