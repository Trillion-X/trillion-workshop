// packages/group/show/board-selection-chrome-visibility.test.ts
// R53: the floating selection chrome (Board-tools rail + per-item toolbar) hides while
// inline-editing a card, and shows only when something is selected and NOT editing.
import { describe, it, expect } from 'vitest';
import { boardSelectionChromeVisible } from './board-selection-chrome-visibility';

describe('boardSelectionChromeVisible — R53 edit-mode chrome gate (SSOT)', () => {
  it('allows explicit saved-query access without a selection but still hides while writing', () => {
    expect(boardSelectionChromeVisible({ hasSelection: false, editing: false, explicitlyOpened: true })).toBe(true);
    expect(boardSelectionChromeVisible({ hasSelection: false, editing: true, explicitlyOpened: true })).toBe(false);
  });
  it('shows chrome when a card is selected and NOT editing', () => {
    expect(boardSelectionChromeVisible({ hasSelection: true, editing: false })).toBe(true);
  });

  it('HIDES chrome while inline-editing, even with a selection (the R53 fix)', () => {
    expect(boardSelectionChromeVisible({ hasSelection: true, editing: true })).toBe(false);
  });

  it('hides chrome when nothing is selected', () => {
    expect(boardSelectionChromeVisible({ hasSelection: false, editing: false })).toBe(false);
  });

  it('hides chrome when nothing is selected AND editing', () => {
    expect(boardSelectionChromeVisible({ hasSelection: false, editing: true })).toBe(false);
  });
});
