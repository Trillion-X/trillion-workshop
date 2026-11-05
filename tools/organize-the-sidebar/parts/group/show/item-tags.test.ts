import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { parseTags, itemTags, formatTags, distinctTags, mergeTags, noteDisplayTags } from '../../../show/item-tags.ts';

describe('noteDisplayTags — stored tags unified with body #hashtags (b101)', () => {
  it('merges stored extra.tags with body #tags, stripping # so they dedup', () => {
    const item = { extra: { tags: ['pottery', 'drills'] } };
    // "#pottery" in the body dedups with the stored "pottery"; "#clinic" is a NEW tag from the body.
    expect(noteDisplayTags(item, 'work on #pottery and #clinic today')).toEqual(['pottery', 'drills', 'clinic']);
  });
  it('a note with only body #tags (no stored tags) surfaces them', () => {
    expect(noteDisplayTags({ extra: {} }, 'ideas: #roadmap #q3')).toEqual(['roadmap', 'q3']);
  });
  it('a note with no tags anywhere → [] (a tag-less note stays byte-identical downstream)', () => {
    expect(noteDisplayTags({ extra: {} }, 'plain text, no tags')).toEqual([]);
    expect(noteDisplayTags(undefined, undefined)).toEqual([]);
  });
});

describe('item-tags', () => {
  it('parseTags splits on commas/newlines, trims, drops empties, dedupes case-insensitively', () => {
    expect(parseTags('color, layout , mood')).toEqual(['color', 'layout', 'mood']);
    expect(parseTags('a\nb\n\nc')).toEqual(['a', 'b', 'c']);
    expect(parseTags('Color, color, COLOR')).toEqual(['Color']); // first spelling wins
    expect(parseTags('   ')).toEqual([]);
    expect(parseTags('')).toEqual([]);
  });

  it('itemTags reads a string[] of non-empty tags, else []', () => {
    expect(itemTags({ extra: { tags: ['a', 'b'] } })).toEqual(['a', 'b']);
    expect(itemTags({ extra: { tags: ['a', '', '  ', 'b'] } })).toEqual(['a', 'b']);
    expect(itemTags({ extra: { tags: 'a,b' as unknown as string[] } })).toEqual([]);
    expect(itemTags({ extra: {} })).toEqual([]);
    expect(itemTags(undefined)).toEqual([]);
    expect(itemTags({ extra: { tags: [1, 2] as unknown as string[] } })).toEqual([]);
  });

  it('formatTags is the inverse of parseTags for a clean list', () => {
    const tags = ['color', 'layout'];
    expect(formatTags(tags)).toBe('color, layout');
    expect(parseTags(formatTags(tags))).toEqual(tags);
  });

  it('distinctTags unions across items, dedupes case-insensitively, sorts alphabetically', () => {
    const items = [
      { extra: { tags: ['Mood', 'color'] } },
      { extra: { tags: ['layout', 'mood'] } },
      { extra: {} },
    ];
    expect(distinctTags(items)).toEqual(['color', 'layout', 'Mood']); // first spelling 'Mood' kept, sorted ci
  });

  it('mergeTags adds new tags into existing, dedupes case-insensitively (existing wins), no-op when nothing new', () => {
    expect(mergeTags(['color'], ['mood'])).toEqual(['color', 'mood']);
    expect(mergeTags(['Color'], ['color', 'mood'])).toEqual(['Color', 'mood']); // existing spelling wins
    expect(mergeTags([], ['a', 'b'])).toEqual(['a', 'b']);
    const same = ['x', 'y'];
    expect(mergeTags(same, ['X', 'y'])).toEqual(['x', 'y']); // nothing genuinely new
  });

  // NOTE: the old `itemMatchesFilter(tags, selectedSet)` tag-only filter was dissolved into
  // the generic multi-facet engine (`matchesFacets` over `BOARD_ITEM_FACETS`); its behavioral
  // equivalence (empty→all, OR, case-insensitive, untagged-excluded) is now proven in
  // `board-item-facets.test.ts` (the tag facet) — one filter engine, not two.
});

describe('itemTags caps the read at MAX_TAGS (paste-bomb defense, cont.98 batch-16)', () => {
  it('a hostile persisted extra.tags of millions is capped, not passed through whole', () => {
    const huge = { extra: { tags: Array(1_000_000).fill('x') } };
    expect(itemTags(huge).length).toBeLessThanOrEqual(24);
    expect(distinctTags([huge]).length).toBeLessThanOrEqual(1); // bounded downstream work
  });
  it('a normal item (<= 24 tags) is unchanged (zero regression)', () => {
    expect(itemTags({ extra: { tags: ['a', 'b', 'c'] } })).toEqual(['a', 'b', 'c']);
    expect(itemTags({ extra: { tags: ['a', '', '  ', 'b'] } })).toEqual(['a', 'b']);
  });
});
