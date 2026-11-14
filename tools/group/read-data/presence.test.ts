// packages/group/read-data/presence.test.ts
import { describe, it, expect } from 'vitest';
import {
  activeParticipants,
  colorForParticipant,
  EMPTY_PRESENCE,
  presenceSummary,
  pruneStale,
  removePresence,
  upsertPresence,
  type Participant,
} from './presence';

const peer = (id: string, ts: number, over: Partial<Participant> = {}): Participant => ({
  id,
  name: id.toUpperCase(),
  ts,
  ...over,
});

describe('upsertPresence', () => {
  it('adds and replaces a participant', () => {
    let s = upsertPresence(EMPTY_PRESENCE, peer('a', 10, { cursor: { x: 1, y: 1 } }));
    s = upsertPresence(s, peer('a', 20, { cursor: { x: 9, y: 9 } }));
    expect(s.a.cursor).toEqual({ x: 9, y: 9 });
  });

  it('ignores an out-of-order (older ts) update — no cursor rewind', () => {
    let s = upsertPresence(EMPTY_PRESENCE, peer('a', 20, { cursor: { x: 9, y: 9 } }));
    s = upsertPresence(s, peer('a', 10, { cursor: { x: 1, y: 1 } }));
    expect(s.a.cursor).toEqual({ x: 9, y: 9 });
  });

  it('order-independent for a single participant (newest ts always wins)', () => {
    const updates = [peer('a', 10), peer('a', 30), peer('a', 20)];
    const forward = updates.reduce(upsertPresence, EMPTY_PRESENCE);
    const reversed = [...updates].reverse().reduce(upsertPresence, EMPTY_PRESENCE);
    expect(forward.a.ts).toBe(30);
    expect(reversed.a.ts).toBe(30);
  });
});

describe('activeParticipants', () => {
  it('excludes self, drops stale, sorts by id', () => {
    let s = EMPTY_PRESENCE;
    s = upsertPresence(s, peer('c', 100));
    s = upsertPresence(s, peer('a', 100));
    s = upsertPresence(s, peer('me', 100));
    s = upsertPresence(s, peer('old', 10)); // stale at now=100, ttl=50
    const active = activeParticipants(s, 100, 50, 'me');
    expect(active.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('pruneStale', () => {
  it('removes only stale participants and preserves identity when unchanged', () => {
    let s = EMPTY_PRESENCE;
    s = upsertPresence(s, peer('a', 100));
    s = upsertPresence(s, peer('b', 40));
    const pruned = pruneStale(s, 100, 50);
    expect(Object.keys(pruned)).toEqual(['a']);
    expect(pruneStale(pruned, 100, 50)).toBe(pruned); // no change → same ref
  });
});

describe('removePresence', () => {
  it('drops a participant and no-ops when absent', () => {
    const s = upsertPresence(EMPTY_PRESENCE, peer('a', 1));
    expect(removePresence(s, 'a').a).toBeUndefined();
    expect(removePresence(s, 'ghost')).toBe(s);
  });
});

describe('colorForParticipant', () => {
  it('is deterministic and stable per id', () => {
    expect(colorForParticipant('alice')).toBe(colorForParticipant('alice'));
    expect(colorForParticipant('alice')).not.toBe(colorForParticipant('bob'));
    expect(colorForParticipant('alice')).toMatch(/^hsl\(\d+ 68% 45%\)$/);
  });
});

describe('presenceSummary', () => {
  it('reads naturally for 0 / 1 / many', () => {
    expect(presenceSummary(0)).toBe('Only you');
    expect(presenceSummary(1)).toBe('1 other here');
    expect(presenceSummary(3)).toBe('3 others here');
  });
});
