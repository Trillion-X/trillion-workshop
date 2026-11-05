// packages/group/read-data/list-block-model.test.ts
//
// Pure proof of the outline-list STRUCTURE model. Exercises the single
// structural invariant (no item deeper than predecessor + 1; first item always
// 0) across indent / outdent / move / normalize, plus the purity contract: a
// FROZEN input never throws and is never mutated, unknown ids leave content
// deep-equal, and every returned array is a fresh top-level reference. No DOM.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  indentItem,
  outdentItem,
  normalizeIndents,
  type ListItem,
} from '../../../read-data/list-block-model.ts';
import { serializeOutline } from '../../../read-data/outline-text.ts';

/** Build a fresh list fixture for each test (so mutation across tests can't leak). */
function list(...rows: Array<[string, number]>): ListItem[] {
  return rows.map(([id, indent]) => ({ id, text: `text-${id}`, indent }));
}

/** Just the (id, indent) shape — the structural projection the tests assert on. */
function shape(items: readonly ListItem[]): Array<[string, number]> {
  return items.map((it) => [it.id, it.indent]);
}

describe('indentItem', () => {
  it('indents an item to one deeper than its predecessor (0 → 1)', () => {
    const items = list(['a', 0], ['b', 0]);
    expect(shape(indentItem(items, 'b'))).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('is clamped by predecessor + 1 — cannot jump 0 to 2', () => {
    // b already at 1 (legal under a@0). Indenting again would want 2, but the
    // ceiling is still predecessor(a=0) + 1 = 1, so it stays at 1.
    const items = list(['a', 0], ['b', 1]);
    expect(shape(indentItem(items, 'b'))).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('after a deeper predecessor, indent may go one deeper still (1 → 2)', () => {
    const items = list(['a', 0], ['b', 1], ['c', 1]);
    expect(shape(indentItem(items, 'c'))).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('the first item can never exceed indent 0', () => {
    const items = list(['a', 0], ['b', 0]);
    expect(shape(indentItem(items, 'a'))).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('unknown id → content unchanged', () => {
    const items = list(['a', 0], ['b', 1]);
    expect(shape(indentItem(items, 'zzz'))).toEqual(shape(items));
  });
});

describe('outdentItem', () => {
  it('outdents one level (2 → 1)', () => {
    const items = list(['a', 0], ['b', 1], ['c', 2]);
    expect(shape(outdentItem(items, 'c'))).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
    ]);
  });

  it('floors at 0 — outdenting a top-level item is a no-op in content', () => {
    const items = list(['a', 0], ['b', 0]);
    expect(shape(outdentItem(items, 'b'))).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('unknown id → content unchanged', () => {
    const items = list(['a', 0], ['b', 1]);
    expect(shape(outdentItem(items, 'nope'))).toEqual(shape(items));
  });
});

// (row REORDER moved to outline-move.ts — subtree-aware; see outline-move.test.ts)

describe('normalizeIndents', () => {
  it('fixes an over-deep jump [0,3] → [0,1]', () => {
    const items = list(['a', 0], ['b', 3]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('collapses a chain of jumps left-to-right [0,5,6] → [0,1,2]', () => {
    const items = list(['a', 0], ['b', 5], ['c', 6]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('pins the first item to 0 even if it started deeper', () => {
    const items = list(['a', 4], ['b', 4]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('leaves an already-legal list untouched in content', () => {
    const items = list(['a', 0], ['b', 1], ['c', 2], ['d', 1]);
    expect(shape(normalizeIndents(items))).toEqual(shape(items));
  });

  // --- Red-team: malformed indents must be clamped to the FULL legal range [0, ceiling],
  // not just the upper bound. A negative/NaN indent previously failed OPEN (the first row
  // escaped its pin to 0, and a negative indent later crashed serializeOutline). Convergence
  // audit cont.98 (independent self-review + Codex GPT-5.5 both hit the RangeError repro).
  it('pins a NEGATIVE first indent up to 0 (was: negative failed open past the pin)', () => {
    const items = list(['a', -1], ['b', 1]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 1], // a clamped to 0 → ceiling for b is 1, so b stays 1
    ]);
  });

  it('clamps a deep NEGATIVE indent up to 0 for a non-first item too', () => {
    const items = list(['a', 0], ['b', -5]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('treats a non-finite (NaN / Infinity) indent as 0 — malformed depth never survives', () => {
    const items = list(['a', Number.NaN], ['b', Number.POSITIVE_INFINITY]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0], // NaN is non-finite → 0
      ['b', 0], // Infinity is non-finite → 0 (never fed into the ceiling arithmetic)
    ]);
  });

  it('floors a non-integer indent before clamping ([0, 2.5] → [0, 1])', () => {
    const items = list(['a', 0], ['b', 2.5]);
    expect(shape(normalizeIndents(items))).toEqual([
      ['a', 0],
      ['b', 1], // floor(2.5)=2, ceiling 1 → min(2,1)=1
    ]);
  });

  it('a negative indent no longer crashes serializeOutline (RangeError on repeat(neg))', () => {
    const raw = list(['a', -3]);
    expect(() => serializeOutline(raw)).toThrow(); // proves the pre-fix crash was real
    expect(() => serializeOutline(normalizeIndents(raw))).not.toThrow();
    expect(serializeOutline(normalizeIndents(raw))).toBe('text-a');
  });
});

describe('purity & immutability', () => {
  it('unknown id → inputs deep-equal (indent/outdent/move all leave content intact)', () => {
    const items = list(['a', 0], ['b', 1]);
    const before = shape(items);
    indentItem(items, 'ghost');
    outdentItem(items, 'ghost');
    expect(shape(items)).toEqual(before);
  });

  it('a FROZEN input array (and its items) never throws and is never mutated', () => {
    const items = list(['a', 0], ['b', 0], ['c', 3]);
    Object.freeze(items);
    items.forEach((it) => Object.freeze(it));
    const before = shape(items);

    // None of these may throw or mutate the frozen input.
    expect(() => indentItem(items, 'b')).not.toThrow();
    expect(() => outdentItem(items, 'b')).not.toThrow();
    expect(() => normalizeIndents(items)).not.toThrow();

    expect(shape(items)).toEqual(before);
  });

  it('returns a NEW top-level array reference (never the same instance)', () => {
    const items = list(['a', 0], ['b', 0]);
    expect(indentItem(items, 'b')).not.toBe(items);
    expect(outdentItem(items, 'b')).not.toBe(items);
    expect(normalizeIndents(items)).not.toBe(items);
  });

  it('shares unchanged item objects by reference (structural sharing)', () => {
    const items = list(['a', 0], ['b', 0], ['c', 0]);
    const out = indentItem(items, 'b');
    // a and c were untouched → same object identity; b is a new object.
    expect(out[0]).toBe(items[0]);
    expect(out[2]).toBe(items[2]);
    expect(out[1]).not.toBe(items[1]);
  });
});
