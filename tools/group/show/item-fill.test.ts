import { describe, expect, it } from 'vitest';
import { itemFillColor, setStackFill, emptyStack, BOARD_FILL_SWATCHES, seededFillStack, BOARD_ITEM_LAYER_REGISTRY, inheritedBranchStyle, parseRgb, hueOf } from 'trillion-workshop/tools/organize-the-sidebar/show/item-fill.ts';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack';

const REG = { family: 'group.board-item-layers', parts: {} };
const region = { family: 'group.board', parts: { board: 'b' } };

const solidLayer = (color: string) => ({
  id: 'fill',
  order: { z: -1 },
  paint: { capability: { registry: REG, capabilityId: 'solid' }, input: { color } },
});

describe('item-fill', () => {
  it('itemFillColor reads the first solid layer color, else undefined', () => {
    expect(itemFillColor({ extra: { visualLayerStack: { ...emptyStack(region), layers: [solidLayer('#fde68a')] } } })).toBe('#fde68a');
    expect(itemFillColor({ extra: { visualLayerStack: emptyStack(region) } })).toBeUndefined();
    expect(itemFillColor({ extra: {} })).toBeUndefined();
    expect(itemFillColor(undefined)).toBeUndefined();
  });

  it('setStackFill ADDS a background solid layer when none exists', () => {
    const next = setStackFill(emptyStack(region), '#bfdbfe', REG);
    expect(next.layers).toHaveLength(1);
    const l = next.layers[0];
    expect(l.paint.capability.capabilityId).toBe('solid');
    expect(l.paint.input.color).toBe('#bfdbfe');
    expect(l.order?.z).toBe(-1);
    expect(itemFillColor({ extra: { visualLayerStack: next } })).toBe('#bfdbfe');
  });

  it('setStackFill PATCHES the existing solid layer color (does not stack a second)', () => {
    const start: VisualLayerStackRecord = { ...emptyStack(region), layers: [solidLayer('#fde68a')] };
    const next = setStackFill(start, '#fecaca', REG);
    expect(next.layers).toHaveLength(1);
    expect(next.layers[0].paint.input.color).toBe('#fecaca');
    expect(next.layers[0].id).toBe('fill');
  });

  it('setStackFill(null) REMOVES the solid fill (clear), leaving other layers', () => {
    const other = { id: 'img', order: { z: 0 }, paint: { capability: { registry: REG, capabilityId: 'image' }, input: { url: 'x' } } };
    const start: VisualLayerStackRecord = { ...emptyStack(region), layers: [solidLayer('#fde68a'), other] };
    const cleared = setStackFill(start, null, REG);
    expect(cleared.layers).toHaveLength(1);
    expect(cleared.layers[0].id).toBe('img'); // the non-solid layer survives
    expect(itemFillColor({ extra: { visualLayerStack: cleared } })).toBeUndefined();
    // Clearing an already-fill-less stack is a no-op.
    expect(setStackFill(cleared, null, REG).layers).toHaveLength(1);
  });

  it('setStackFill is pure — never mutates the input record', () => {
    const start: VisualLayerStackRecord = { ...emptyStack(region), layers: [solidLayer('#fde68a')] };
    const snapshot = JSON.stringify(start);
    setStackFill(start, '#000000', REG);
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('BOARD_FILL_SWATCHES: unique ids, None is first and clears (null), the rest are hex', () => {
    const ids = BOARD_FILL_SWATCHES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BOARD_FILL_SWATCHES[0].id).toBe('none');
    expect(BOARD_FILL_SWATCHES[0].color).toBeNull();
    for (const s of BOARD_FILL_SWATCHES.slice(1)) expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('seededFillStack builds a ready-to-place stack with ONE solid layer of the colour (#158)', () => {
    const stack = seededFillStack('#bbf7d0');
    // Reads back through the SAME accessor #124 uses — the seed and a recolour share one truth.
    expect(itemFillColor({ extra: { visualLayerStack: stack } })).toBe('#bbf7d0');
    expect(stack.layers).toHaveLength(1);
    expect(stack.layers[0].paint.capability.capabilityId).toBe('solid');
    // The registry it stamps is the canonical board registry (one SSOT home, L030).
    expect(stack.layers[0].paint.capability.registry).toEqual(BOARD_ITEM_LAYER_REGISTRY);
    expect(BOARD_ITEM_LAYER_REGISTRY.family).toBe('group.board-item-layers');
  });

  describe('parseRgb (#18 — one colour→channels reader, shared by every hue/luma sort)', () => {
    it('parses #rgb short hex (each nibble doubled)', () => {
      expect(parseRgb('#f00')).toEqual([255, 0, 0]);
      expect(parseRgb('#0f0')).toEqual([0, 255, 0]);
      expect(parseRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    });
    it('parses #rrggbb full hex (case-insensitive)', () => {
      expect(parseRgb('#ff0000')).toEqual([255, 0, 0]);
      expect(parseRgb('#00FF00')).toEqual([0, 255, 0]);
      expect(parseRgb('#bfdbfe')).toEqual([0xbf, 0xdb, 0xfe]);
    });
    it('parses rgb()/rgba() (ignores alpha)', () => {
      expect(parseRgb('rgb(12, 34, 56)')).toEqual([12, 34, 56]);
      expect(parseRgb('rgba(1,2,3,0.5)')).toEqual([1, 2, 3]);
    });
    it('returns null for undefined / unparseable / named colours', () => {
      expect(parseRgb(undefined)).toBeNull();
      expect(parseRgb('')).toBeNull();
      expect(parseRgb('tomato')).toBeNull();
      expect(parseRgb('#12')).toBeNull();
    });
  });

  describe('hueOf (#18 — the byHue rainbow sort key, DATA-driven over any fill)', () => {
    it('maps the primaries to the colour wheel (red 0°, green 120°, blue 240°)', () => {
      expect(hueOf('#ff0000')).toBeCloseTo(0, 5);
      expect(hueOf('#00ff00')).toBeCloseTo(120, 5);
      expect(hueOf('#0000ff')).toBeCloseTo(240, 5);
    });
    it('orders the board swatches into a real rainbow (yellow<green<blue<purple)', () => {
      const yellow = hueOf('#fde68a')!, green = hueOf('#bbf7d0')!, blue = hueOf('#bfdbfe')!, purple = hueOf('#ddd6fe')!;
      expect(yellow).toBeLessThan(green);
      expect(green).toBeLessThan(blue);
      expect(blue).toBeLessThan(purple);
    });
    it('returns null for achromatic (gray/near-white/black) — no hue to sort on', () => {
      expect(hueOf('#e5e7eb')).toBeNull(); // board gray
      expect(hueOf('#ffffff')).toBeNull();
      expect(hueOf('#000000')).toBeNull();
      expect(hueOf('#808080')).toBeNull();
    });
    it('returns null for an unparseable / absent fill (sorts last via the Infinity guard)', () => {
      expect(hueOf(undefined)).toBeNull();
      expect(hueOf('none')).toBeNull();
    });
  });

  describe('inheritedBranchStyle (#167 — live rainbow inherit on Tab/Enter create)', () => {
    const colored = (c: string) => ({ extra: { visualLayerStack: { ...emptyStack(region), layers: [solidLayer(c)] } } });

    it('a child of a COLOURED parent inherits that fill (as a seeded stack) + the same connector colour', () => {
      const style = inheritedBranchStyle(colored('#aabbcc'));
      expect(style).not.toBeNull();
      // The child's fill reads back through the SAME accessor the swatch/editor use → one truth.
      expect(itemFillColor({ extra: { visualLayerStack: style!.fillStack } })).toBe('#aabbcc');
      // The connector adopts the identical colour (whole branch = one colour, #166).
      expect(style!.connectorColor).toBe('#aabbcc');
      // And it is a real seeded stack: ONE solid layer on the canonical registry.
      expect(style!.fillStack).toEqual(seededFillStack('#aabbcc'));
    });

    it('a child of the NEUTRAL root (no fill) inherits nothing → null (stays uncoloured)', () => {
      expect(inheritedBranchStyle({ extra: { visualLayerStack: emptyStack(region) } })).toBeNull();
      expect(inheritedBranchStyle({ extra: {} })).toBeNull();
      expect(inheritedBranchStyle(undefined)).toBeNull();
    });

    it('every board fill swatch (except None) yields a matching inherited style — DATA-driven, zero per-colour code', () => {
      for (const s of BOARD_FILL_SWATCHES) {
        if (s.color === null) continue; // "None" is not a branch colour
        const style = inheritedBranchStyle(colored(s.color));
        expect(style?.connectorColor).toBe(s.color);
        expect(itemFillColor({ extra: { visualLayerStack: style!.fillStack } })).toBe(s.color);
      }
    });
  });
});

describe('parseRgb clamps out-of-range / oversized channels to [0,255] (cont.98 batch-15)', () => {
  it('an in-range colour is unchanged (zero regression)', () => {
    expect(parseRgb('rgb(200, 100, 50)')).toEqual([200, 100, 50]);
    expect(parseRgb('rgb(0,0,0)')).toEqual([0, 0, 0]);
  });
  it('a channel above 255 or an Infinity-sized channel clamps to 255 (never poisons downstream HSL)', () => {
    expect(parseRgb('rgb(999, 0, 0)')).toEqual([255, 0, 0]);
    expect(parseRgb('rgb(300, 300, 300)')).toEqual([255, 255, 255]);
    const huge = parseRgb(`rgb(${'9'.repeat(400)}, 0, 0)`)!; // Number(...) === Infinity
    expect(huge[0]).toBe(255);
    expect(Number.isFinite(huge[0])).toBe(true);
  });
});

describe('item-fill red-team — untrusted persisted DATA (cont.98 batch-33)', () => {
  it('#1 a non-array `layers` never crashes: itemFillColor undefined, setStackFill still adds a fill', () => {
    // A corrupted/hostile persisted item where `layers` is a string, not an array.
    const evilItem = { extra: { visualLayerStack: { kind: 'visual-layer-stack', version: 1, region, layers: 'evil' } } };
    expect(itemFillColor(evilItem as never)).toBeUndefined();
    // setStackFill coerces the non-array to [] before find/filter/map — no `.find`/`.map` on a string.
    const evilStack = { kind: 'visual-layer-stack', version: 1, region, layers: 'evil' } as never as VisualLayerStackRecord;
    const next = setStackFill(evilStack, '#bfdbfe', REG);
    expect(next.layers).toHaveLength(1);
    expect(itemFillColor({ extra: { visualLayerStack: next } })).toBe('#bfdbfe');
  });

  it('#2 duplicate layer ids: only the matched solid is patched/removed (object identity, not id)', () => {
    // Two layers share id 'fill' but only one is a solid. A by-id match would corrupt the non-solid twin.
    const nonSolid = { id: 'fill', order: { z: 5 }, paint: { capability: { registry: REG, capabilityId: 'blur' }, input: {} } };
    const start: VisualLayerStackRecord = { ...emptyStack(region), layers: [solidLayer('#fde68a'), nonSolid as never] };
    const patched = setStackFill(start, '#fecaca', REG);
    // The non-solid twin is untouched (same object, same capabilityId); the solid's colour is swapped.
    expect(patched.layers.find((l) => l.paint?.capability?.capabilityId === 'blur')).toBe(nonSolid);
    expect(itemFillColor({ extra: { visualLayerStack: patched } })).toBe('#fecaca');
    // Clearing removes ONLY the solid, leaving the non-solid twin intact.
    const cleared = setStackFill(start, null, REG);
    expect(cleared.layers).toHaveLength(1);
    expect(cleared.layers[0]).toBe(nonSolid);
  });

  it('#3 a megabyte-scale colour is refused before it reaches the renderer / colour math', () => {
    const huge = '#' + 'f'.repeat(5000); // > MAX_COLOR_LEN (4096)
    expect(itemFillColor({ extra: { visualLayerStack: { ...emptyStack(region), layers: [solidLayer(huge)] } } })).toBeUndefined();
    expect(parseRgb(huge)).toBeNull();
    expect(hueOf(huge)).toBeNull();
  });
});
