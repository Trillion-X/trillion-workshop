import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { BOARD_FILTER_PRESETS, filterCssById, presetIdForCss, type FilterPreset } from '../../../show/filter-presets.ts';

describe('filter-presets', () => {
  it('every preset has a unique id, a label, and a string css', () => {
    const ids = new Set<string>();
    for (const p of BOARD_FILTER_PRESETS) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.css).toBe('string');
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
  });

  it('the first preset is None with an empty css', () => {
    expect(BOARD_FILTER_PRESETS[0].id).toBe('none');
    expect(BOARD_FILTER_PRESETS[0].css).toBe('');
  });

  it('filterCssById resolves an id to its css', () => {
    expect(filterCssById('bw')).toBe('grayscale(1)');
    expect(filterCssById('none')).toBe('');
  });

  it('filterCssById returns empty for unknown/missing id', () => {
    expect(filterCssById('does-not-exist')).toBe('');
    expect(filterCssById(undefined)).toBe('');
  });

  it('presetIdForCss round-trips with filterCssById for every preset', () => {
    for (const p of BOARD_FILTER_PRESETS) {
      expect(filterCssById(presetIdForCss(p.css))).toBe(p.css);
      // and the id round-trips too (except None/'' which maps to the none id)
      if (p.css !== '') expect(presetIdForCss(filterCssById(p.id))).toBe(p.id);
    }
  });

  it('presetIdForCss maps empty/missing css to the None preset id', () => {
    expect(presetIdForCss('')).toBe('none');
    expect(presetIdForCss(undefined)).toBe('none');
    expect(presetIdForCss('   ')).toBe('none');
  });

  it('presetIdForCss returns empty for a css set outside the catalog', () => {
    expect(presetIdForCss('blur(4px)')).toBe('');
  });

  it('works with a caller-supplied catalog (the editor is blind)', () => {
    const custom: FilterPreset[] = [
      { id: 'none', label: 'None', css: '' },
      { id: 'x', label: 'X', css: 'invert(1)' },
    ];
    expect(filterCssById('x', custom)).toBe('invert(1)');
    expect(presetIdForCss('invert(1)', custom)).toBe('x');
  });
});
