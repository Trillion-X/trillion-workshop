// packages/group/show/item-fill.readFillSwatchCatalog.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { BOARD_FILL_SWATCHES, FILL_SWATCH_CATALOG_KIND, readFillSwatchCatalog } from '../../../show/item-fill.ts';

const rec = (swatches: unknown) => ({ payload: { kind: FILL_SWATCH_CATALOG_KIND, swatches } });

describe('readFillSwatchCatalog — fill swatches as user-extensible DATA (via mergeCatalog)', () => {
  it('returns the built-in swatches verbatim when no DATA rows exist', () => {
    expect(readFillSwatchCatalog([]).map((s) => s.id)).toEqual(BOARD_FILL_SWATCHES.map((s) => s.id));
  });

  it('APPENDS a user-defined swatch (one DATA row, zero code)', () => {
    const cat = readFillSwatchCatalog([
      rec([{ id: 'lime', label: 'Lime', color: '#d4fc79' }]),
    ]);
    const lime = cat.find((s) => s.id === 'lime');
    expect(lime?.color).toBe('#d4fc79');
    expect(cat.length).toBe(BOARD_FILL_SWATCHES.length + 1);
  });

  it('a DATA row overrides a built-in swatch by id in place', () => {
    const cat = readFillSwatchCatalog([
      rec([{ id: 'yellow', label: 'Golden Yellow', color: '#ffd700' }]),
    ]);
    const yellow = cat.find((s) => s.id === 'yellow');
    expect(yellow?.label).toBe('Golden Yellow');
    expect(yellow?.color).toBe('#ffd700');
    expect(cat.length).toBe(BOARD_FILL_SWATCHES.length);
  });

  it('skips rows missing required fields (id, label)', () => {
    const cat = readFillSwatchCatalog([
      rec([
        { id: 'x' }, // missing label
        { label: 'Y' }, // missing id
        { id: 'ok', label: 'Ok', color: '#ffffff' }, // valid
      ]),
    ]);
    expect(cat.find((s) => s.id === 'ok')).toBeDefined();
    expect(cat.find((s) => s.id === 'x')).toBeUndefined();
    expect(cat.length).toBe(BOARD_FILL_SWATCHES.length + 1);
  });

  it('supports null color (the "None" swatch)', () => {
    const cat = readFillSwatchCatalog([
      rec([{ id: 'clear', label: 'Clear', color: null }]),
    ]);
    const clear = cat.find((s) => s.id === 'clear');
    expect(clear?.color).toBeNull();
    expect(cat.length).toBe(BOARD_FILL_SWATCHES.length + 1);
  });

  it('skips rows with invalid color type (not string or null)', () => {
    const cat = readFillSwatchCatalog([
      rec([
        { id: 'bad', label: 'Bad', color: 123 }, // invalid type
        { id: 'ok', label: 'Ok', color: '#ff0000' }, // valid
      ]),
    ]);
    expect(cat.find((s) => s.id === 'ok')).toBeDefined();
    expect(cat.find((s) => s.id === 'bad')).toBeUndefined();
  });

  it('multiple DATA rows merge correctly (append + override)', () => {
    const cat = readFillSwatchCatalog([
      rec([{ id: 'custom1', label: 'Custom 1', color: '#aabbcc' }]),
      rec([{ id: 'blue', label: 'Sky Blue', color: '#87ceeb' }]), // override
    ]);

    const custom1 = cat.find((s) => s.id === 'custom1');
    const updated = cat.find((s) => s.id === 'blue');
    expect(custom1?.label).toBe('Custom 1');
    expect(updated?.label).toBe('Sky Blue');
  });

  it('malformed DATA rows fail open (one bad row skips, rest survive)', () => {
    const cat = readFillSwatchCatalog([
      rec([
        { id: 'ok1', label: 'Ok1', color: '#ff0000' },
        null, // skipped
        { id: 'bad' }, // incomplete, skipped
        { id: 'ok2', label: 'Ok2', color: '#00ff00' },
      ]),
    ]);
    expect(cat.some((s) => s.id === 'ok1')).toBe(true);
    expect(cat.some((s) => s.id === 'ok2')).toBe(true);
  });

  it('built-ins are ordered first, new rows append', () => {
    const cat = readFillSwatchCatalog([
      rec([{ id: 'new-color', label: 'New', color: '#123456' }]),
    ]);
    const ids = cat.map((s) => s.id);
    const newIdx = ids.indexOf('new-color');
    const noneIdx = ids.indexOf('none');
    expect(noneIdx).toBeLessThan(newIdx);
  });

  it('supports various CSS color formats', () => {
    const cat = readFillSwatchCatalog([
      rec([
        { id: 'hex3', label: 'Hex 3', color: '#fff' },
        { id: 'hex6', label: 'Hex 6', color: '#ffffff' },
        { id: 'rgb', label: 'RGB', color: 'rgb(255, 255, 255)' },
        { id: 'var', label: 'CSS Var', color: 'var(--primary)' },
      ]),
    ]);
    expect(cat.find((s) => s.id === 'hex3')?.color).toBe('#fff');
    expect(cat.find((s) => s.id === 'hex6')?.color).toBe('#ffffff');
    expect(cat.find((s) => s.id === 'rgb')?.color).toBe('rgb(255, 255, 255)');
    expect(cat.find((s) => s.id === 'var')?.color).toBe('var(--primary)');
  });

  it('overrides respect SSOT: same DATA row source as stamps/markers', () => {
    // Verify the record structure matches other catalog patterns
    const rec1 = {
      payload: { kind: FILL_SWATCH_CATALOG_KIND, swatches: [{ id: 'test', label: 'Test', color: '#000' }] },
    };
    const cat = readFillSwatchCatalog([rec1]);
    expect(cat.some((s) => s.id === 'test')).toBe(true);
  });
});
