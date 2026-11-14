// packages/group/show/board-shapes.readShapeCatalog.test.ts
import { describe, expect, it } from 'vitest';
import { BOARD_SHAPES, SHAPE_CATALOG_KIND, readShapeCatalog, shapeClipPathById, shapeGeometryById } from './board-shapes';

const rec = (shapes: unknown) => ({ payload: { kind: SHAPE_CATALOG_KIND, shapes } });

describe('readShapeCatalog — shapes as user-extensible DATA (via mergeCatalog)', () => {
  it('returns the built-in shapes verbatim when no DATA rows exist', () => {
    expect(readShapeCatalog([]).map((s) => s.id)).toEqual(BOARD_SHAPES.map((s) => s.id));
  });

  it('APPENDS a user-defined shape (one DATA row, zero code)', () => {
    const pentagon = {
      id: 'pentagon',
      label: 'Pentagon',
      icon: 'Pentagon',
      geometry: { kind: 'polygon' as const, points: [[50, 0], [100, 38], [81, 100], [19, 100], [0, 38]] },
    };
    const cat = readShapeCatalog([rec([pentagon])]);
    expect(cat.find((s) => s.id === 'pentagon')).toBeDefined();
    expect(cat.length).toBe(BOARD_SHAPES.length + 1);
  });

  it('a DATA row overrides a built-in shape by id in place', () => {
    const customEllipse = {
      id: 'ellipse',
      label: 'Wide Ellipse',
      icon: 'Ellipse',
      geometry: { kind: 'ellipse' as const },
    };
    const cat = readShapeCatalog([rec([customEllipse])]);
    const ellipse = cat.find((s) => s.id === 'ellipse');
    expect(ellipse?.label).toBe('Wide Ellipse');
    expect(cat.length).toBe(BOARD_SHAPES.length);
  });

  it('skips rows missing required fields (id, label, icon, geometry)', () => {
    const cat = readShapeCatalog([
      rec([
        { id: 'x', label: 'X' }, // missing icon and geometry
        { id: 'ok', label: 'Ok', icon: 'Square', geometry: { kind: 'rect' as const } }, // valid
      ]),
    ]);
    expect(cat.find((s) => s.id === 'ok')).toBeDefined();
    expect(cat.find((s) => s.id === 'x')).toBeUndefined();
    expect(cat.length).toBe(BOARD_SHAPES.length + 1);
  });

  it('derived clipPath is computed for user-defined shapes (SSOT: geometry → clipPath)', () => {
    const pentagon = {
      id: 'pentagon',
      label: 'Pentagon',
      icon: 'Pentagon',
      geometry: { kind: 'polygon' as const, points: [[50, 0], [100, 38], [81, 100], [19, 100], [0, 38]] },
    };
    const cat = readShapeCatalog([rec([pentagon])]);
    const shape = cat.find((s) => s.id === 'pentagon');
    expect(shape?.clipPath).toBeDefined();
    expect(typeof shape?.clipPath).toBe('string');
  });

  it('shapeClipPathById works with the merged catalog', () => {
    const diamond = {
      id: 'diamond-custom',
      label: 'Custom Diamond',
      icon: 'Diamond',
      geometry: { kind: 'polygon' as const, points: [[50, 0], [100, 50], [50, 100], [0, 50]] },
    };
    const cat = readShapeCatalog([rec([diamond])]);
    const clipPath = shapeClipPathById('diamond-custom', cat);
    expect(clipPath).toBeDefined();
    expect(clipPath.length).toBeGreaterThan(0);
  });

  it('shapeGeometryById works with the merged catalog', () => {
    const triangle = {
      id: 'triangle-custom',
      label: 'Custom Triangle',
      icon: 'Triangle',
      geometry: { kind: 'polygon' as const, points: [[50, 0], [100, 100], [0, 100]] },
    };
    const cat = readShapeCatalog([rec([triangle])]);
    const geo = shapeGeometryById('triangle-custom', cat);
    expect(geo).toBeDefined();
    expect(geo?.kind).toBe('polygon');
  });

  it('multiple DATA rows merge correctly (append + override)', () => {
    const row1 = [{ id: 'new1', label: 'New 1', icon: 'Square', geometry: { kind: 'rect' as const } }];
    const row2 = [{ id: 'fire', label: 'Hot Fire', icon: 'Flame', geometry: { kind: 'rect' as const } }]; // override
    const cat = readShapeCatalog([rec(row1), rec(row2)]);

    const new1 = cat.find((s) => s.id === 'new1');
    const updated = cat.find((s) => s.id === 'fire');
    expect(new1?.label).toBe('New 1');
    expect(updated?.label).toBe('Hot Fire');
  });

  it('malformed DATA rows fail open (one bad row skips, rest survive)', () => {
    const cat = readShapeCatalog([
      rec([
        { id: 'ok', label: 'Ok', icon: 'Square', geometry: { kind: 'rect' as const } },
        null, // skipped
        { id: 'bad' }, // incomplete, skipped
        { id: 'ok2', label: 'Ok2', icon: 'Circle', geometry: { kind: 'ellipse' as const } },
      ]),
    ]);
    expect(cat.some((s) => s.id === 'ok')).toBe(true);
    expect(cat.some((s) => s.id === 'ok2')).toBe(true);
  });

  it('built-ins are ordered first, new rows append', () => {
    const cat = readShapeCatalog([
      rec([{ id: 'new-shape', label: 'New', icon: 'Shape', geometry: { kind: 'rect' as const } }]),
    ]);
    const ids = cat.map((s) => s.id);
    const newIdx = ids.indexOf('new-shape');
    const rectIdx = ids.indexOf('rectangle');
    expect(rectIdx).toBeLessThan(newIdx);
  });
});
