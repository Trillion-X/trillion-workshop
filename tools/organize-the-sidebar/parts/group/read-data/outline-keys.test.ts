// packages/group/read-data/outline-keys.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { handleOutlineKey } from '../../../read-data/outline-keys.ts';
import type { ListItem } from '../../../read-data/list-block-model.ts';

const rows = (...specs: Array<[string, number, string?]>): ListItem[] =>
  specs.map(([id, indent, text]) => ({ id, indent, text: text ?? id }));

describe('handleOutlineKey — the outliner keyboard grammar', () => {
  it('Tab indents the row (keeps focus)', () => {
    const r = handleOutlineKey(rows(['a', 0], ['b', 0]), 'b', 'Tab', false, false, 'x');
    expect(r?.items.map((i) => i.indent)).toEqual([0, 1]);
    expect(r?.focusId).toBe('b');
  });

  it('Tab cannot indent past the legality rule (no skipped levels)', () => {
    // 'a' is first → pinned at 0; Tab is a no-op indent
    const r = handleOutlineKey(rows(['a', 0]), 'a', 'Tab', false, false, 'x');
    expect(r?.items.map((i) => i.indent)).toEqual([0]);
  });

  it('Shift+Tab outdents and normalizes', () => {
    const r = handleOutlineKey(rows(['a', 0], ['b', 1]), 'b', 'Tab', true, false, 'x');
    expect(r?.items.map((i) => i.indent)).toEqual([0, 0]);
    expect(r?.focusId).toBe('b');
  });

  it('Enter inserts a new empty sibling below at the same indent and focuses it', () => {
    const r = handleOutlineKey(rows(['a', 0], ['b', 1]), 'a', 'Enter', false, false, 'x');
    expect(r?.items.map((i) => i.id)).toEqual(['a', 'x', 'b']);
    expect(r?.items[1]).toEqual({ id: 'x', text: '', indent: 0 });
    expect(r?.focusId).toBe('x');
  });

  it('Backspace on an EMPTY row deletes it and focuses the previous row', () => {
    const r = handleOutlineKey(rows(['a', 0], ['b', 0, '']), 'b', 'Backspace', false, true, 'x');
    expect(r?.items.map((i) => i.id)).toEqual(['a']);
    expect(r?.focusId).toBe('a');
  });

  it('Backspace on a NON-empty row is not handled (normal caret delete)', () => {
    expect(handleOutlineKey(rows(['a', 0], ['b', 0]), 'b', 'Backspace', false, false, 'x')).toBeNull();
  });

  it('Backspace never deletes the only row', () => {
    expect(handleOutlineKey(rows(['a', 0, '']), 'a', 'Backspace', false, true, 'x')).toBeNull();
  });

  it('a plain character key is not an outline command (returns null → normal typing)', () => {
    expect(handleOutlineKey(rows(['a', 0]), 'a', 'k', false, false, 'x')).toBeNull();
  });

  it('an unknown id returns null', () => {
    expect(handleOutlineKey(rows(['a', 0]), 'ghost', 'Tab', false, false, 'x')).toBeNull();
  });
});
