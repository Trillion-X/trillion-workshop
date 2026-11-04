// Proof for the search-field keyboard→intent map: Enter (+Shift) steps only when wired and matches exist;
// Escape is a two-stage dismiss (clear a non-empty query, else blur); every other key is native (null).
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { searchFieldKeyIntent } from '../../../read-data/search-field-key.ts';

const base = { shiftKey: false, hasQuery: true, matchCount: 3, canStep: true } as const;

describe('search-field-key — searchFieldKeyIntent', () => {
  it('Enter steps to the next match, Shift+Enter to the previous', () => {
    expect(searchFieldKeyIntent({ ...base, key: 'Enter' })).toBe('step-next');
    expect(searchFieldKeyIntent({ ...base, key: 'Enter', shiftKey: true })).toBe('step-prev');
  });

  it('Enter is native when there is nothing to step to or stepping is not wired', () => {
    expect(searchFieldKeyIntent({ ...base, key: 'Enter', matchCount: 0 })).toBeNull();
    expect(searchFieldKeyIntent({ ...base, key: 'Enter', canStep: false })).toBeNull();
    // Shift+Enter with no matches is likewise native.
    expect(searchFieldKeyIntent({ ...base, key: 'Enter', shiftKey: true, matchCount: 0 })).toBeNull();
  });

  it('Escape clears a non-empty query (stage 1), then blurs an empty query (stage 2)', () => {
    expect(searchFieldKeyIntent({ ...base, key: 'Escape', hasQuery: true })).toBe('clear');
    expect(searchFieldKeyIntent({ ...base, key: 'Escape', hasQuery: false })).toBe('blur');
  });

  it('Escape stage does not depend on matches or stepping — a query with 0 matches still clears', () => {
    expect(searchFieldKeyIntent({ key: 'Escape', shiftKey: false, hasQuery: true, matchCount: 0, canStep: false })).toBe('clear');
    expect(searchFieldKeyIntent({ key: 'Escape', shiftKey: false, hasQuery: false, matchCount: 0, canStep: false })).toBe('blur');
  });

  it('every other key is native (null) — typing, arrows, tab stay untouched', () => {
    for (const key of ['a', ' ', 'ArrowDown', 'ArrowRight', 'Tab', 'Backspace', '/', '?', 'Home']) {
      expect(searchFieldKeyIntent({ ...base, key })).toBeNull();
    }
  });
});
