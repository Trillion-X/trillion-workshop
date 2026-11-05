import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { itemBoardLink, boardLinkLabel } from '../../../show/item-board-link.ts';

describe('itemBoardLink', () => {
  it('reads a non-empty boardLink string', () => {
    expect(itemBoardLink({ extra: { boardLink: 'board-42' } })).toBe('board-42');
  });

  it('is undefined for an empty or whitespace boardLink', () => {
    expect(itemBoardLink({ extra: { boardLink: '' } })).toBeUndefined();
    expect(itemBoardLink({ extra: { boardLink: '   ' } })).toBeUndefined();
  });

  it('is undefined for a non-string boardLink', () => {
    expect(itemBoardLink({ extra: { boardLink: 7 as unknown as string } })).toBeUndefined();
    expect(itemBoardLink({ extra: { boardLink: null as unknown as string } })).toBeUndefined();
  });

  it('is undefined when extra or item is missing', () => {
    expect(itemBoardLink({ extra: {} })).toBeUndefined();
    expect(itemBoardLink({})).toBeUndefined();
    expect(itemBoardLink(undefined)).toBeUndefined();
  });

  it('ignores an unrelated href without a boardLink', () => {
    expect(itemBoardLink({ extra: { href: 'https://example.com' } })).toBeUndefined();
  });
});

describe('boardLinkLabel', () => {
  it('passes a short title through unchanged', () => {
    expect(boardLinkLabel('July 2, 2026')).toBe('July 2, 2026');
    expect(boardLinkLabel('Untitled board')).toBe('Untitled board');
  });

  it('truncates a long title with an ellipsis, capping the visible length', () => {
    const out = boardLinkLabel('July 2, 2026 — Morning brainstorm session');
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(22);
  });

  it('respects a custom max', () => {
    expect(boardLinkLabel('abcdefghij', 5)).toBe('abcd…');
  });

  it('passes a title exactly at the boundary through unchanged', () => {
    const exact = 'x'.repeat(22);
    expect(boardLinkLabel(exact)).toBe(exact);
  });

  it('trims trailing whitespace before the ellipsis (no "word …")', () => {
    // 21 chars then spaces — the slice would end in a space without the trim
    expect(boardLinkLabel('abcdefghijklmnopqrstu vwxyz', 22)).toBe('abcdefghijklmnopqrstu…');
  });

  it('returns empty for an empty or whitespace title', () => {
    expect(boardLinkLabel('')).toBe('');
    expect(boardLinkLabel('   ')).toBe('');
  });
});
