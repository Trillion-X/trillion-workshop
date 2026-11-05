import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { BOARD_PALETTES, paletteById, cycleAssign, nearestHueAssign, recolorToPalette, fixedColorAssign } from '../../../show/board-palettes.ts';
import type { BoardPalette, PaletteItem } from '../../../show/board-palettes.ts';

const item = (memberId: string, fill?: string): PaletteItem => ({ memberId, fill });

describe('board-palettes (cont.23 — apply a cohesive theme; one mechanism, injected strategy)', () => {
  describe('catalog', () => {
    it('every palette has a unique id, a label, and ≥2 hex colours', () => {
      const ids = BOARD_PALETTES.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of BOARD_PALETTES) {
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.colors.length).toBeGreaterThanOrEqual(2);
        for (const c of p.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
    it('paletteById resolves a known id, else the first palette (never empty)', () => {
      expect(paletteById('ocean').id).toBe('ocean');
      expect(paletteById('nope')).toBe(BOARD_PALETTES[0]);
      expect(paletteById(undefined)).toBe(BOARD_PALETTES[0]);
    });
  });

  describe('cycleAssign', () => {
    const pal: BoardPalette = { id: 't', label: 'T', colors: ['#aaa111', '#bbb222', '#ccc333'] };
    it('round-robins the palette in index order (wraps past the end)', () => {
      expect(cycleAssign(item('a'), 0, pal)).toBe('#aaa111');
      expect(cycleAssign(item('b'), 1, pal)).toBe('#bbb222');
      expect(cycleAssign(item('c'), 2, pal)).toBe('#ccc333');
      expect(cycleAssign(item('d'), 3, pal)).toBe('#aaa111'); // wrap
    });
    it('empty palette → null (no change)', () => {
      expect(cycleAssign(item('a'), 0, { id: 'e', label: 'E', colors: [] })).toBeNull();
    });
  });

  describe('nearestHueAssign', () => {
    // A palette spanning the wheel: red(0) / green(120) / blue(240).
    const pal: BoardPalette = { id: 'rgb', label: 'RGB', colors: ['#ff0000', '#00ff00', '#0000ff'] };
    it('maps each fill to the palette colour of NEAREST hue (preserves colour relationships)', () => {
      expect(nearestHueAssign(item('a', '#ee1111'), 0, pal)).toBe('#ff0000'); // reddish → red
      expect(nearestHueAssign(item('b', '#11cc22'), 1, pal)).toBe('#00ff00'); // greenish → green
      expect(nearestHueAssign(item('c', '#2233dd'), 2, pal)).toBe('#0000ff'); // bluish → blue
    });
    it('handles circular hue wraparound (a magenta ~320° is nearer red 0° than green 120°)', () => {
      expect(nearestHueAssign(item('m', '#ff00aa'), 0, pal)).toBe('#ff0000');
    });
    it('achromatic / no-fill items fall back to cycle (deterministic)', () => {
      expect(nearestHueAssign(item('g', '#808080'), 1, pal)).toBe('#00ff00'); // grey → cycle index 1
      expect(nearestHueAssign(item('n'), 2, pal)).toBe('#0000ff'); // no fill → cycle index 2
    });
    it('a Mono (all-achromatic, pure greys) palette has no hue to match → cycles', () => {
      const mono: BoardPalette = { id: 'm', label: 'M', colors: ['#808080', '#cccccc'] }; // r=g=b → hueOf null
      expect(nearestHueAssign(item('a', '#ff0000'), 0, mono)).toBe('#808080'); // cycle index 0
      expect(nearestHueAssign(item('b', '#00ff00'), 1, mono)).toBe('#cccccc'); // cycle index 1
    });
  });

  describe('recolorToPalette', () => {
    const pal: BoardPalette = { id: 't', label: 'T', colors: ['#c1', '#c2'].map((c) => c.padEnd(7, '0')) };
    it('emits one {memberId,color} per item the strategy colours, in order', () => {
      const out = recolorToPalette([item('a'), item('b'), item('c')], pal, cycleAssign);
      expect(out).toEqual([
        { memberId: 'a', color: '#c10000' },
        { memberId: 'b', color: '#c20000' },
        { memberId: 'c', color: '#c10000' },
      ]);
    });
    it('omits items the strategy leaves unchanged (returns null)', () => {
      const skipEven: typeof cycleAssign = (_i, index, p) => (index % 2 === 0 ? p.colors[0] : null);
      const out = recolorToPalette([item('a'), item('b'), item('c')], pal, skipEven);
      expect(out.map((o) => o.memberId)).toEqual(['a', 'c']);
    });
  });

  describe('fixedColorAssign (cont.43 — paint each member the colour a pre-computed map decides)', () => {
    const pal: BoardPalette = { id: 't', label: 'T', colors: ['#c10000', '#c20000'] };

    it('paints each item exactly the mapped colour; index/palette are ignored (already decided)', () => {
      const map = new Map([['a', '#abcdef'], ['b', '#123456']]);
      const out = recolorToPalette([item('a'), item('b')], pal, fixedColorAssign(map));
      expect(out).toEqual([
        { memberId: 'a', color: '#abcdef' },
        { memberId: 'b', color: '#123456' },
      ]);
    });

    it('leaves an item with NO entry in the map unchanged (null → omitted)', () => {
      const out = recolorToPalette([item('a'), item('b')], pal, fixedColorAssign(new Map([['a', '#abcdef']])));
      expect(out).toEqual([{ memberId: 'a', color: '#abcdef' }]);
    });

    it('empty map → every item null (no change)', () => {
      expect(recolorToPalette([item('a')], pal, fixedColorAssign(new Map()))).toEqual([]);
    });
  });
});
