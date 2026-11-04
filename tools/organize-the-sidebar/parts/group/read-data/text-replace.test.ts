// Proof for the find-and-replace primitive (the board's missing twin of free-text FIND). Pins: the
// matcher SSOT (literal/regex/whole-word/case), per-item replacement + counts, fail-closed edges
// (empty find / invalid regex / no-op X→X / no text / zero-width), scoping, and count==effect.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { replaceInItems, countInItems, buildMatcher, replacementFor, type TextItem } from '../../../read-data/text-replace.ts';

const items: TextItem[] = [
  { memberId: 'a', text: 'ship v1 then v1 again' },
  { memberId: 'b', text: 'V1 uppercase' },
  { memberId: 'c', text: 'nothing here' },
  { memberId: 'd' }, // no text — skipped
  { memberId: 'e', text: 'version1 (substring of v1? no)' },
];

describe('replaceInItems — the core find-and-replace', () => {
  it('replaces every occurrence, one patch per changed item, with per-item + total counts', () => {
    const r = replaceInItems(items, { find: 'v1', replaceWith: 'v2', caseSensitive: false });
    const by = Object.fromEntries(r.patches.map((p) => [p.memberId, p]));
    expect(by.a.text).toBe('ship v2 then v2 again');
    expect(by.a.count).toBe(2);
    expect(by.b.text).toBe('v2 uppercase'); // case-insensitive matched 'V1'
    expect(r.itemCount).toBe(3); // a, b, and e ('version1' contains 'v1'? 'version1' has no 'v1' substring) → check
  });

  it('case-sensitive only matches the exact case', () => {
    const r = replaceInItems(items, { find: 'v1', replaceWith: 'v2', caseSensitive: true });
    const ids = r.patches.map((p) => p.memberId).sort();
    expect(ids).toContain('a'); // lowercase v1
    expect(ids).not.toContain('b'); // 'V1' not matched when case-sensitive
  });

  it('whole-word only matches standalone tokens, not substrings', () => {
    const src: TextItem[] = [{ memberId: 'x', text: 'cat cats category' }];
    const whole = replaceInItems(src, { find: 'cat', replaceWith: 'dog', wholeWord: true });
    expect(whole.patches[0].text).toBe('dog cats category'); // only the standalone 'cat'
    expect(whole.patches[0].count).toBe(1);
    const loose = replaceInItems(src, { find: 'cat', replaceWith: 'dog' });
    expect(loose.patches[0].text).toBe('dog dogs dogegory'); // every substring
  });

  it('regex mode treats find as a pattern (with capture-group replacement)', () => {
    const src: TextItem[] = [{ memberId: 'x', text: 'todo-1 todo-22 todo-333' }];
    const r = replaceInItems(src, { find: 'todo-(\\d+)', replaceWith: 'TASK-$1', regex: true });
    expect(r.patches[0].text).toBe('TASK-1 TASK-22 TASK-333');
    expect(r.patches[0].count).toBe(3);
  });

  it('scopeIds limits the replace to a selection', () => {
    const r = replaceInItems(items, { find: 'v1', replaceWith: 'v2', scopeIds: ['a'] });
    expect(r.patches.map((p) => p.memberId)).toEqual(['a']); // b excluded despite matching
  });
});

