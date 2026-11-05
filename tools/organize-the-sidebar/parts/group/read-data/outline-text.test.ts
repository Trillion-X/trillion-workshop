// packages/group/read-data/outline-text.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { outlineOrdinals, parseOutline, serializeOutline } from '../../../read-data/outline-text.ts';
import { indentItem, type ListItem } from '../../../read-data/list-block-model.ts';

const at = (indents: readonly number[]): ListItem[] =>
  indents.map((indent, i) => ({ id: `r${i}`, text: `t${i}`, indent }));

describe('outline-text bridge', () => {
  it('parses leading 2-space units as nesting depth', () => {
    const items = parseOutline('Top\n  Child\n    Grand\nSecond');
    expect(items.map((i) => i.indent)).toEqual([0, 1, 2, 0]);
    expect(items.map((i) => i.text)).toEqual(['Top', 'Child', 'Grand', 'Second']);
  });

  it('treats a tab as one level', () => {
    expect(parseOutline('A\n\tB').map((i) => i.indent)).toEqual([0, 1]);
  });

  it('drops blank lines (an outline row must have content)', () => {
    expect(parseOutline('A\n\n  \nB').map((i) => i.text)).toEqual(['A', 'B']);
  });

  it('pins the first line to depth 0 and clamps over-deep jumps (well-formed)', () => {
    // a line indented 3 levels under a top line collapses to 1 (no skipping levels)
    expect(parseOutline('Top\n      Jump').map((i) => i.indent)).toEqual([0, 1]);
  });

  it('serialize∘parse is identity on well-formed indented text', () => {
    const text = 'Plan\n  Step one\n  Step two\n    Detail\nDone';
    expect(serializeOutline(parseOutline(text))).toBe(text);
  });

  it('a structural edit round-trips through text losslessly', () => {
    const items = parseOutline('A\nB\nC');
    const indented = indentItem(items, items[1].id); // B → depth 1
    expect(serializeOutline(indented)).toBe('A\n  B\nC');
    // and re-parsing the serialized text yields the same structure
    expect(parseOutline(serializeOutline(indented)).map((i) => i.indent)).toEqual([0, 1, 0]);
  });

  describe('outlineOrdinals — per-level numbering that restarts under each parent', () => {
    it('numbers siblings within their own level', () => {
      // top: 1st,2nd ; children under the first parent: 1st,2nd ; under the second parent: 1st
      expect(outlineOrdinals(at([0, 1, 1, 0, 1]))).toEqual([0, 0, 1, 1, 0]);
    });
    it('a deeper level restarts under every new parent', () => {
      expect(outlineOrdinals(at([0, 1, 2, 1, 0, 1]))).toEqual([0, 0, 0, 1, 1, 0]);
    });
    it('a flat list is just 0..n-1', () => {
      expect(outlineOrdinals(at([0, 0, 0]))).toEqual([0, 1, 2]);
    });
  });
});
