import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { BOARD_BACKGROUNDS, backgroundById } from '../../../show/board-backgrounds.ts';

describe('board-backgrounds', () => {
  it('every entry has a unique id and label', () => {
    const ids = BOARD_BACKGROUNDS.map((b) => b.id);
    const labels = BOARD_BACKGROUNDS.map((b) => b.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('dots is the FIRST entry and the default fallback', () => {
    expect(BOARD_BACKGROUNDS[0].id).toBe('dots');
    expect(backgroundById(undefined).id).toBe('dots');
    expect(backgroundById('not-a-real-id').id).toBe('dots');
    expect(backgroundById('').id).toBe('dots');
  });

  it('resolves a known id to its own entry', () => {
    expect(backgroundById('grid').id).toBe('grid');
    expect(backgroundById('blueprint').label).toBe('Blueprint');
  });

  it('dots carries a tile; blank carries neither tile nor color (plain)', () => {
    expect(backgroundById('dots').tile).toBeTruthy();
    const blank = backgroundById('blank');
    expect(blank.tile).toBeUndefined();
    expect(blank.color).toBeUndefined();
  });

  it('a tiled entry has a positive world-px tile size and a CSS image string', () => {
    for (const b of BOARD_BACKGROUNDS) {
      if (!b.tile) continue;
      expect(b.tile.size).toBeGreaterThan(0);
      expect(typeof b.tile.image).toBe('string');
      expect(b.tile.image.length).toBeGreaterThan(0);
    }
  });

  it('color-mood entries (blueprint/legal-pad/dark) carry an explicit color', () => {
    expect(backgroundById('blueprint').color).toBeTruthy();
    expect(backgroundById('legal-pad').color).toBeTruthy();
    expect(backgroundById('dark').color).toBeTruthy();
  });

  it('cont.26 — the warm PAPER canvas is a plain-color surface (no tile) completing the sketch look', () => {
    const paper = backgroundById('paper');
    expect(paper.id).toBe('paper');
    expect(paper.color).toBeTruthy(); // a warm off-white fill
    expect(paper.tile).toBeUndefined(); // plain — no dot/grid/ruled pattern
  });
});
