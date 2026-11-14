import { describe, expect, it } from 'vitest';
import { BOARD_SHORTCUTS } from './board-shortcuts';

describe('BOARD_SHORTCUTS catalog', () => {
  it('has groups, and every group has a non-empty heading and rows', () => {
    expect(BOARD_SHORTCUTS.length).toBeGreaterThan(0);
    for (const g of BOARD_SHORTCUTS) {
      expect(g.heading.trim().length).toBeGreaterThan(0);
      expect(g.rows.length).toBeGreaterThan(0);
    }
  });

  it('every row has a non-empty label and at least one key token', () => {
    for (const g of BOARD_SHORTCUTS) {
      for (const r of g.rows) {
        expect(r.label.trim().length).toBeGreaterThan(0);
        expect(r.keys.length).toBeGreaterThan(0);
        expect(r.keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
      }
    }
  });

  it('group headings are unique', () => {
    const headings = BOARD_SHORTCUTS.map((g) => g.heading);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('documents the canonical shortcuts (the ones the board actually wires)', () => {
    const labels = BOARD_SHORTCUTS.flatMap((g) => g.rows.map((r) => r.label));
    for (const expected of ['Undo', 'Redo', 'Duplicate', 'Copy', 'Cut', 'Paste', 'Select all', 'Group', 'Ungroup', 'Keyboard shortcuts']) {
      expect(labels).toContain(expected);
    }
  });
});
