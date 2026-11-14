// packages/group/read-data/item-lock-predicate.test.ts
//
// The ONE canonical lock predicate (L030/SSOT). Before this, `extra.locked === true`
// was spelled inline ~24× across GroupBoardPanel/batch-actions/board-layer-rows — every
// mutation guard (nudge, delete, drag, group resize/rotate, batch op, duplicate, alt-drag)
// re-derived the same rule. These tests pin the single owner so a future lock model change
// (levels, reasons) has one place to move.

import { describe, expect, it } from 'vitest';
import { itemIsLocked, type BoardItem } from './group-board-model';

const item = (extra?: Record<string, unknown>): BoardItem =>
  ({ memberId: 'm', kind: 'note', x: 0, y: 0, ...(extra ? { extra } : {}) } as unknown as BoardItem);

describe('itemIsLocked — canonical lock predicate', () => {
  it('locked ONLY when extra.locked === true (strict boolean true)', () => {
    expect(itemIsLocked(item({ locked: true }))).toBe(true);
  });

  it('every non-true / absent shape is UNLOCKED (back-compat: legacy items freely editable)', () => {
    // These are exactly the values the old inline `!== true` guards let through — each
    // must remain unlocked, never accidentally locked by a truthy-but-not-true value.
    for (const bad of [undefined, null, false, 0, 1, '', 'true', 'yes', {}, []]) {
      expect(itemIsLocked(item({ locked: bad as unknown }))).toBe(false);
    }
    expect(itemIsLocked(item())).toBe(false); // no extra at all
    expect(itemIsLocked(item({}))).toBe(false); // extra present, no locked key
  });

  it('is a pure boolean function (no throw on a bare item, no mutation)', () => {
    const it0 = item({ locked: true });
    const snap = JSON.stringify(it0);
    expect(typeof itemIsLocked(it0)).toBe('boolean');
    expect(JSON.stringify(it0)).toBe(snap);
  });
});
