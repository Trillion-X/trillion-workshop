import { describe, it, expect } from 'vitest';
import { arrangementActions, arrangementThumbSvg } from './SavedArrangementGallery';
import type { SavedArrangement } from '../read-data/saved-arrangement';

const row = (over: Partial<SavedArrangement>): SavedArrangement => ({
  id: 'x',
  label: 'X',
  source: 'collection',
  archived: false,
  capabilities: { apply: true, rename: true, archive: true, duplicate: true },
  payload: { id: 'x', name: 'X', items: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100, text: 'a' }] },
  ...over,
});

describe('arrangementActions — capability DATA drives the action list (no source branching)', () => {
  it('a mutable collection offers Use + Compare + Duplicate + Rename + Archive', () => {
    expect(arrangementActions(row({})).map((a) => a.key)).toEqual(['apply', 'compare', 'duplicate', 'rename', 'archive']);
  });

  it('an immutable template offers Use + Compare + Duplicate', () => {
    const template = row({ source: 'template', capabilities: { apply: true, rename: false, archive: false, duplicate: true } });
    expect(arrangementActions(template).map((a) => a.key)).toEqual(['apply', 'compare', 'duplicate']);
  });

  it('compare is gated on apply (an unresolvable row offers no compare)', () => {
    const keys = arrangementActions(row({ capabilities: { apply: false, rename: true, archive: false, duplicate: false } })).map((a) => a.key);
    expect(keys).not.toContain('compare');
  });

  it('an archived row swaps Archive → Restore', () => {
    const keys = arrangementActions(row({ archived: true })).map((a) => a.key);
    expect(keys).toContain('restore');
    expect(keys).not.toContain('archive');
  });

  it('a capability-less row (all false) offers nothing', () => {
    expect(arrangementActions(row({ capabilities: { apply: false, rename: false, archive: false, duplicate: false } }))).toEqual([]);
  });
});

describe('arrangementThumbSvg — generated from the row payload (dogfoods boardToSvg)', () => {
  it('produces an <svg> string from the arrangement items', () => {
    const svg = arrangementThumbSvg(row({}));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });
});
