// packages/group/show/board-marker-catalog.test.ts
//
// Proves the list-marker catalog + pure resolver: glyph markers return their char
// for any index, ordinals compute decimal/roman/alpha correctly (including the
// edge cases that matter — iv, ix, xl, mmmcmxcix; z→aa→ab), case is applied, and
// an unknown/undefined marker is a safe empty string. Catalog integrity: unique
// ids, all resolvable via markerById.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  BOARD_MARKERS,
  MARKER_DEFAULT_OPTIONS,
  markerById,
  markerTextForIndex,
  markerCellForIndex,
  MARKER_CELL_PRODUCERS,
  readMarkerCatalog,
  resolveLevelMarkers,
  type BoardMarker,
  type MarkerCellProducer,
} from '../../../show/board-marker-catalog.ts';

describe('board-marker-catalog', () => {
  it('glyph marker returns its char for any index', () => {
    const disc = markerById('disc');
    expect(disc?.glyph).toBe('•');
    expect(markerTextForIndex(disc, 0)).toBe('•');
    expect(markerTextForIndex(disc, 7)).toBe('•');
    expect(markerTextForIndex(disc, 999)).toBe('•');

    const arrow = markerById('arrow');
    expect(markerTextForIndex(arrow, 0)).toBe('→');
    expect(markerTextForIndex(arrow, 42)).toBe('→');
  });

  it('decimal with suffix "." renders "1.", "2." …', () => {
    const decimal = markerById('decimal');
    expect(markerTextForIndex(decimal, 0)).toBe('1.');
    expect(markerTextForIndex(decimal, 1)).toBe('2.');
    expect(markerTextForIndex(decimal, 9)).toBe('10.');
  });

  it('roman lower: 0→i, 3→iv, 8→ix, 39→xl, 3998→mmmcmxcix', () => {
    // A roman marker with no suffix, lowercase, to test the bare numeral.
    const roman: BoardMarker = { id: 't-roman', label: 'r', produce: 'ordinal', ordinal: 'roman', ordinalCase: 'lower' };
    expect(markerTextForIndex(roman, 0)).toBe('i');
    expect(markerTextForIndex(roman, 3)).toBe('iv');
    expect(markerTextForIndex(roman, 8)).toBe('ix');
    expect(markerTextForIndex(roman, 39)).toBe('xl');
    expect(markerTextForIndex(roman, 3999 - 1)).toBe('mmmcmxcix');
  });

  it('roman upper case', () => {
    const roman: BoardMarker = { id: 't-roman-u', label: 'R', produce: 'ordinal', ordinal: 'roman', ordinalCase: 'upper', suffix: '.' };
    expect(markerTextForIndex(roman, 0)).toBe('I.');
    expect(markerTextForIndex(roman, 3)).toBe('IV.');
    expect(markerTextForIndex(roman, 8)).toBe('IX.');
    expect(markerTextForIndex(roman, 39)).toBe('XL.');
  });

  it('alpha: 0→a, 25→z, 26→aa, 27→ab', () => {
    const alpha: BoardMarker = { id: 't-alpha', label: 'a', produce: 'ordinal', ordinal: 'alpha', ordinalCase: 'lower' };
    expect(markerTextForIndex(alpha, 0)).toBe('a');
    expect(markerTextForIndex(alpha, 25)).toBe('z');
    expect(markerTextForIndex(alpha, 26)).toBe('aa');
    expect(markerTextForIndex(alpha, 27)).toBe('ab');
  });

  it('alpha upper case', () => {
    const alpha: BoardMarker = { id: 't-alpha-u', label: 'A', produce: 'ordinal', ordinal: 'alpha', ordinalCase: 'upper' };
    expect(markerTextForIndex(alpha, 0)).toBe('A');
    expect(markerTextForIndex(alpha, 26)).toBe('AA');
  });

  it('unknown/undefined marker → "" (never throws)', () => {
    expect(markerTextForIndex(undefined, 0)).toBe('');
    expect(markerTextForIndex(markerById('nope'), 5)).toBe('');
    expect(markerById(undefined)).toBeUndefined();
    expect(markerById('nope')).toBeUndefined();
  });

  it('BOARD_MARKERS all have unique ids and markerById finds them', () => {
    const ids = BOARD_MARKERS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of BOARD_MARKERS) {
      expect(markerById(m.id)).toEqual(m);
    }
    // The spec-required minimum set is present.
    for (const required of ['disc', 'circle', 'square', 'dash', 'star', 'arrow', 'check', 'decimal', 'roman', 'alpha']) {
      expect(markerById(required)).toBeDefined();
    }
  });

  it('resolves the catalog rows end to end (disc glyph, decimal, roman, alpha)', () => {
    expect(markerTextForIndex(markerById('disc'), 0)).toBe('•');
    expect(markerTextForIndex(markerById('decimal'), 4)).toBe('5.');
    expect(markerTextForIndex(markerById('roman'), 8)).toBe('ix.');
    expect(markerTextForIndex(markerById('alpha'), 0)).toBe('a.');
    expect(markerTextForIndex(markerById('lower-alpha'), 26)).toBe('aa)');
  });

  it('emoji is just a glyph — no producer/resolver change (fire → 🔥 for any index)', () => {
    const fire = markerById('fire');
    expect(fire?.produce).toBe('glyph');
    expect(markerTextForIndex(fire, 0)).toBe('🔥');
    expect(markerTextForIndex(fire, 12)).toBe('🔥');
  });

  it('EMERGENT: the cycle producer rotates glyphs per item by index (moon phases)', () => {
    const moon = markerById('moon');
    expect(moon?.produce).toBe('cycle');
    expect(markerTextForIndex(moon, 0)).toBe('🌑');
    expect(markerTextForIndex(moon, 4)).toBe('🌕');
    expect(markerTextForIndex(moon, 7)).toBe('🌘');
    // Wraps: index 8 returns to the first phase (8 % 8 === 0).
    expect(markerTextForIndex(moon, 8)).toBe('🌑');
    expect(markerTextForIndex(moon, 12)).toBe('🌕');
  });

  it('cycle with a negative index stays in-range (never throws / out of bounds)', () => {
    const cyc: BoardMarker = { id: 't-cyc', label: 'c', produce: 'cycle', glyphs: ['a', 'b', 'c'] };
    expect(markerTextForIndex(cyc, -1)).toBe('c');
    const empty: BoardMarker = { id: 't-cyc0', label: 'c', produce: 'cycle', glyphs: [] };
    expect(markerTextForIndex(empty, 0)).toBe('');
  });

  it('ENUM DISSOLVED: the resolver dispatches through the producer map — a new produce id needs ZERO resolver code', () => {
    // A weekday marker invented purely as DATA + one injected producer. The resolver
    // is unchanged — proof the discriminant is data, not a closed union (L090).
    const weekday: BoardMarker = { id: 't-weekday', label: 'Weekday', produce: 'weekday' };
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const producers: Record<string, MarkerCellProducer> = {
      ...MARKER_CELL_PRODUCERS,
      weekday: (_m, i) => ({ text: days[Math.floor(i) % 7] ?? '' }),
    };
    expect(markerTextForIndex(weekday, 0, producers)).toBe('Sun');
    expect(markerTextForIndex(weekday, 3, producers)).toBe('Wed');
    // Without the injected producer the same DATA resolves to '' (unknown produce → safe).
    expect(markerTextForIndex(weekday, 0)).toBe('');
  });

  it('MEDIA MARKER: an image bullet produces a media cell (a request: "a bullet can be an image/video")', () => {
    const img: BoardMarker = { id: 't-img', label: 'Photo', produce: 'image', mediaUrl: 'https://x/y.png' };
    const cell = markerCellForIndex(img, 0);
    expect(cell.mediaUrl).toBe('https://x/y.png');
    expect(cell.mediaType).toBe('image/*'); // MIME prefix so MediaFrame dispatches <img>
    expect(cell.text).toBeUndefined();
    // A media marker projects to '' in the text view (picker preview falls back to the label).
    expect(markerTextForIndex(img, 0)).toBe('');

    const vid: BoardMarker = { id: 't-vid', label: 'Clip', produce: 'video', mediaUrl: 'https://x/z.mp4' };
    expect(markerCellForIndex(vid, 0)).toEqual({ mediaUrl: 'https://x/z.mp4', mediaType: 'video/*' });

    // An image marker with no URL → empty cell (fail-closed, never a broken <img>).
    expect(markerCellForIndex({ id: 't-img0', label: 'x', produce: 'image' }, 0)).toEqual({});
  });

  it('text markers project to a text-only cell (mediaUrl absent) — the descriptor is uniform', () => {
    expect(markerCellForIndex(markerById('star'), 0)).toEqual({ text: '★' });
    expect(markerCellForIndex(markerById('decimal'), 4)).toEqual({ text: '5.' });
    expect(markerCellForIndex(markerById('moon'), 4)).toEqual({ text: '🌕' });
    expect(markerCellForIndex(undefined, 0)).toEqual({});
  });

  it('every catalog row has a produce id that is a known producer (no orphan discriminants)', () => {
    for (const m of BOARD_MARKERS) {
      expect(typeof m.produce).toBe('string');
      expect(MARKER_CELL_PRODUCERS[m.produce]).toBeTypeOf('function');
    }
  });
});