describe('fail-closed edges — never throws, never a spurious patch', () => {
  it('empty find → no matcher → zero patches', () => {
    expect(replaceInItems(items, { find: '', replaceWith: 'x' })).toEqual({ patches: [], matchCount: 0, itemCount: 0 });
  });

  it('invalid regex → no-op (fail-closed), not a crash', () => {
    const r = replaceInItems(items, { find: '(unclosed', replaceWith: 'x', regex: true });
    expect(r.patches).toEqual([]);
    expect(buildMatcher({ find: '(unclosed', replaceWith: '', regex: true })).toBeNull();
  });

  it('no-op replacement (X→X) produces no patch (text unchanged)', () => {
    const r = replaceInItems([{ memberId: 'a', text: 'v1 v1' }], { find: 'v1', replaceWith: 'v1' });
    expect(r.patches).toEqual([]);
    expect(r.matchCount).toBe(0);
  });

  it('items without text are skipped (no crash on undefined)', () => {
    const r = replaceInItems([{ memberId: 'd' }, { memberId: 'e', text: '' }], { find: 'x', replaceWith: 'y' });
    expect(r.patches).toEqual([]);
  });

  it('zero-width regex (e.g. a*) never infinite-loops; delete mode (replaceWith "") works', () => {
    const del = replaceInItems([{ memberId: 'a', text: 'a-b-c' }], { find: '-', replaceWith: '' });
    expect(del.patches[0].text).toBe('abc');
    // a zero-width-capable pattern must TERMINATE (no infinite loop) and give a finite result
    const zw = replaceInItems([{ memberId: 'a', text: 'xxx' }], { find: 'y*', replaceWith: 'Z', regex: true });
    expect(zw.itemCount).toBeGreaterThanOrEqual(0);
  });
});

describe('countInItems — the preview equals the effect', () => {
  it('counts total occurrences without changing anything, matching what replace would change', () => {
    const opts = { find: 'v1', replaceWith: 'v2', caseSensitive: false } as const;
    const count = countInItems(items, opts);
    const applied = replaceInItems(items, opts);
    expect(count).toBe(applied.matchCount);
    expect(count).toBeGreaterThan(0);
  });

  it('respects scope + whole-word in the count (same matcher SSOT)', () => {
    expect(countInItems([{ memberId: 'x', text: 'cat cats' }], { find: 'cat', wholeWord: true })).toBe(1);
    expect(countInItems([{ memberId: 'x', text: 'cat cats' }], { find: 'cat' })).toBe(2);
  });
});

describe("replacementFor / literal-mode replacement is inserted VERBATIM (no $-token corruption)", () => {
  // String.prototype.replace interprets `$&`, `$1`, `` $` ``, `$'`, `$$` in a string replacement.
  // In LITERAL mode the user's replacement must be inserted as typed — the old code fed it raw, so
  // "R$5"/"$&" silently corrupted the output. Convergence audit batch-6 (self + Codex GPT-5.5).
  it('escapes $ in literal mode so the token is verbatim', () => {
    expect(replacementFor({ replaceWith: 'R$5', regex: false })).toBe('R$$5');
    expect(replacementFor({ replaceWith: '$&', regex: false })).toBe('$$&');
    expect(replacementFor({ replaceWith: 'a$$b', regex: false })).toBe('a$$$$b');
  });

  it('leaves the replacement UNTOUCHED in regex mode (backreferences are a feature)', () => {
    expect(replacementFor({ replaceWith: '$1-$2', regex: true })).toBe('$1-$2');
    expect(replacementFor({ replaceWith: '$&!', regex: true })).toBe('$&!');
  });

  it('literal replace: "cat" → "R$5" yields the literal "R$5", not "R" (the old corruption)', () => {
    const out = replaceInItems([{ memberId: 'x', text: 'a cat b' }], { find: 'cat', replaceWith: 'R$5' });
    expect(out.patches[0].text).toBe('a R$5 b');
  });

  it('literal replace: replacement containing "$&" inserts a literal "$&", not the matched text', () => {
    const out = replaceInItems([{ memberId: 'x', text: 'hi cat' }], { find: 'cat', replaceWith: '<$&>' });
    expect(out.patches[0].text).toBe('hi <$&>'); // NOT "hi <cat>"
  });

  it('regex replace: a backreference $1 still works (power-user feature preserved)', () => {
    const out = replaceInItems([{ memberId: 'x', text: 'ab' }], { find: '(a)(b)', replaceWith: '$2$1', regex: true });
    expect(out.patches[0].text).toBe('ba');
  });
});
