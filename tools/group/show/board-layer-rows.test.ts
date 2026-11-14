import { describe, expect, it } from 'vitest';
import { boardLayerTree } from './board-layer-rows';
import type { BoardItem } from '../read-data/group-board-model';

function item(partial: Partial<BoardItem> & { memberId: string }): BoardItem {
  return {
    memberId: partial.memberId,
    nodeRef: { family: 'group.board-item', parts: { item: partial.memberId } },
    kind: partial.kind ?? 'note',
    x: 0, y: 0, w: 100, h: 60,
    text: partial.text,
    src: partial.src,
    isSection: partial.isSection ?? false,
    childCount: partial.childCount ?? 0,
    extra: partial.extra ?? {},
  } as BoardItem;
}

const empty = new Set<string>();
const noKids = () => [];

describe('boardLayerTree (#151/#153 Objects panel model — flat behaviour)', () => {
  it('orders TOP-MOST z first (reverse of render order)', () => {
    const rows = boardLayerTree(
      [item({ memberId: 'a' }), item({ memberId: 'b' }), item({ memberId: 'c' })],
      noKids, empty, empty,
    );
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']); // c renders last = on top = first row
  });

  it('derives the label: text wins, else section/image/note fallback by data shape', () => {
    const rows = boardLayerTree(
      [
        item({ memberId: 'note', text: '  hello   world  ' }),
        item({ memberId: 'img', src: 'blob:x' }),
        item({ memberId: 'sec', isSection: true }),
        item({ memberId: 'bare' }),
      ],
      noKids, empty, empty,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.note.label).toBe('hello world'); // whitespace collapsed
    expect(byId.note.kind).toBe('note');
    expect(byId.img.label).toBe('Image');
    expect(byId.img.kind).toBe('image');
    expect(byId.sec.label).toBe('Section');
    expect(byId.sec.kind).toBe('section');
    expect(byId.bare.label).toBe('Note');
  });

  it('truncates a long label to 40 chars with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const [row] = boardLayerTree([item({ memberId: 'a', text: long })], noKids, empty, empty);
    expect(row.label.length).toBe(40);
    expect(row.label.endsWith('…')).toBe(true);
  });

  it('reads hidden/locked from item.extra and selected from the flat set', () => {
    const rows = boardLayerTree(
      [
        item({ memberId: 'a', extra: { locked: true } }),
        item({ memberId: 'b', extra: { hidden: true } }),
      ],
      noKids, new Set(['a']), empty,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.a.selected).toBe(true);
    expect(byId.a.locked).toBe(true);
    expect(byId.a.hidden).toBe(false);
    expect(byId.b.hidden).toBe(true);
    expect(byId.b.selected).toBe(false);
  });
});

describe('boardLayerTree (#153 nesting)', () => {
  // A section `sec` containing two children x,y (render order x then y → y on top).
  const sec = item({ memberId: 'sec', isSection: true });
  const kids = [item({ memberId: 'x' }), item({ memberId: 'y' })];
  const childrenOf = (it: BoardItem) => (it.memberId === 'sec' ? kids : []);

  it('populates a section node\'s children TOP-FIRST (reverse of render order)', () => {
    const [node] = boardLayerTree([sec], childrenOf, empty, empty);
    expect(node.id).toBe('sec');
    expect(node.children.map((c) => c.id)).toEqual(['y', 'x']); // y renders last = on top = first child
  });

  it('populates children regardless of expand state (collapse is a render concern)', () => {
    const collapsed = boardLayerTree([sec], childrenOf, empty, empty)[0];
    const expanded = boardLayerTree([sec], childrenOf, empty, new Set(['sec']))[0];
    expect(collapsed.expanded).toBe(false);
    expect(expanded.expanded).toBe(true);
    // children are ALWAYS present so the panel knows to show a chevron either way
    expect(collapsed.children).toHaveLength(2);
    expect(expanded.children).toHaveLength(2);
  });

  it('recurses arbitrarily deep (section inside a section)', () => {
    const inner = item({ memberId: 'inner', isSection: true });
    const outer = item({ memberId: 'outer', isSection: true });
    const leaf = item({ memberId: 'leaf' });
    const deepChildren = (it: BoardItem) =>
      it.memberId === 'outer' ? [inner] : it.memberId === 'inner' ? [leaf] : [];
    const [node] = boardLayerTree([outer], deepChildren, empty, empty);
    expect(node.id).toBe('outer');
    expect(node.children[0].id).toBe('inner');
    expect(node.children[0].children[0].id).toBe('leaf');
    expect(node.children[0].children[0].children).toHaveLength(0); // leaf is a note → no children
  });
});
