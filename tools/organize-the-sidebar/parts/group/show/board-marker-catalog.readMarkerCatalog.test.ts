// packages/group/show/board-marker-catalog.readMarkerCatalog.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  BOARD_MARKERS,
  MARKER_CATALOG_KIND,
  markerById,
  markerTextForIndex,
  readMarkerCatalog,
} from '../../../show/board-marker-catalog.ts';

const rec = (markers: unknown) => ({ payload: { kind: MARKER_CATALOG_KIND, markers } });

describe('readMarkerCatalog — markers as user-extensible DATA (L090 SSOT)', () => {
  it('returns the built-ins verbatim when no DATA rows exist', () => {
    expect(readMarkerCatalog([]).map((m) => m.id)).toEqual(BOARD_MARKERS.map((m) => m.id));
  });

  it('APPENDS a new user-defined glyph marker (one DATA row, zero code)', () => {
    const cat = readMarkerCatalog([rec([{ id: 'heart', label: 'Heart', produce: 'glyph', glyph: '♥' }])]);
    const heart = markerById('heart', cat);
    expect(heart?.glyph).toBe('♥');
    // resolves through the SAME producer path as a built-in glyph
    expect(markerTextForIndex(markerById('heart', cat), 0)).toBe('♥');
  });

  it('a DATA row can reuse ANY existing producer — e.g. a new ordinal variant', () => {
    const cat = readMarkerCatalog([rec([{ id: 'upper-roman', label: 'Upper roman', produce: 'ordinal', ordinal: 'roman', ordinalCase: 'upper', suffix: ')' }])]);
    expect(markerTextForIndex(markerById('upper-roman', cat), 3)).toBe('IV)'); // 4th item, upper roman
  });

  it('a DATA row whose id matches a built-in OVERRIDES it in place (SSOT)', () => {
    const cat = readMarkerCatalog([rec([{ id: 'disc', label: 'Disc', produce: 'glyph', glyph: '❖' }])]);
    expect(markerById('disc', cat)?.glyph).toBe('❖');
    // order preserved (override in place, not appended)
    expect(cat[0].id).toBe('disc');
    expect(cat.length).toBe(BOARD_MARKERS.length);
  });

  it('skips malformed rows (missing id/label/produce) — never throws', () => {
    const cat = readMarkerCatalog([rec([{ label: 'no id', produce: 'glyph' }, { id: 'ok', label: 'Ok', produce: 'glyph', glyph: '*' }])]);
    expect(markerById('ok', cat)?.glyph).toBe('*');
    expect(cat.length).toBe(BOARD_MARKERS.length + 1); // only the well-formed row was added
  });

  it('ignores records that are not marker-catalog payloads', () => {
    expect(readMarkerCatalog([{ payload: { kind: 'something-else', markers: [{ id: 'x', label: 'X', produce: 'glyph' }] } }]).length).toBe(BOARD_MARKERS.length);
  });
});
