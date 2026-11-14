import { describe, expect, it } from 'vitest';
import { BOARD_SHAPES, SHAPE_DEFAULT_OPTIONS, shapeClipPathById, shapeSvgPathById, shapeOutlineById } from './board-shapes';

describe('board-shapes (#155 catalog)', () => {
  it('rectangle / none / unknown resolve to an empty clip-path (no shape)', () => {
    expect(shapeClipPathById('rectangle')).toBe('');
    expect(shapeClipPathById(undefined)).toBe('');
    expect(shapeClipPathById('')).toBe('');
    expect(shapeClipPathById('not-a-shape')).toBe('');
  });

  it('a known shape resolves to its clip-path string', () => {
    expect(shapeClipPathById('ellipse')).toBe('ellipse(50% 50% at 50% 50%)');
    expect(shapeClipPathById('diamond')).toContain('polygon(');
  });

  it('rectangle is first (the default) and has no clip', () => {
    expect(BOARD_SHAPES[0].id).toBe('rectangle');
    expect(BOARD_SHAPES[0].clipPath).toBe('');
  });

  it('every non-rectangle row has a non-empty clip-path, label, and icon', () => {
    for (const s of BOARD_SHAPES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
      if (s.id !== 'rectangle') expect(s.clipPath.length).toBeGreaterThan(0);
    }
  });

  it('ids are unique (a catalog never collides)', () => {
    const ids = BOARD_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('SHAPE_DEFAULT_OPTIONS — the board-default note-shape picker options', () => {
    it('EXCLUDES rectangle (that is the "Default"/cleared no-shape state) and includes every real shape', () => {
      const ids = SHAPE_DEFAULT_OPTIONS.map((o) => o.value);
      expect(ids).not.toContain('rectangle');
      // every option is a real catalog shape with a rendered path (a board default must draw something)
      for (const o of SHAPE_DEFAULT_OPTIONS) {
        expect(BOARD_SHAPES.some((s) => s.id === o.value)).toBe(true);
        expect(shapeSvgPathById(o.value).length).toBeGreaterThan(0);
        expect(o.label.length).toBeGreaterThan(0);
      }
      // the everyday diagram shapes ARE offered
      for (const id of ['ellipse', 'diamond', 'hexagon']) expect(ids).toContain(id);
    });

    it('derives from BOARD_SHAPES (SSOT) = catalog minus rectangle, no duplicates', () => {
      const nonRect = BOARD_SHAPES.filter((s) => s.id !== 'rectangle').map((s) => s.id);
      expect(SHAPE_DEFAULT_OPTIONS.map((o) => o.value)).toEqual(nonRect);
      expect(new Set(SHAPE_DEFAULT_OPTIONS.map((o) => o.value)).size).toBe(SHAPE_DEFAULT_OPTIONS.length);
    });
  });

  describe('shapeOutlineById (cont.26) — the injected outline resolver for rough/dashed shape EXPORT', () => {
    it('returns a closed point ring in the item box for every real shape; scales with w/h', () => {
      for (const o of SHAPE_DEFAULT_OPTIONS) {
        const pts = shapeOutlineById(o.value, 200, 100);
        expect(pts).toBeTruthy();
        expect(pts!.length).toBeGreaterThan(1);
        // all points lie within the item's box (with a small outset pad).
        for (const p of pts!) {
          expect(p.x).toBeGreaterThanOrEqual(-4);
          expect(p.x).toBeLessThanOrEqual(204);
          expect(p.y).toBeGreaterThanOrEqual(-4);
          expect(p.y).toBeLessThanOrEqual(104);
        }
      }
    });
    it('is undefined for rectangle / unknown / absent (no shape outline to draw)', () => {
      expect(shapeOutlineById('rectangle', 100, 100)).toBeUndefined();
      expect(shapeOutlineById('nope', 100, 100)).toBeUndefined();
      expect(shapeOutlineById(undefined, 100, 100)).toBeUndefined();
    });
  });
});
