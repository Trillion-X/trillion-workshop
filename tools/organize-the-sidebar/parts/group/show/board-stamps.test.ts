// packages/group/show/board-stamps.test.ts
//
// Pure proof of the stamp DATA catalog + resolver. No DOM, no engine.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { BOARD_STAMPS, stampEmojiById } from '../../../show/board-stamps.ts';

describe('BOARD_STAMPS catalog', () => {
  it('every stamp has a stable id, a label, and a non-empty emoji', () => {
    for (const s of BOARD_STAMPS) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.emoji.length).toBeGreaterThan(0);
    }
  });

  it('ids are unique (so a variant/id maps to exactly one stamp)', () => {
    const ids = BOARD_STAMPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fire is first (the Stamp tool main-button default)', () => {
    expect(BOARD_STAMPS[0].id).toBe('fire');
    expect(BOARD_STAMPS[0].emoji).toBe('🔥');
  });
});

describe('stampEmojiById', () => {
  it('resolves a known id to its emoji', () => {
    expect(stampEmojiById('star')).toBe('⭐');
    expect(stampEmojiById('check')).toBe('✅');
  });

  it('falls back to the first stamp emoji for unknown / undefined id (never empty)', () => {
    expect(stampEmojiById(undefined)).toBe('🔥');
    expect(stampEmojiById('does-not-exist')).toBe('🔥');
  });
});
