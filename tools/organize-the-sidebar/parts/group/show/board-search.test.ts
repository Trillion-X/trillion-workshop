import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { matchesSearch, searchHaystack } from '../../../show/board-search.ts';

describe('board-search', () => {
  it('searchHaystack joins text + tags + label, lowercased', () => {
    expect(searchHaystack({ text: 'Sunset Palette', extra: { tags: ['Color', 'Mood'], label: 'Hero' } }))
      .toBe('sunset palette color mood hero');
    expect(searchHaystack({ extra: {} })).toBe('');
    expect(searchHaystack(undefined)).toBe('');
  });

  it('an empty / whitespace query matches everything (no search active)', () => {
    expect(matchesSearch({ text: 'anything' }, '')).toBe(true);
    expect(matchesSearch({ text: 'anything' }, '   ')).toBe(true);
    expect(matchesSearch({ extra: {} }, '')).toBe(true);
  });

  it('matches case-insensitively on text', () => {
    expect(matchesSearch({ text: 'Sunset Palette' }, 'sunset')).toBe(true);
    expect(matchesSearch({ text: 'Sunset Palette' }, 'PALETTE')).toBe(true);
    expect(matchesSearch({ text: 'Sunset Palette' }, 'ocean')).toBe(false);
  });

  it('matches on a tag or a label, not just text', () => {
    expect(matchesSearch({ text: 'x', extra: { tags: ['typography'] } }, 'typo')).toBe(true);
    expect(matchesSearch({ text: 'x', extra: { label: 'Mood Section' } }, 'mood')).toBe(true);
    expect(matchesSearch({ text: 'x', extra: { tags: ['a'] } }, 'zzz')).toBe(false);
  });

  it('trims the query before matching', () => {
    expect(matchesSearch({ text: 'hello world' }, '  world  ')).toBe(true);
  });
});