describe('custom glyph marker (R3 — "whatever they want it to be")', () => {
  it('exposes a Custom row that is a glyph producer flagged needsGlyph (open, no fixed char)', () => {
    const custom = markerById('custom')!;
    expect(custom.produce).toBe('glyph');
    expect(custom.needsGlyph).toBe(true);
    expect(custom.glyph).toBeUndefined(); // the char is per-item, not baked into the catalog
  });

  it('with a per-item glyph OVERLAID, the cell renders ANY char/emoji (♥, 🌈, →…) — zero new rows', () => {
    const custom = markerById('custom')!;
    for (const g of ['♥', '🌈', '→', '✦', 'A']) {
      expect(markerCellForIndex({ ...custom, glyph: g }, 0)).toEqual({ text: g });
      expect(markerCellForIndex({ ...custom, glyph: g }, 7)).toEqual({ text: g }); // index-independent
    }
  });

  it('a custom marker with NO glyph overlaid is an empty cell (fail-safe, never a broken bullet)', () => {
    expect(markerCellForIndex(markerById('custom'), 0)).toEqual({ text: '' });
  });

  describe('MARKER_DEFAULT_OPTIONS — the board-default bullet-marker picker options (glyph-only)', () => {
    it('is GLYPH-only: every option id resolves to a produce:"glyph" marker with a real glyph, and NO ordinal/media/custom leaks in', () => {
      expect(MARKER_DEFAULT_OPTIONS.length).toBeGreaterThan(0);
      for (const opt of MARKER_DEFAULT_OPTIONS) {
        const m = markerById(opt.value);
        expect(m).toBeTruthy();
        expect(m!.produce).toBe('glyph');
        expect(typeof m!.glyph).toBe('string');
        expect(m!.needsGlyph).toBeFalsy(); // the open "custom" case needs a per-item glyph → not a board default
        expect(m!.needsMediaUrl).toBeFalsy(); // image/video need a per-item URL → not a board default
        // The label leads with the glyph so the picker shows the actual bullet.
        expect(opt.label.startsWith(m!.glyph as string)).toBe(true);
      }
    });

    it('excludes decimal/roman/alpha ordinals, image/video, and custom (they need per-item ordering/URL/glyph)', () => {
      const ids = new Set(MARKER_DEFAULT_OPTIONS.map((o) => o.value));
      for (const excluded of ['decimal', 'roman', 'alpha', 'lower-alpha', 'image', 'video', 'custom', 'moon']) {
        expect(ids.has(excluded)).toBe(false);
      }
      // The everyday glyph bullets ARE offered.
      for (const glyphId of ['disc', 'dash', 'check', 'star']) expect(ids.has(glyphId)).toBe(true);
    });

    it('derives from BOARD_MARKERS (SSOT) — options are a subset of the catalog ids, no duplicates', () => {
      const catalogIds = new Set(BOARD_MARKERS.map((m) => m.id));
      const optionIds = MARKER_DEFAULT_OPTIONS.map((o) => o.value);
      for (const id of optionIds) expect(catalogIds.has(id)).toBe(true);
      expect(new Set(optionIds).size).toBe(optionIds.length);
    });
  });
});

