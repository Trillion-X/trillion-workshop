// packages/group/show/board-marker-catalog.levelMarkers.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  DEFAULT_OUTLINE_MARKER_IDS,
  markerTextForIndex,
  resolveLevelMarkers,
} from '../../../show/board-marker-catalog.ts';

describe('resolveLevelMarkers + the legal-outline cascade', () => {
  it('the default cascade is decimal → lower-alpha → roman → disc → dash', () => {
    expect([...DEFAULT_OUTLINE_MARKER_IDS]).toEqual(['decimal', 'lower-alpha', 'roman', 'disc', 'dash']);
  });

  it('resolves each level id to a marker whose ordinal formats correctly per level', () => {
    const lv = resolveLevelMarkers([...DEFAULT_OUTLINE_MARKER_IDS]);
    // level 0 (decimal): item 0 → "1."
    expect(markerTextForIndex(lv[0], 0)).toBe('1.');
    // level 1 (lower-alpha with ')' suffix): item 0 → "a)"
    expect(markerTextForIndex(lv[1], 0)).toBe('a)');
    // level 2 (roman, lower, '.'): item 0 → "i."
    expect(markerTextForIndex(lv[2], 0)).toBe('i.');
    // level 3 (disc glyph): index-independent "•"
    expect(markerTextForIndex(lv[3], 5)).toBe('•');
  });

  it('unknown ids resolve to undefined (that level draws no bullet)', () => {
    const lv = resolveLevelMarkers(['decimal', 'nope']);
    expect(lv[0]?.id).toBe('decimal');
    expect(lv[1]).toBeUndefined();
  });
});
