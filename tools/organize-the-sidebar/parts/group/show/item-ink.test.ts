import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { relativeLuminance, contrastRatio, readableInkFor, INK_DARK, INK_LIGHT } from '../../../show/item-ink.ts';

describe('item-ink (cont.21 — WCAG readable ink over ANY fill, one luminance fn)', () => {
  describe('relativeLuminance', () => {
    it('anchors black at 0 and white at 1', () => {
      expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
      expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    });
    it('orders by perceived lightness (white > yellow > green > blue > black)', () => {
      const white = relativeLuminance('#ffffff')!;
      const yellow = relativeLuminance('#ffff00')!;
      const green = relativeLuminance('#00ff00')!;
      const blue = relativeLuminance('#0000ff')!;
      const black = relativeLuminance('#000000')!;
      expect(white).toBeGreaterThan(yellow);
      expect(yellow).toBeGreaterThan(green);
      expect(green).toBeGreaterThan(blue);
      expect(blue).toBeGreaterThan(black);
    });
    it('null for an unparseable colour', () => {
      expect(relativeLuminance('tomato')).toBeNull();
      expect(relativeLuminance(undefined)).toBeNull();
    });
  });

  describe('contrastRatio', () => {
    it('black vs white is the maximal 21:1', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 4);
    });
    it('a colour against itself is 1:1, and it is order-independent', () => {
      expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 5);
      expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456')!, 6);
    });
    it('null if either colour is unparseable', () => {
      expect(contrastRatio('#000', 'nope')).toBeNull();
    });
  });

  describe('readableInkFor', () => {
    it('a DARK fill gets the LIGHT ink; a LIGHT fill gets the DARK ink', () => {
      expect(readableInkFor('#1f2937')).toBe(INK_LIGHT); // dark slate → light text
      expect(readableInkFor('#000000')).toBe(INK_LIGHT);
      expect(readableInkFor('#fde68a')).toBe(INK_DARK); // light yellow → dark text
      expect(readableInkFor('#ffffff')).toBe(INK_DARK);
    });
    it('every board pastel swatch (light) resolves to dark ink; every deep colour to light ink', () => {
      for (const c of ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe', '#fed7aa', '#fecaca', '#e5e7eb']) {
        expect(readableInkFor(c)).toBe(INK_DARK); // the pastel palette is light → dark text
      }
      for (const c of ['#1f2937', '#111827', '#0000ff', '#7f1d1d']) {
        expect(readableInkFor(c)).toBe(INK_LIGHT);
      }
    });
    it('the chosen ink always clears AA (4.5:1) contrast on the board swatches', () => {
      for (const c of ['#fde68a', '#bbf7d0', '#bfdbfe', '#1f2937', '#7f1d1d', '#0000ff']) {
        const ink = readableInkFor(c)!;
        expect(contrastRatio(c, ink)!).toBeGreaterThanOrEqual(4.5);
      }
    });
    it('GUARANTEES AA across the FULL luminance range — incl. the ~0.21 danger zone where the soft inks alone dip below 4.5', () => {
      // Sweep every grey 0..255: the soft near-inks would miss AA around L≈0.21, so readableInkFor
      // must escalate that side to pure black/white. Every step must clear 4.5:1.
      for (let v = 0; v <= 255; v += 3) {
        const hex = '#' + v.toString(16).padStart(2, '0').repeat(3);
        const ink = readableInkFor(hex)!;
        expect(contrastRatio(hex, ink)!).toBeGreaterThanOrEqual(4.5);
      }
    });
    it('escalates the SOFT ink to a PURE extreme in the danger zone (#808080 → pure black, not soft slate)', () => {
      // #808080 has L≈0.216: the soft INK_DARK gives only ~3.97:1 (fails AA) → must escalate to #000000.
      expect(contrastRatio('#808080', INK_DARK)!).toBeLessThan(4.5); // proves the soft pole WOULD fail
      expect(readableInkFor('#808080')).toBe('#000000'); // so it escalates to the pure extreme
      expect(contrastRatio('#808080', '#000000')!).toBeGreaterThanOrEqual(4.5);
    });
    it('uses the SOFT ink (not pure) on clearly light/dark fills where it comfortably clears AA', () => {
      expect(readableInkFor('#fde68a')).toBe(INK_DARK); // light pastel → soft dark, not pure #000
      expect(readableInkFor('#0b1120')).toBe(INK_LIGHT); // near-black → soft light, not pure #fff
    });
    it('honours injected ink poles (a themed board supplies its own pair)', () => {
      expect(readableInkFor('#000000', { light: '#feffef' })).toBe('#feffef');
      expect(readableInkFor('#ffffff', { dark: '#010203' })).toBe('#010203');
    });
    it('undefined for an unparseable/absent fill → caller applies NO override (zero regression)', () => {
      expect(readableInkFor(undefined)).toBeUndefined();
      expect(readableInkFor('linear-gradient(...)')).toBeUndefined();
      expect(readableInkFor('')).toBeUndefined();
    });
  });
});