describe('prototype-key produce/ordinal never crash the resolver (cont.98 batch-16)', () => {
  it("a marker with produce '__proto__'/'constructor'/'toString' resolves to an empty cell, not a crash", () => {
    expect(() => markerCellForIndex({ id: 'p', label: 'P', produce: '__proto__' } as BoardMarker, 0)).not.toThrow();
    expect(markerCellForIndex({ id: 'p', label: 'P', produce: '__proto__' } as BoardMarker, 0)).toEqual({});
    expect(markerCellForIndex({ id: 'c', label: 'C', produce: 'constructor' } as BoardMarker, 0)).toEqual({});
    expect(markerCellForIndex({ id: 't', label: 'T', produce: 'toString' } as BoardMarker, 3)).toEqual({});
  });
  it("an ordinal marker with ordinal '__proto__'/'constructor' resolves to an empty cell, not a crash", () => {
    const m = { id: 'o', label: 'O', produce: 'ordinal', ordinal: '__proto__', ordinalCase: 'upper' } as BoardMarker;
    expect(() => markerCellForIndex(m, 0)).not.toThrow();
    expect(markerCellForIndex(m, 0)).toEqual({});
    expect(markerCellForIndex({ id: 'o2', label: 'O2', produce: 'ordinal', ordinal: 'constructor', ordinalCase: 'upper' } as BoardMarker, 0)).toEqual({});
  });
  it('a real glyph/ordinal marker still resolves (zero regression)', () => {
    expect(markerCellForIndex(markerById('disc'), 0)).toEqual({ text: '•' });
    expect(markerCellForIndex(markerById('decimal'), 0).text).toBe('1.');
  });
});

