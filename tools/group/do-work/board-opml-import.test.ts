// packages/group/do-work/board-opml-import.test.ts
//
// Proves b172 — OPML import — three ways: (1) the ROUND-TRIP against the b155 export (boardToOpml → parseOpml
// recovers the same depth-tagged outline); (2) parser edge cases (nesting, self-closing leaves, title fallback,
// XML-entity un-escape, malformed tolerated); (3) opmlToBoardItems shapes cards + parent→child connectors.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { parseOpml, looksLikeOpml, opmlToBoardItems } from './board-opml-import';
import { boardToOpml } from './board-opml';

function note(memberId: string, text: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text, extra: {}, isSection: false } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to }, isSection: false } as unknown as BoardItem;
}

describe('looksLikeOpml', () => {
  it('recognizes an opml root, rejects other formats', () => {
    expect(looksLikeOpml('<?xml version="1.0"?><opml version="2.0">')).toBe(true);
    expect(looksLikeOpml('<graphml><node/></graphml>')).toBe(false);
    expect(looksLikeOpml('flowchart TD')).toBe(false);
    expect(looksLikeOpml(undefined as unknown as string)).toBe(false);
  });
});

describe('parseOpml — nesting decoder', () => {
  it('decodes nesting depth from open/close/self-closing outlines', () => {
    const opml = `<opml><body>
      <outline text="Root">
        <outline text="Child A"/>
        <outline text="Child B">
          <outline text="Grandchild"/>
        </outline>
      </outline>
    </body></opml>`;
    expect(parseOpml(opml)).toEqual([
      { depth: 0, text: 'Root' },
      { depth: 1, text: 'Child A' },
      { depth: 1, text: 'Child B' },
      { depth: 2, text: 'Grandchild' },
    ]);
  });

  it('falls back to the `title` attribute, un-escapes the five XML entities', () => {
    const opml = `<opml><body><outline title="A &amp; B &lt;x&gt; &quot;q&quot; &apos;p&apos;"/></body></opml>`;
    expect(parseOpml(opml)).toEqual([{ depth: 0, text: `A & B <x> "q" 'p'` }]);
  });

  it('ignores the head/title wrapper and tolerates empty/malformed, never throws', () => {
    expect(parseOpml('<opml><head><title>Ignored</title></head><body></body></opml>')).toEqual([]);
    expect(parseOpml('')).toEqual([]);
    // an extra </outline> must not drive depth negative
    expect(parseOpml('<opml></outline><outline text="ok"/></opml>')).toEqual([{ depth: 0, text: 'ok' }]);
  });
});

describe('ROUND-TRIP: boardToOpml → parseOpml recovers the outline', () => {
  it('a connector hierarchy round-trips to the same depth-tagged lines', () => {
    // Launch → Marketing, Product; Marketing → Ads. mindMapOutline orders the tree.
    const board: BoardItem[] = [
      note('launch', 'Launch'), note('mkt', 'Marketing'), note('prod', 'Product'), note('ads', 'Ads'),
      connector('e1', 'launch', 'mkt'), connector('e2', 'launch', 'prod'), connector('e3', 'mkt', 'ads'),
    ];
    const opml = boardToOpml(board, 'My Plan');
    expect(looksLikeOpml(opml)).toBe(true);
    const lines = parseOpml(opml);
    // the title is NOT a card (it's <title>, not <outline>)
    expect(lines.some((l) => l.text === 'My Plan')).toBe(false);
    // the hierarchy: Launch(0) → Marketing(1) → Ads(2), Product(1)
    expect(lines).toEqual([
      { depth: 0, text: 'Launch' },
      { depth: 1, text: 'Marketing' },
      { depth: 2, text: 'Ads' },
      { depth: 1, text: 'Product' },
    ]);
  });

  it('a card text with XML-special chars survives the export→import round-trip', () => {
    const board = [note('a', 'A & B <tag>'), note('b', 'child'), connector('e1', 'a', 'b')];
    const lines = parseOpml(boardToOpml(board));
    expect(lines.map((l) => l.text)).toEqual(['A & B <tag>', 'child']);
  });
});

describe('opmlToBoardItems — board builder', () => {
  const opml = `<opml><body>
    <outline text="Root"><outline text="Child"/></outline>
  </body></opml>`;

  it('a card per outline (left→right by depth) + a parent→child connector', () => {
    const items = opmlToBoardItems(opml, 40, 40);
    const cards = items.filter((i) => !i.extra?.fromMemberId);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(cards.map((c) => c.text)).toEqual(['Root', 'Child']);
    expect(cards[0].x).toBe(40);           // root depth 0
    expect(cards[1].x).toBe(40 + 240);     // child depth 1 (COL_GAP)
    expect(conns).toHaveLength(1);
    expect(conns[0].extra).toMatchObject({ fromMemberId: 'n0', toMemberId: 'n1' }); // parent n0 → child n1
  });

  it('empty / outline-less OPML → no items', () => {
    expect(opmlToBoardItems('<opml><body></body></opml>')).toEqual([]);
    expect(opmlToBoardItems('')).toEqual([]);
  });
});
