import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { beginEditSession, endEditSession } from '../../../show/note-edit-session.ts';

describe('beginEditSession', () => {
  it('captures the before-snapshot and the member key', () => {
    const before = { v: 1 };
    const s = beginEditSession(before, 'note-7');
    expect(s.before).toBe(before);
    expect(s.key).toBe('note-7');
  });
});

describe('endEditSession', () => {
  it('returns null when there is no open session', () => {
    expect(endEditSession(null, { v: 2 })).toBeNull();
  });

  it('records ONE step {before, after} when the graph changed (reference default)', () => {
    const before = { v: 1 };
    const after = { v: 2 };
    const s = beginEditSession(before, 'n');
    expect(endEditSession(s, after)).toEqual({ before, after });
  });

  it('returns null when nothing changed (same reference) — no spurious undo step', () => {
    const g = { v: 1 };
    const s = beginEditSession(g, 'n');
    expect(endEditSession(s, g)).toBeNull();
  });

  it('uses a content-aware predicate when supplied (type-then-revert records nothing)', () => {
    // Two DIFFERENT graph objects but identical edited-note content → no step.
    const before = { note: { html: '<p>hi</p>' } };
    const after = { note: { html: '<p>hi</p>' } };
    const changed = (b: typeof before, a: typeof after) => b.note.html !== a.note.html;
    expect(endEditSession(beginEditSession(before, 'n'), after, changed)).toBeNull();
  });

  it('records a step when the content predicate reports a real change', () => {
    const before = { note: { html: '<p>hi</p>' } };
    const after = { note: { html: '<p>hi there</p>' } };
    const changed = (b: typeof before, a: typeof after) => b.note.html !== a.note.html;
    expect(endEditSession(beginEditSession(before, 'n'), after, changed)).toEqual({ before, after });
  });
});
