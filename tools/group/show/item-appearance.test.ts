import { describe, it, expect } from 'vitest';
import {
  resolveAppearanceKey,
  sizeModeStyle,
  sizeModeIsAutoHeight,
  boardDefaultItemSize,
  boardExportLook,
  GLOBAL_APPEARANCE,
  SIZE_MODE_OPTIONS,
  PADDING_OPTIONS,
  BOARD_DEFAULT_CONTROLS,
  ITEM_APPEARANCE_CONTROLS,
} from './item-appearance';

describe('resolveAppearanceKey — the global→board→item cascade', () => {
  it('falls back to the GLOBAL default when neither board nor item specifies it', () => {
    expect(resolveAppearanceKey('containerVariant', undefined, undefined)).toBe('surface');
    expect(resolveAppearanceKey('sizeMode', undefined, undefined)).toBe('fit');
  });

  it('a BOARD default overrides the global', () => {
    expect(resolveAppearanceKey('containerVariant', undefined, { containerVariant: 'elevated' })).toBe('elevated');
  });

  it('R2b — the connector default look (color + width) flows through the cascade', () => {
    // global default reproduces the old hardcoded IDLE/2 (zero-regression)
    expect(resolveAppearanceKey('connectorColor', undefined, undefined)).toBe(GLOBAL_APPEARANCE.connectorColor);
    expect(resolveAppearanceKey('connectorWidth', undefined, undefined)).toBe(2);
    // a board themes its default connectors; a per-connector override still wins
    expect(resolveAppearanceKey('connectorColor', undefined, { connectorColor: '#e11d48' })).toBe('#e11d48');
    expect(resolveAppearanceKey('connectorWidth', undefined, { connectorWidth: 5 })).toBe(5);
    expect(resolveAppearanceKey('connectorColor', '#2563eb', { connectorColor: '#e11d48' })).toBe('#2563eb');
  });

  it('an ITEM override wins over both board and global', () => {
    expect(resolveAppearanceKey('containerVariant', 'ghost', { containerVariant: 'elevated' })).toBe('ghost');
  });

  it('treats empty/null/undefined item values as "no override" (falls through to board/global)', () => {
    expect(resolveAppearanceKey('sizeMode', '', { sizeMode: 'scroll' })).toBe('scroll');
    expect(resolveAppearanceKey('sizeMode', null, { sizeMode: 'scroll' })).toBe('scroll');
    expect(resolveAppearanceKey('sizeMode', undefined, { sizeMode: 'scroll' })).toBe('scroll');
  });

  it('treats empty/null board values as "no board override" (falls through to global)', () => {
    expect(resolveAppearanceKey('containerVariant', undefined, { containerVariant: '' })).toBe('surface');
    expect(resolveAppearanceKey('containerVariant', undefined, { containerVariant: null })).toBe('surface');
  });

  it('is GENERIC — resolves a key it never heard of purely from the profiles (L090)', () => {
    // A brand-new appearance property needs zero code here.
    expect(resolveAppearanceKey('cornerStyle', 'squircle', { cornerStyle: 'round' }, { cornerStyle: 'sharp' })).toBe('squircle');
    expect(resolveAppearanceKey('cornerStyle', undefined, { cornerStyle: 'round' }, { cornerStyle: 'sharp' })).toBe('round');
    expect(resolveAppearanceKey('cornerStyle', undefined, undefined, { cornerStyle: 'sharp' })).toBe('sharp');
  });

  it('GLOBAL_APPEARANCE reproduces the pre-cascade hardcoded look (zero-regression)', () => {
    expect(GLOBAL_APPEARANCE.containerVariant).toBe('surface');
    expect(GLOBAL_APPEARANCE.sizeMode).toBe('fit');
    expect(GLOBAL_APPEARANCE.padding).toBe('md'); // was hardcoded padding="md"
    expect(GLOBAL_APPEARANCE.defaultWidth).toBe(220); // was hardcoded DEFAULTS.w
    expect(GLOBAL_APPEARANCE.defaultHeight).toBe(160); // was hardcoded DEFAULTS.h
  });

  it('padding is the 3rd cascade property — proves emergence (added with ZERO resolver change, L069)', () => {
    // Global 'md' when unset, board default overrides, item override wins — same rule, no new code.
    expect(resolveAppearanceKey('padding', undefined, undefined)).toBe('md');
    expect(resolveAppearanceKey('padding', undefined, { padding: 'sm' })).toBe('sm');
    expect(resolveAppearanceKey('padding', 'lg', { padding: 'sm' })).toBe('lg');
    expect(resolveAppearanceKey('padding', '', { padding: 'none' })).toBe('none');
  });
});

