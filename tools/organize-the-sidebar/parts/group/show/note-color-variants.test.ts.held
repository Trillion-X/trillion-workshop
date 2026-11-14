// packages/group/show/note-color-variants.test.ts
//
// #158: the Note tool's colour family is the #124 BOARD_FILL_SWATCHES palette mapped to
// one-click placeable presets (each seeds a fill stack via the SAME setStackFill as #124).
// Pure DATA — proves the catalog→variants derivation drops the "None" swatch, carries the
// colour as `swatch` (rendered as a ColorDot), and seeds a solid-layer fill of that colour.
// This is the #157 `variants` primitive on a 2nd tool + a 2nd visual (L069 emergence).

import { describe, expect, it } from 'vitest';
import { NOTE_COLOR_VARIANTS, ITEM_SHELF } from './item-renderers';
import { BOARD_FILL_SWATCHES, itemFillColor } from './item-fill';

describe('#158 NOTE_COLOR_VARIANTS — BOARD_FILL_SWATCHES as one-click stickies', () => {
  it('drops the "None" swatch (that IS a blank note) — only real colours become variants', () => {
    expect(NOTE_COLOR_VARIANTS.some((v) => v.id === 'none')).toBe(false);
    const want = BOARD_FILL_SWATCHES.filter((s) => s.color !== null).map((s) => s.id);
    expect(NOTE_COLOR_VARIANTS.map((v) => v.id)).toEqual(want);
  });

  it('each variant carries the colour as a swatch (rendered as a ColorDot, not an icon)', () => {
    for (const v of NOTE_COLOR_VARIANTS) {
      const cat = BOARD_FILL_SWATCHES.find((s) => s.id === v.id);
      expect(v.swatch).toBe(cat?.color); // SSOT to the palette
      expect(v.label).toBe(cat?.label);
      expect(v.icon).toBeUndefined(); // colour family has no lucide icon
    }
  });

  it('each variant seeds a visualLayerStack whose solid layer IS that colour (SSOT to #124)', () => {
    for (const v of NOTE_COLOR_VARIANTS) {
      const stack = (v.defaultExtra as { visualLayerStack?: unknown }).visualLayerStack;
      expect(stack).toBeTruthy();
      // The seeded fill reads back through the same accessor a #124 recolour uses.
      expect(itemFillColor({ extra: { visualLayerStack: stack } })).toBe(v.swatch);
    }
  });

  it('the Note shelf entry carries the colour family + still drops a blank note on the main click', () => {
    const note = ITEM_SHELF.find((t) => t.label === 'Note');
    expect(note).toBeDefined();
    // deep equality: the shelf derives the family from the (DATA-mergeable) catalog per
    // build, so identity is per-call; the CONTRACT is the rows, not the array instance.
    expect(note?.variants).toStrictEqual(NOTE_COLOR_VARIANTS);
    // Main-click default is unchanged — a blank "New note", no seeded fill.
    expect(note?.defaultText).toBe('New note');
    expect(note?.defaultExtra).toBeUndefined();
  });

  it('the same flyout serves BOTH families — Note carries swatch variants, no icon needed', () => {
    // L069: the #157 variants primitive renders icon OR swatch presence-driven; the Note
    // family exercises the swatch branch with zero shape/Note special-casing.
    expect(NOTE_COLOR_VARIANTS.every((v) => typeof v.swatch === 'string' && v.icon === undefined)).toBe(true);
  });
});
