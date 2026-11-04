// Proof for the checklist primitive: fail-closed normalize, progress fraction, toggle/add/rename/remove,
// and the whole-board rollup.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  type ChecklistItem,
  type ChecklistedItem,
  addChecklistItem,
  boardChecklistRollup,
  checklistFromRaw,
  checklistProgress,
  hasChecklist,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
  toggleChecklistItem,
} from '../../../read-data/board-checklist.ts';

const step = (id: string, text: string, done = false): ChecklistItem => ({ id, text, done });

describe('board-checklist — the item-checklist primitive', () => {
  it('checklistFromRaw is fail-closed: non-array → [], malformed steps dropped', () => {
    expect(checklistFromRaw(undefined)).toEqual([]);
    expect(checklistFromRaw({})).toEqual([]);
    const l = checklistFromRaw([step('a', 'do a'), { id: 'b' }, { id: 'c', text: 'x', done: 'no' }, step('d', 'do d', true)]);
    expect(l.map((s) => s.id)).toEqual(['a', 'd']); // b (no text/done), c (done not boolean) dropped
  });

  it('checklistProgress: done/total/fraction/complete, empty is 0 (no divide-by-zero)', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, fraction: 0, complete: false });
    expect(checklistProgress([step('a', 'x', true), step('b', 'y', false)])).toEqual({ done: 1, total: 2, fraction: 0.5, complete: false });
    expect(checklistProgress([step('a', 'x', true)]).complete).toBe(true);
    expect(hasChecklist([])).toBe(false);
    expect(hasChecklist([step('a', 'x')])).toBe(true);
  });

  it('addChecklistItem rejects a DUPLICATE id — no two steps toggle/complete as one', () => {
    // Two steps sharing an id would both flip on a single toggle and double-count in progress. The writer
    // must reject the collision so it never enters the list.
    const l = addChecklistItem([step('a', 'first')], step('a', 'second'));
    expect(l.map((s) => s.id)).toEqual(['a']); // the duplicate is not appended
    expect(l[0].text).toBe('first'); // the original is untouched
    const toggled = toggleChecklistItem(l, 'a');
    expect(checklistProgress(toggled)).toEqual({ done: 1, total: 1, fraction: 1, complete: true }); // 1 step, not 2
  });

  it('toggle + setDone flip a step; others untouched', () => {
    const l = [step('a', 'x'), step('b', 'y')];
    expect(toggleChecklistItem(l, 'a').find((s) => s.id === 'a')!.done).toBe(true);
    expect(toggleChecklistItem(l, 'a').find((s) => s.id === 'b')!.done).toBe(false);
    expect(setChecklistItemDone(l, 'b', true).find((s) => s.id === 'b')!.done).toBe(true);
  });

  it('add appends + trims, rejects blank; rename trims + ignores blank; remove drops', () => {
    let l = addChecklistItem([], step('a', '  first  '));
    expect(l).toEqual([{ id: 'a', text: 'first', done: false }]);
    expect(addChecklistItem(l, step('b', '   '))).toBe(l); // blank rejected → unchanged
    l = renameChecklistItem(l, 'a', ' updated ');
    expect(l[0].text).toBe('updated');
    expect(renameChecklistItem(l, 'a', '  ')).toBe(l); // blank ignored → unchanged
    expect(removeChecklistItem(l, 'a')).toEqual([]);
  });

  it('boardChecklistRollup sums done + total across every item', () => {
    const items: ChecklistedItem[] = [
      { id: 'n1', checklist: [step('a', 'x', true), step('b', 'y', false)] },
      { id: 'n2', checklist: [step('c', 'z', true)] },
      { id: 'n3', checklist: [] },
    ];
    expect(boardChecklistRollup(items)).toEqual({ done: 2, total: 3 });
  });
});

describe('board-checklist — hostile extra.checklist is capped + deduped (cont.98 batch-20)', () => {
  // Reachable via persisted item.extra (copied wholesale) + capsule/template import; board-momentum /
  // board-attention call checklistFromRaw once per item per compute, so an uncapped bomb hangs every render.
  it('a million-entry checklist is capped to <= 512', () => {
    const bomb = Array.from({ length: 1_000_000 }, (_, i) => ({ id: `s${i}`, text: 't', done: false }));
    const list = checklistFromRaw(bomb);
    expect(list.length).toBe(512);
  });
  it('duplicate ids are deduped at READ time (progress counts each step once)', () => {
    // Two DONE steps sharing id 'x' would double-count done/total on the old read path (write path already dedups).
    const raw = [{ id: 'x', text: 'a', done: true }, { id: 'x', text: 'b', done: true }, { id: 'y', text: 'c', done: false }];
    const list = checklistFromRaw(raw);
    expect(list.length).toBe(2); // x once + y
    const p = checklistProgress(list);
    expect(p).toEqual({ done: 1, total: 2, fraction: 0.5, complete: false }); // not 2/3 from a doubled 'x'
  });
  it('an all-junk bomb is O(1)-bounded (scan cap), returns empty', () => {
    const junk = Array.from({ length: 1_000_000 }, () => ({ nope: 1 }));
    expect(checklistFromRaw(junk)).toEqual([]);
  });
});