describe('boardDefaultItemSize — R2b fold of the hardcoded DEFAULTS {220,160}', () => {
  it('no board override → the pre-cascade 220×160 (zero-regression)', () => {
    expect(boardDefaultItemSize(undefined)).toEqual({ w: 220, h: 160 });
    expect(boardDefaultItemSize({})).toEqual({ w: 220, h: 160 });
  });
  it('a board default footprint wins over the global', () => {
    expect(boardDefaultItemSize({ defaultWidth: 400, defaultHeight: 300 })).toEqual({ w: 400, h: 300 });
  });
  it('only width overridden → height stays the global default', () => {
    expect(boardDefaultItemSize({ defaultWidth: 500 })).toEqual({ w: 500, h: 160 });
  });
  it('a bad preset (0, negative, NaN, non-number) fails safe to the global (never a zero-size item)', () => {
    expect(boardDefaultItemSize({ defaultWidth: 0, defaultHeight: -5 })).toEqual({ w: 220, h: 160 });
    expect(boardDefaultItemSize({ defaultWidth: 'big' as unknown as number })).toEqual({ w: 220, h: 160 });
    expect(boardDefaultItemSize({ defaultWidth: NaN })).toEqual({ w: 220, h: 160 });
  });
});

describe('boardExportLook — cont.26 appearance-cascade → export-contract opts (live == export)', () => {
  it('a crisp/un-themed board yields NO opts (byte-identical export, zero regression)', () => {
    expect(boardExportLook(undefined)).toEqual({});
    expect(boardExportLook({})).toEqual({});
    // zero/blank axes are omitted, never passed as 0 (which would still read as crisp but is noise).
    expect(boardExportLook({ connectorRoughness: 0, borderRoughness: 0, fontFamily: '' })).toEqual({});
  });
  it('a sketch board maps font + BOTH roughness axes as distinct DATA opts', () => {
    expect(boardExportLook({ fontFamily: "'Comic Sans MS', cursive", connectorRoughness: 1.6, borderRoughness: 3.2 }))
      .toEqual({ fontFamily: "'Comic Sans MS', cursive", connectorRoughness: 1.6, borderRoughness: 3.2 });
  });
  it('each axis is independent — a connector-only-rough board carries no borderRoughness opt', () => {
    expect(boardExportLook({ connectorRoughness: 2 })).toEqual({ connectorRoughness: 2 });
    expect(boardExportLook({ borderRoughness: 2 })).toEqual({ borderRoughness: 2 });
  });
  it('the NAMED connector brushstroke is carried when non-solid and omitted for the crisp solid default', () => {
    expect(boardExportLook({ connectorStrokeStyle: 'pencil' })).toEqual({ connectorStrokeStyle: 'pencil' });
    expect(boardExportLook({ connectorStrokeStyle: 'solid' })).toEqual({}); // crisp default → byte-identical export
  });
  it('the NAMED note-border brushstroke is carried when non-solid and omitted for solid', () => {
    expect(boardExportLook({ borderStrokeStyle: 'pencil' })).toEqual({ borderStrokeStyle: 'pencil' });
    expect(boardExportLook({ borderStrokeStyle: 'solid' })).toEqual({});
    // both named axes travel together, independently.
    expect(boardExportLook({ connectorStrokeStyle: 'sketch', borderStrokeStyle: 'dashed' }))
      .toEqual({ connectorStrokeStyle: 'sketch', borderStrokeStyle: 'dashed' });
  });
});

describe('sizeModeStyle — the capability map (dissolves R1: fixed/fill/scroll)', () => {
  it('fit → no fixed height (auto-height owns it, #217)', () => {
    expect(sizeModeStyle('fit')).toEqual({});
  });

  it('fill → stretches to the box, clips overflow', () => {
    expect(sizeModeStyle('fill')).toEqual({ height: '100%', overflow: 'hidden' });
  });

  it('scroll → fixed box, content scrolls inside', () => {
    expect(sizeModeStyle('scroll')).toEqual({ height: '100%', overflow: 'auto', minHeight: 0 });
  });

  it('unknown / absent → fit (today’s behavior)', () => {
    expect(sizeModeStyle('some-future-mode')).toEqual({});
    expect(sizeModeStyle(undefined)).toEqual({});
    expect(sizeModeStyle('')).toEqual({});
  });
});

