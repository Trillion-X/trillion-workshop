// packages/group/show/board-stamps.readStampCatalog.test.ts
import { describe, expect, it } from 'vitest';
import { BOARD_STAMPS, STAMP_CATALOG_KIND, readStampCatalog, stampEmojiById } from './board-stamps';
import { buildItemShelf } from './item-renderers';

const rec = (stamps: unknown) => ({ payload: { kind: STAMP_CATALOG_KIND, stamps } });

describe('readStampCatalog — stamps as user-extensible DATA (via mergeCatalog)', () => {
  it('returns the built-in stamps verbatim when no DATA rows exist', () => {
    expect(readStampCatalog([]).map((s) => s.id)).toEqual(BOARD_STAMPS.map((s) => s.id));
  });

  it('APPENDS a user-defined stamp (one DATA row, zero code)', () => {
    const cat = readStampCatalog([rec([{ id: 'unicorn', label: 'Unicorn', emoji: '🦄' }])]);
    expect(stampEmojiById('unicorn', cat)).toBe('🦄');
    expect(cat.length).toBe(BOARD_STAMPS.length + 1);
  });

  it('a DATA row overrides a built-in stamp by id in place', () => {
    const cat = readStampCatalog([rec([{ id: 'fire', label: 'Blue fire', emoji: '🔵' }])]);
    expect(stampEmojiById('fire', cat)).toBe('🔵');
    expect(cat.length).toBe(BOARD_STAMPS.length);
  });

  it('skips rows missing id/label/emoji (a stamp with no glyph is meaningless)', () => {
    const cat = readStampCatalog([rec([{ id: 'x', label: 'X' }, { id: 'ok', label: 'Ok', emoji: '✨' }])]);
    expect(cat.length).toBe(BOARD_STAMPS.length + 1);
  });

  it('buildItemShelf surfaces a DATA stamp in the Stamp tool flyout', () => {
    const shelf = buildItemShelf(readStampCatalog([rec([{ id: 'unicorn', label: 'Unicorn', emoji: '🦄' }])]));
    const stampTool = shelf.find((t) => t.kind === 'stamp');
    expect(stampTool?.variants?.some((v) => v.emoji === '🦄' && v.defaultText === '🦄')).toBe(true);
  });

  it('buildItemShelf() with no catalog is byte-identical to the built-in shelf (zero regression)', () => {
    const stampVariants = buildItemShelf().find((t) => t.kind === 'stamp')?.variants;
    expect(stampVariants?.map((v) => v.id)).toEqual(BOARD_STAMPS.map((s) => s.id));
  });
});
