// packages/group/show/paste-to-notes.test.ts
//
// Pure proof of the bulk-create text→notes transform. No DOM, no engine — deterministic.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { textToNoteDrafts, MAX_PASTE_NOTES, MAX_PASTE_NOTE_LEN } from '../../../show/paste-to-notes.ts';

describe('textToNoteDrafts (paste → one sticky per line)', () => {
  it('splits a multi-line brain-dump into one note draft per line', () => {
    const drafts = textToNoteDrafts('buy milk\nwash car\ncall mom');
    expect(drafts).toEqual([
      { kind: 'note', text: 'buy milk' },
      { kind: 'note', text: 'wash car' },
      { kind: 'note', text: 'call mom' },
    ]);
  });

  it('a single line → exactly one note (paste-text-onto-canvas is canonical)', () => {
    expect(textToNoteDrafts('just one idea')).toEqual([{ kind: 'note', text: 'just one idea' }]);
  });

  it('trims each line and drops blank / whitespace-only lines (no empty cards)', () => {
    const drafts = textToNoteDrafts('  alpha  \n\n   \n\tbeta\n');
    expect(drafts).toEqual([
      { kind: 'note', text: 'alpha' },
      { kind: 'note', text: 'beta' },
    ]);
  });

  it('handles CRLF (Windows / pasted-from-Word) newlines identically to LF', () => {
    expect(textToNoteDrafts('one\r\ntwo\r\nthree')).toEqual([
      { kind: 'note', text: 'one' },
      { kind: 'note', text: 'two' },
      { kind: 'note', text: 'three' },
    ]);
  });

  it('empty / whitespace-only text → [] so the caller falls through to its next paste branch', () => {
    expect(textToNoteDrafts('')).toEqual([]);
    expect(textToNoteDrafts('   \n\t\n  ')).toEqual([]);
  });

  it('caps the note count at MAX_PASTE_NOTES (a whole-document paste never freezes the board)', () => {
    const many = Array.from({ length: MAX_PASTE_NOTES + 50 }, (_, i) => `line ${i}`).join('\n');
    const drafts = textToNoteDrafts(many);
    expect(drafts.length).toBe(MAX_PASTE_NOTES);
    expect(drafts[0]).toEqual({ kind: 'note', text: 'line 0' });
  });

  it('clamps a pathologically long single line to MAX_PASTE_NOTE_LEN', () => {
    const huge = 'x'.repeat(MAX_PASTE_NOTE_LEN + 500);
    const drafts = textToNoteDrafts(huge);
    expect(drafts.length).toBe(1);
    expect(drafts[0].text!.length).toBe(MAX_PASTE_NOTE_LEN);
  });

  it('every draft is kind:note (the caller/layout stays blind — no per-kind branch)', () => {
    const drafts = textToNoteDrafts('a\nb\nc');
    expect(drafts.every((d) => d.kind === 'note')).toBe(true);
  });
});