describe('sizeModeIsAutoHeight — only fit drives #217 auto-grow', () => {
  it('fit (and absent) auto-heights', () => {
    expect(sizeModeIsAutoHeight('fit')).toBe(true);
    expect(sizeModeIsAutoHeight(undefined)).toBe(true);
    expect(sizeModeIsAutoHeight('')).toBe(true);
  });

  it('fill and scroll pin the box (no auto-grow)', () => {
    expect(sizeModeIsAutoHeight('fill')).toBe(false);
    expect(sizeModeIsAutoHeight('scroll')).toBe(false);
  });
});

describe('SIZE_MODE_OPTIONS — DATA-driven control rows', () => {
  it('exposes the three shipped modes as {value,label} DATA (control renders these, no closed union)', () => {
    expect(SIZE_MODE_OPTIONS.map((o) => o.value)).toEqual(['fit', 'fill', 'scroll']);
    expect(SIZE_MODE_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length > 0)).toBe(true);
  });
});

describe('PADDING_OPTIONS — DATA-driven density rows', () => {
  it('exposes density values that match the ui Card padding scale (resolved value passes through)', () => {
    expect(PADDING_OPTIONS.map((o) => o.value)).toEqual(['none', 'sm', 'md', 'lg']);
    expect(PADDING_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length > 0)).toBe(true);
  });
});

describe('ITEM_APPEARANCE_CONTROLS — the board registry projected to the per-item tier', () => {
  it('is exactly the note-appearance keys (itemLabel-carrying), relabelled — no connector/footprint keys', () => {
    // The item tier is a projection of BOARD_DEFAULT_CONTROLS: only descriptors with an itemLabel.
    // cont.26 adds Border + Font; b91/b92/b97 add per-item Text placement / Depth / Image filter.
    expect(ITEM_APPEARANCE_CONTROLS.map((d) => d.key)).toEqual(['containerVariant', 'sizeMode', 'padding', 'borderStrokeStyle', 'fontFamily', 'contentAnchor', 'elevation', 'photoFilter']);
    // …relabelled to their item labels (not the "on this board" board labels).
    expect(ITEM_APPEARANCE_CONTROLS.map((d) => d.label)).toEqual(['Note style', 'Text size', 'Note density', 'Border', 'Font', 'Text placement', 'Depth', 'Image filter']);
    // Connector defaults + new-note footprint are board-only (no itemLabel) → never in the item picker.
    for (const key of ['connectorColor', 'connectorRouting', 'defaultWidth']) {
      expect(ITEM_APPEARANCE_CONTROLS.some((d) => d.key === key)).toBe(false);
    }
  });

  it('preserves each descriptor widget + options DATA (same blind BoardDefaultControl renders both tiers)', () => {
    for (const item of ITEM_APPEARANCE_CONTROLS) {
      const board = BOARD_DEFAULT_CONTROLS.find((d) => d.key === item.key)!;
      expect(item.widget).toBe(board.widget);
      expect(item.options).toBe(board.options); // shared options SSOT (same reference)
    }
  });
});

describe('board-DEFAULT bullet marker (R3 × R2b) — marker flows through the SAME cascade', () => {
  it('resolves the cascade: item override wins → board default → global (undefined = no marker, zero-regression)', () => {
    // Nothing set anywhere → GLOBAL has no marker key → undefined (no bullet, today's behavior).
    expect(resolveAppearanceKey('marker', undefined, undefined)).toBeUndefined();
    // Board default only → every note inherits it.
    expect(resolveAppearanceKey('marker', undefined, { marker: 'check' })).toBe('check');
    // Per-item override wins over the board default.
    expect(resolveAppearanceKey('marker', 'star', { marker: 'check' })).toBe('star');
    // Empty per-item value falls through to the board default (the '' = unset convention).
    expect(resolveAppearanceKey('marker', '', { marker: 'disc' })).toBe('disc');
  });

  it('is exposed as a board-default control: ONE select descriptor over the glyph options, board-only (no itemLabel)', () => {
    const row = BOARD_DEFAULT_CONTROLS.find((d) => d.key === 'marker');
    expect(row).toBeTruthy();
    expect(row!.widget).toBe('select');
    expect(row!.options?.length).toBeGreaterThan(0);
    expect(row!.itemLabel).toBeUndefined(); // per-item marker stays on the existing MarkerPicker toolbar
  });
});

