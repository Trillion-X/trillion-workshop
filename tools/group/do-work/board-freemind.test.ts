// packages/group/do-work/board-freemind.test.ts
//
// Proves b173's FreeMind format: the second dialect over the generic nested-XML primitive. A real `.mm` fixture
// parses; the export↔import round-trips; a real FreeMind document (from the tool) imports to cards + connectors.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { looksLikeFreemind, parseFreemind, freemindToBoardItems, boardToFreemind } from './board-freemind';

function note(memberId: string, text: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text, extra: {}, isSection: false } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to }, isSection: false } as unknown as BoardItem;
}

describe('looksLikeFreemind', () => {
  it('requires BOTH a <map> root and a <node TEXT=…> (conservative)', () => {
    expect(looksLikeFreemind('<map version="1.0.1"><node TEXT="Root"/></map>')).toBe(true);
    expect(looksLikeFreemind('<map></map>')).toBe(false);            // no node TEXT
    expect(looksLikeFreemind('<opml><outline text="x"/></opml>')).toBe(false); // OPML, not freemind
    expect(looksLikeFreemind('plain text')).toBe(false);
  });
});

describe('parseFreemind — a real .mm document', () => {
  it('decodes the nested <node TEXT> tree (as FreeMind/Freeplane writes it)', () => {
    const mm = `<map version="1.0.1">
      <node TEXT="Vision">
        <node TEXT="Q1"><node TEXT="Ship v1"/></node>
        <node TEXT="Q2"/>
      </node>
    </map>`;
    expect(parseFreemind(mm)).toEqual([
      { depth: 0, text: 'Vision' },
      { depth: 1, text: 'Q1' },
      { depth: 2, text: 'Ship v1' },
      { depth: 1, text: 'Q2' },
    ]);
  });
});

describe('ROUND-TRIP: boardToFreemind → parseFreemind', () => {
  it('a connector hierarchy round-trips to the same depth-tagged outline', () => {
    const board: BoardItem[] = [
      note('a', 'Launch'), note('b', 'Marketing'), note('c', 'Product'), note('d', 'Ads'),
      connector('e1', 'a', 'b'), connector('e2', 'a', 'c'), connector('e3', 'b', 'd'),
    ];
    const mm = boardToFreemind(board);
    expect(looksLikeFreemind(mm)).toBe(true);
    expect(parseFreemind(mm)).toEqual([
      { depth: 0, text: 'Launch' },
      { depth: 1, text: 'Marketing' },
      { depth: 2, text: 'Ads' },
      { depth: 1, text: 'Product' },
    ]);
  });

  it('XML-special characters survive the round-trip', () => {
    const board = [note('a', 'A & B <tag>'), note('b', 'child'), connector('e1', 'a', 'b')];
    expect(parseFreemind(boardToFreemind(board)).map((l) => l.text)).toEqual(['A & B <tag>', 'child']);
  });

  it('empty board → a valid empty <map>', () => {
    const mm = boardToFreemind([]);
    expect(mm).toContain('<map version="1.0.1">');
    expect(parseFreemind(mm)).toEqual([]);
  });
});

describe('freemindToBoardItems', () => {
  it('a card per node + a parent→child connector', () => {
    const mm = '<map><node TEXT="Root"><node TEXT="Child"/></node></map>';
    const items = freemindToBoardItems(mm, 40, 40);
    const cards = items.filter((i) => !i.extra?.fromMemberId);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(cards.map((c) => c.text)).toEqual(['Root', 'Child']);
    expect(cards[1].x).toBe(40 + 240); // child at depth 1
    expect(conns).toHaveLength(1);
    expect(conns[0].extra).toMatchObject({ fromMemberId: 'n0', toMemberId: 'n1' });
  });
});
