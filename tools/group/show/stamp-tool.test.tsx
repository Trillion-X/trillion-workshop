// packages/group/show/stamp-tool.test.tsx
//
// #204: proof that the emoji-stamp tool is DATA-driven end to end — the STAMP_VARIANTS
// glyph family is well-formed, and the blind StampItem renderer draws the glyph carried
// in the item's `text` (jsdom + @testing-library/react), with a safe fallback. Storing
// the glyph in `text` (not a stamp-specific extra) is what makes the blind board-svg
// exporter render stamps for free.

import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { rendererForKind, STAMP_VARIANTS, ITEM_SHELF } from './item-renderers';
import { BOARD_STAMPS } from './board-stamps';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

describe('#204 STAMP_VARIANTS — BOARD_STAMPS as placeable glyph presets', () => {
  it('mirrors the BOARD_STAMPS catalog id-for-id, seeding the emoji into item text', () => {
    expect(STAMP_VARIANTS.map((v) => v.id)).toEqual(BOARD_STAMPS.map((s) => s.id));
    for (const v of STAMP_VARIANTS) {
      const stamp = BOARD_STAMPS.find((s) => s.id === v.id)!;
      expect(v.emoji).toBe(stamp.emoji); // the flyout visual is the glyph
      expect(v.defaultText).toBe(stamp.emoji); // the STORED value (item.text) is the glyph — export-blind
      expect(v.defaultExtra).toEqual({}); // no stamp-specific extra; text is the single source
    }
  });

  it('the Stamp shelf entry is a stamp-kind tool defaulting to 🔥 with the glyph flyout', () => {
    const stampTool = ITEM_SHELF.find((t) => t.label === 'Stamp');
    expect(stampTool).toBeDefined();
    expect(stampTool!.kind).toBe('stamp');
    expect(stampTool!.defaultText).toBe('🔥'); // main button drops fire
    // variants are now built per-catalog (buildItemShelf) — the contract is VALUE equality
    // with the stamp glyph presets, not reference identity of a shared const.
    expect(stampTool!.variants).toEqual(STAMP_VARIANTS);
  });
});

describe('#204 StampItem renderer — blind glyph draw from item.text', () => {
  const mkStamp = (text?: string): BoardItem =>
    ({ kind: 'stamp', memberId: 'm1', x: 0, y: 0, w: 80, h: 80, text } as unknown as BoardItem);

  it('renders the emoji carried in item.text', () => {
    const Stamp = rendererForKind('stamp');
    const { getByText } = render(<Stamp item={mkStamp('⭐')} selected={false} />);
    getByText('⭐');
  });

  it('renders a DIFFERENT glyph as itself (data-driven, not hardcoded)', () => {
    const Stamp = rendererForKind('stamp');
    const { getByText } = render(<Stamp item={mkStamp('💡')} selected={false} />);
    getByText('💡');
  });

  it('falls back to the catalog default glyph for empty/absent text (never invisible)', () => {
    const Stamp = rendererForKind('stamp');
    const { getByText: g1 } = render(<Stamp item={mkStamp(undefined)} selected={false} />);
    g1('🔥');
    cleanup();
    const { getByText: g2 } = render(<Stamp item={mkStamp('')} selected={false} />);
    g2('🔥');
  });
});