describe('board-DEFAULT note shape (#155 × R2b) — shape flows through the SAME cascade', () => {
  it('resolves the cascade: item override wins → board default → global (undefined = rectangle, zero-regression)', () => {
    // Nothing set → GLOBAL has no shape key → undefined (rectangle card, today's behavior).
    expect(resolveAppearanceKey('shape', undefined, undefined)).toBeUndefined();
    // Board default only → every note inherits the shape.
    expect(resolveAppearanceKey('shape', undefined, { shape: 'ellipse' })).toBe('ellipse');
    // Per-item override wins (a note opts into a different shape…).
    expect(resolveAppearanceKey('shape', 'diamond', { shape: 'ellipse' })).toBe('diamond');
    // …or opts OUT back to rectangle explicitly (per-item 'rectangle' → no shape path downstream).
    expect(resolveAppearanceKey('shape', 'rectangle', { shape: 'ellipse' })).toBe('rectangle');
  });

  it('is exposed as a board-default control: ONE select descriptor over the shape options, board-only (no itemLabel)', () => {
    const row = BOARD_DEFAULT_CONTROLS.find((d) => d.key === 'shape');
    expect(row).toBeTruthy();
    expect(row!.widget).toBe('select');
    expect(row!.options?.length).toBeGreaterThan(0);
    expect(row!.itemLabel).toBeUndefined(); // per-item shape stays on the bulk-bar BoardShapeControls
  });
});

describe('item-appearance red-team — untrusted appearance DATA hardening (cont.98 batch-32)', () => {
  // #1: a prototype-named sizeMode (from extra.sizeMode) falls back to fit, never returns Object.prototype/ctor.
  it('sizeModeStyle fails closed on a prototype-named mode', () => {
    for (const mode of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      expect(sizeModeStyle(mode)).toEqual({}); // === the fit style, not an inherited object/function
    }
    expect(sizeModeStyle('fill')).toEqual({ height: '100%', overflow: 'hidden' }); // a real mode still resolves
  });

  // #2: sizeModeStyle and sizeModeIsAutoHeight AGREE on an unknown/future mode (both treat it as fit) — an
  // unknown mode must not render fit styles yet skip auto-height.
  it('an unknown / prototype mode is treated as fit by BOTH style and auto-height', () => {
    expect(sizeModeStyle('future-mode')).toEqual({});
    expect(sizeModeIsAutoHeight('future-mode')).toBe(true);
    expect(sizeModeIsAutoHeight('__proto__')).toBe(true);
    expect(sizeModeIsAutoHeight('fill')).toBe(false); // known non-fit modes still pin the box (zero regression)
    expect(sizeModeIsAutoHeight('scroll')).toBe(false);
    expect(sizeModeIsAutoHeight('fit')).toBe(true);
  });

  // #3: a persisted Number.MAX_VALUE / Infinity board default dimension is clamped, not accepted as-is.
  it('boardDefaultItemSize clamps a MAX_VALUE board default; a non-finite one falls back to global', () => {
    const size = boardDefaultItemSize({ defaultWidth: Number.MAX_VALUE, defaultHeight: Infinity });
    expect(Number.isFinite(size.w)).toBe(true);
    expect(size.w).toBeLessThanOrEqual(1e7);
    expect(size.h).toBe(160); // Infinity → non-finite → global default
  });

  // cascade: an INHERITED board value is not used (own-key cascade); an own value still resolves.
  it('resolveAppearanceKey ignores an inherited board value, falls through to global', () => {
    const board = Object.create({ sizeMode: 'INHERITED' }) as Record<string, unknown>;
    expect(resolveAppearanceKey('sizeMode', undefined, board)).toBe('fit'); // GLOBAL, not the inherited value
    board.sizeMode = 'fill';
    expect(resolveAppearanceKey('sizeMode', undefined, board)).toBe('fill'); // own value wins
  });
});