describe('board-marker-catalog red-team — untrusted DATA caps (cont.98 batch-33)', () => {
  // #5: a huge glyph / mediaUrl (a per-item extra.markerGlyph/markerMediaUrl overlay is untrusted) is
  // length-capped in the render cell, never emitted whole.
  it('caps a huge glyph and mediaUrl in the rendered marker cell', () => {
    const bigGlyph: BoardMarker = { id: 'g', label: 'G', produce: 'glyph', glyph: 'x'.repeat(1_000_000) };
    expect(markerCellForIndex(bigGlyph, 0).text!.length).toBeLessThanOrEqual(64);
    const bigMedia: BoardMarker = { id: 'm', label: 'M', produce: 'image', mediaUrl: 'https://x/' + 'a'.repeat(1_000_000) };
    expect(markerCellForIndex(bigMedia, 0).mediaUrl!.length).toBeLessThanOrEqual(2048);
  });

  // #6: a marker-catalog published-record with a million-entry glyphs array + megabyte strings is bounded
  // (the row is parsed without scanning the whole hostile array; the stored glyphs are capped).
  it('caps a hostile marker-catalog row (giant glyphs array + huge strings) without scanning it whole', () => {
    const hostile = [{ payload: { kind: 'marker-catalog', markers: [
      { id: 'h', label: 'L'.repeat(1_000_000), produce: 'cycle', glyphs: new Array(1_000_000).fill('z') },
    ] } }];
    let cat: ReturnType<typeof readMarkerCatalog> | undefined;
    expect(() => { cat = readMarkerCatalog(hostile); }).not.toThrow();
    const row = cat!.find((m) => m.id === 'h')!;
    expect(row.label.length).toBeLessThanOrEqual(200);
    expect(row.glyphs!.length).toBeLessThanOrEqual(256);
  });

  // #7: a giant extra.outlineMarkers array is capped to a sane nesting depth, not mapped whole.
  it('caps resolveLevelMarkers to a sane outline depth', () => {
    const huge = new Array(1_000_000).fill('disc');
    expect(resolveLevelMarkers(huge).length).toBeLessThanOrEqual(32);
    // a normal outline still resolves fully (zero regression)
    expect(resolveLevelMarkers(['decimal', 'lower-alpha']).map((m) => m?.id)).toEqual(['decimal', 'lower-alpha']);
  });
});
