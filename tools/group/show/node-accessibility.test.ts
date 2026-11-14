// packages/group/show/node-accessibility.test.ts
//
// Proof of the board's screen-reader accessible-name leaf: kind noun + content, link title/domain,
// selection state, elision, and blindness to unknown kinds (a new kind gets a Title-cased name with
// ZERO change here — the kind→noun mapping is the shared kindFamilyOf SSOT).

import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { nodeAriaLabel, nodeKindNoun } from './node-accessibility';

const make = (kind: string, text?: string, extra?: Record<string, unknown>, src?: string): BoardItem =>
  ({ memberId: 'm', kind, x: 0, y: 0, w: 10, h: 10, isSection: kind === 'section', childCount: 0, text, src, extra } as unknown as BoardItem);

describe('nodeAriaLabel', () => {
  it('a note announces "Note: <text>"', () => {
    expect(nodeAriaLabel(make('note', 'buy milk'))).toBe('Note: buy milk');
  });

  it('an empty note announces just the noun ("Note")', () => {
    expect(nodeAriaLabel(make('note', '   '))).toBe('Note');
    expect(nodeAriaLabel(make('note'))).toBe('Note');
  });

  it('a section announces "Group: <text>" (kindFamilyOf returns empty → the fallback noun)', () => {
    expect(nodeAriaLabel(make('section', 'Q3 goals'))).toBe('Group: Q3 goals');
    expect(nodeAriaLabel(make('section'))).toBe('Group');
  });

  it('an image announces "Image" (no text needed)', () => {
    expect(nodeAriaLabel(make('image'))).toBe('Image');
    expect(nodeAriaLabel(make('media'))).toBe('Image'); // media family = Image
  });

  it('a link prefers its enriched title, else its domain, else "Link"', () => {
    expect(nodeAriaLabel(make('link', '', { linkPreview: { title: 'Example Site' } }, 'https://example.com/x'))).toBe('Link: Example Site');
    expect(nodeAriaLabel(make('link', '', undefined, 'https://example.com/path'))).toBe('Link: example.com');
    expect(nodeAriaLabel(make('link'))).toBe('Link');
  });

  it('appends ", selected" when selected (state in the name — honest, no false widget semantics)', () => {
    expect(nodeAriaLabel(make('note', 'idea'), { selected: true })).toBe('Note: idea, selected');
    expect(nodeAriaLabel(make('note', 'idea'), { selected: false })).toBe('Note: idea');
  });

  it('strips markup + collapses whitespace so the name is clean text', () => {
    expect(nodeAriaLabel(make('note', '<b>hi</b>   there'))).toBe('Note: hi there');
  });

  it('elides very long text to keep the announced name scannable', () => {
    const long = 'x'.repeat(200);
    const label = nodeAriaLabel(make('note', long));
    expect(label.startsWith('Note: ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(90);
  });

  it('an UNKNOWN kind gets a Title-cased name, zero code change (blind — kindFamilyOf SSOT)', () => {
    expect(nodeKindNoun(make('widget', 'x'))).toBe('Widget');
    expect(nodeAriaLabel(make('widget', 'gears'))).toBe('Widget: gears');
  });

  it('red-team (cont.98 batch-39): a prototype-key kind never leaks an inherited noun (Object.prototype/constructor)', () => {
    // A plain KIND_NOUN_FALLBACK[kind] would return Object.prototype / the Object constructor here.
    for (const bad of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      const noun = nodeKindNoun(make(bad, 'x'));
      expect(typeof noun).toBe('string');
      expect(noun).toBe(bad.charAt(0).toUpperCase() + bad.slice(1)); // Title-cased fallback, not inherited garbage
    }
  });
});
