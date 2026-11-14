// Proof for the board DIGEST: the headline priority ladder fires in the right order (overdue beats close
// beats attention beats momentum beats untracked beats steady), the counts reduce the real lenses, and a
// headline is ALWAYS produced (the catch-all). The digest is a pure composition of the shipped readings.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemMetric } from './board-metric-actions';
import { setItemDueDate } from './board-due-date-actions';
import { logMinutes } from './board-time-log-actions';
import { boardDigest, digestHeadline, digestText, DIGEST_HEADLINES } from './board-digest-actions';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function seed(ids: string[]) {
  let g = emptyGraph();
  for (const id of ids) g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id } }, w: 100, h: 60, kind: 'note', memberId: id, x: 0, y: 0, text: id } as never);
  return g;
}
const digestOf = (g: ReturnType<typeof emptyGraph>) => boardDigest(readItems(g, PARENT), null, NOW);

describe('board-digest-actions — board self-assessment + headline ladder', () => {
  it('an empty board reports the untracked headline (nothing to track yet)', () => {
    const d = boardDigest([], null, NOW);
    expect(d.tracked).toBe(0);
    expect(d.headline).toBe('No goals tracked yet — add a metric or a due date to start.');
  });

  it('overdue wins the headline even when other lenses also fire (highest priority)', () => {
    let g = seed(['a', 'b']);
    g = setItemDueDate(g, PARENT, 'a', NOW - 5 * DAY); // overdue
    g = setItemMetric(g, PARENT, 'a', { current: 5, target: 10 });
    g = setItemMetric(g, PARENT, 'b', { current: 9, target: 10 }); // 90% → also a finish-line candidate
    const d = digestOf(g);
    expect(d.overdueCount).toBe(1);
    expect(d.finishLineCount).toBeGreaterThan(0); // the close card is present...
    expect(d.headline).toBe('1 goal overdue — triage today.'); // ...but overdue still wins
  });

  it('with nothing overdue, "close to done" beats momentum (finish-line priority)', () => {
    let g = seed(['a']);
    g = setItemMetric(g, PARENT, 'a', { current: 9, target: 10 }); // 90% → finish-line AND momentum(near-complete)
    g = logMinutes(g, PARENT, 'a', 120, NOW); // also worked today → momentum recent-effort
    const d = digestOf(g);
    expect(d.overdueCount).toBe(0);
    expect(d.finishLineCount).toBe(1);
    expect(d.momentumCount).toBe(1);
    expect(d.headline).toBe(`You're close on 1 goal — finish those first.`);
  });

  it('pure momentum (worked today, far from done) gets the momentum headline', () => {
    let g = seed(['a']);
    g = setItemMetric(g, PARENT, 'a', { current: 3, target: 10 }); // 30% → NOT finish-line
    g = logMinutes(g, PARENT, 'a', 120, NOW); // recent effort → momentum
    const d = digestOf(g);
    expect(d.finishLineCount).toBe(0);
    expect(d.momentumCount).toBe(1);
    expect(d.headline).toBe('1 goal on a roll — keep it up.');
  });

  it('tracked but quiet (a mid-progress card, no deadline, no effort) → steady catch-all', () => {
    let g = seed(['a']);
    g = setItemMetric(g, PARENT, 'a', { current: 4, target: 10 }); // 40% tracked, nothing slipping/close/moving
    const d = digestOf(g);
    expect(d.tracked).toBe(1);
    expect(d.attentionCount).toBe(0);
    expect(d.momentumCount).toBe(0);
    expect(d.finishLineCount).toBe(0);
    expect(d.headline).toBe('Steady — 0/1 done, nothing urgent.');
  });

  it('the ladder always yields a headline (catch-all present) and pluralizes 1 vs N', () => {
    // digestHeadline is total over any facts — the last rule is unconditional.
    const base = { tracked: 5, complete: 1, avgPct: 40, overdueCount: 0, attentionCount: 0, momentumCount: 0, finishLineCount: 0, topAttention: null, topMomentum: null, topFinishLine: null, next: null };
    expect(digestHeadline({ ...base, overdueCount: 2 })).toBe('2 goals overdue — triage today.');
    expect(digestHeadline({ ...base, finishLineCount: 1 })).toBe(`You're close on 1 goal — finish those first.`);
    expect(DIGEST_HEADLINES[DIGEST_HEADLINES.length - 1].when(base)).toBe(true); // catch-all
  });
});

describe('digestText — shareable status narrative', () => {
  it('an empty board is just the untracked headline (no lens lines, no next)', () => {
    expect(digestText(boardDigest([], null, NOW))).toBe('No goals tracked yet — add a metric or a due date to start.');
  });

  it('leads with the headline, lists each firing lens (count + top card), and the next action', () => {
    let g = seed(['late', 'close']);
    g = setItemDueDate(g, PARENT, 'late', NOW - 5 * DAY); // overdue -> attention + next
    g = setItemMetric(g, PARENT, 'late', { current: 2, target: 10 });
    g = setItemMetric(g, PARENT, 'close', { current: 9, target: 10 }); // 90% -> finish-line
    const out = digestText(digestOf(g));
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('1 goal overdue — triage today.'); // headline leads
    expect(lines.some((l) => l.startsWith('Needs attention (1): late'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Almost there (1): close'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Next: late — '))).toBe(true);
  });

  it('a title prefixes the headline line', () => {
    const out = digestText(boardDigest([], null, NOW), 'My Vision');
    expect(out.split('\n')[0]).toBe('My Vision — No goals tracked yet — add a metric or a due date to start.');
  });
});
