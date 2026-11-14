// packages/group/show/shape-variants.test.ts
//
// #157: the Shape tool's variant family is the #155 BOARD_SHAPES catalog mapped to
// placeable presets (each seeds extra.shape via #156 defaultExtra). Pure DATA — proves
// the catalog→variants derivation excludes the plain rectangle, carries the icon NAME
// (SSOT to the catalog), and seeds the right defaultExtra. One catalog, two consumers
// (the post-placement picker + this placement flyout).

import { describe, expect, it } from 'vitest';
import { SHAPE_VARIANTS, ITEM_SHELF } from './item-renderers';
import { BOARD_SHAPES } from './board-shapes';

describe('#157 SHAPE_VARIANTS — BOARD_SHAPES as placeable presets', () => {
  it('excludes the plain rectangle (that IS the Note tool)', () => {
    expect(SHAPE_VARIANTS.some((v) => v.id === 'rectangle')).toBe(false);
    // every other catalog shape is present
    const want = BOARD_SHAPES.filter((s) => s.id !== 'rectangle').map((s) => s.id);
    expect(SHAPE_VARIANTS.map((v) => v.id)).toEqual(want);
    expect(SHAPE_VARIANTS).toHaveLength(want.length); // every non-rectangle shape (derived — self-updates as BOARD_SHAPES grows)
  });

  it('each variant seeds extra.shape with its own id (#156 defaultExtra)', () => {
    for (const v of SHAPE_VARIANTS) {
      expect(v.defaultExtra).toEqual({ shape: v.id });
    }
  });

  it('carries the icon NAME from the catalog (SSOT — no re-picked icon)', () => {
    for (const v of SHAPE_VARIANTS) {
      const cat = BOARD_SHAPES.find((s) => s.id === v.id);
      expect(v.icon).toBe(cat?.icon); // string name, resolved by NamedIcon at render
      expect(v.label).toBe(cat?.label);
    }
  });

  it('the Shape shelf entry carries the variants family + an ellipse default', () => {
    const shape = ITEM_SHELF.find((t) => t.label === 'Shape');
    expect(shape).toBeDefined();
    // deep equality: the shelf derives the family from the (DATA-mergeable) catalog per
    // build, so identity is per-call; the CONTRACT is the rows, not the array instance.
    expect(shape?.variants).toStrictEqual(SHAPE_VARIANTS); // the same family
    expect(shape?.defaultExtra).toEqual({ shape: 'ellipse' }); // main-click default unchanged (#156)
  });

  it('the file/link/text shelf entries have NO variants (plain one-click buttons)', () => {
    // Shape (#157) and Note (#158) carry variant families; the file-backed + source
    // entries do not — they place via their own strategy with no preset family.
    for (const t of ITEM_SHELF) {
      if (t.label === 'Image' || t.label === 'Media' || t.label === 'Link' || t.label === 'Paste as cards') {
        expect(t.variants).toBeUndefined();
      }
    }
  });

  it('adding a catalog shape would extend the variants with zero code (L069 deletion proof)', () => {
    // The derivation is `BOARD_SHAPES.filter(≠rectangle).map(→variant)`. So a hypothetical
    // new catalog row flows through identically — the variants family is the catalog minus
    // rectangle, by construction. Assert the invariant rather than mutate the frozen catalog.
    const derived = BOARD_SHAPES.filter((s) => s.id !== 'rectangle')
      .map((s) => ({ id: s.id, label: s.label, icon: s.icon, defaultExtra: { shape: s.id } }));
    expect(SHAPE_VARIANTS).toEqual(derived);
  });
});
