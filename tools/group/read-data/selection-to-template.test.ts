// Proof for selectionToTemplate: a selection normalizes into a BoardTemplate.

import { describe, expect, it } from 'vitest';
import { selectionToTemplate, boardSelectionToTemplate, mergeSelectionsToCollection } from './selection-to-template';

const ITEMS = [
  { memberId: 'a', kind: 'note', x: 100, y: 100, w: 200, h: 140, text: 'idea A' },
  { memberId: 'b', kind: 'note', x: 400, y: 100, w: 200, h: 140, text: 'idea B' },
  { memberId: 'c', kind: 'stamp', x: 100, y: 400, w: 120, h: 120, text: '\u{1F525}' },
];
const CONNECTORS = [{ memberId: 'x', fromId: 'a', toId: 'c', extra: { label: 'leads to' } }];

describe('selectionToTemplate', () => {
  it('a 3-item selection with an a->c connector (b unselected) -> 2 items + 1 connector, normalized', () => {
    const tpl = selectionToTemplate(ITEMS, CONNECTORS, ['a', 'c'], 'My Stack', 'stack-1');

    expect(tpl.id).toBe('stack-1');
    expect(tpl.name).toBe('My Stack');

    const itemTemplates = tpl.items.filter((i) => i.kind !== 'connector');
    const connectorTemplates = tpl.items.filter((i) => i.kind === 'connector');
    expect(itemTemplates).toHaveLength(2); // a + c kept, b dropped
    expect(connectorTemplates).toHaveLength(1); // a->c survives (both endpoints kept)

    // Kept in ITEMS order (a then c), ids are the source memberIds.
    expect(itemTemplates.map((i) => i.id)).toEqual(['a', 'c']);

    // Positions normalized so the top-left corner is (0,0).
    expect(Math.min(...itemTemplates.map((i) => i.x))).toBe(0);
    expect(Math.min(...itemTemplates.map((i) => i.y))).toBe(0);
    // a was (100,100) -> (0,0); c was (100,400) -> (0,300).
    const a = itemTemplates.find((i) => i.id === 'a')!;
    const c = itemTemplates.find((i) => i.id === 'c')!;
    expect({ x: a.x, y: a.y }).toEqual({ x: 0, y: 0 });
    expect({ x: c.x, y: c.y }).toEqual({ x: 0, y: 300 });
    expect(c.text).toBe('\u{1F525}');

    // Connector carries template-local ids from/to (the selected memberIds).
    const conn = connectorTemplates[0];
    expect(conn.from).toBe('a');
    expect(conn.to).toBe('c');
    expect(conn.extra).toEqual({ label: 'leads to' });
    expect({ x: conn.x, y: conn.y, w: conn.w, h: conn.h }).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('folds a present html into extra (TemplateItem has no html field, must not lose it)', () => {
    const items = [
      { memberId: 'n', kind: 'note', x: 0, y: 0, w: 100, h: 100, html: '<b>hi</b>', extra: { color: 'red' } },
    ];
    const tpl = selectionToTemplate(items, [], ['n'], 'html-stack');
    const t = tpl.items[0];
    expect(t.extra).toEqual({ color: 'red', html: '<b>hi</b>' });
    // and defaults id to name when id omitted
    expect(tpl.id).toBe('html-stack');
  });

  it('drops a connector whose endpoint is not selected', () => {
    const items = [
      { memberId: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100 },
      { memberId: 'b', kind: 'note', x: 200, y: 0, w: 100, h: 100 },
    ];
    const connectors = [{ memberId: 'x', fromId: 'b', toId: 'a' }];
    const tpl = selectionToTemplate(items, connectors, ['a'], 'Solo');
    expect(tpl.items.filter((i) => i.kind !== 'connector')).toHaveLength(1);
    expect(tpl.items.filter((i) => i.kind === 'connector')).toHaveLength(0); // b not kept
  });

  it('empty selection -> { id, name, items: [] }', () => {
    const tpl = selectionToTemplate(ITEMS, CONNECTORS, [], 'Empty');
    expect(tpl).toEqual({ id: 'Empty', name: 'Empty', items: [] });
  });
});

describe('boardSelectionToTemplate — the panel R5 wire (flat board list → collection template)', () => {
  // A flat board list AS `readItems` returns it: items AND connectors mixed. A connector is
  // an item carrying extra.fromMemberId+toMemberId (shape predicate, L090) — NOT a kind string.
  const BOARD = [
    { memberId: 'a', kind: 'note', x: 100, y: 100, w: 200, h: 140, text: 'A' },
    { memberId: 'b', kind: 'note', x: 400, y: 100, w: 200, h: 140, text: 'B' },
    { memberId: 'c', kind: 'note', x: 100, y: 400, w: 120, h: 120, text: 'C' },
    { memberId: 'e1', kind: 'note', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'c' } },
    { memberId: 'e2', kind: 'note', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } },
  ];

  it('partitions the mixed list and keeps ONLY the selection + connectors fully inside it', () => {
    // Select a + c. e1 (a->c) survives; e2 (a->b) is pruned because b is not selected.
    const tpl = boardSelectionToTemplate(BOARD, ['a', 'c'], 'My part', 'part-1');
    expect(tpl.id).toBe('part-1');
    const items = tpl.items.filter((i) => i.kind !== 'connector');
    const conns = tpl.items.filter((i) => i.kind === 'connector');
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'c']);
    expect(conns).toHaveLength(1);
    expect({ from: conns[0].from, to: conns[0].to }).toEqual({ from: 'a', to: 'c' });
    // Re-origined to (0,0).
    expect(Math.min(...items.map((i) => i.x))).toBe(0);
    expect(Math.min(...items.map((i) => i.y))).toBe(0);
  });

  it('a connector item is never saved AS a content item (partitioned out even if selected)', () => {
    // Even if the connector member id is in the selection, it must not appear as a content item.
    const tpl = boardSelectionToTemplate(BOARD, ['a', 'c', 'e1'], 'X');
    const contentIds = tpl.items.filter((i) => i.kind !== 'connector').map((i) => i.id);
    expect(contentIds).not.toContain('e1');
  });

  it('empty selection → empty collection template (never throws)', () => {
    expect(boardSelectionToTemplate(BOARD, [], 'Empty')).toEqual({ id: 'Empty', name: 'Empty', items: [] });
  });
});

describe('mergeSelectionsToCollection (R5 — pull selections from MANY boards into one collection)', () => {
  // Two boards that BOTH have a member id 'a' (the collision case) + a within-board connector.
  const boardA = [
    { memberId: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100, text: 'A-note' },
    { memberId: 'b', kind: 'note', x: 200, y: 0, w: 100, h: 100, text: 'A-note-2' },
    { memberId: 'e', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b', label: 'A-edge' } },
  ];
  const boardB = [
    { memberId: 'a', kind: 'note', x: 50, y: 50, w: 120, h: 80, text: 'B-note' }, // same id 'a' as boardA
  ];

  it('merges both boards, namespaces ids per source so a shared memberId never collides', () => {
    const tpl = mergeSelectionsToCollection(
      [{ allItems: boardA, selectedIds: ['a', 'b'] }, { allItems: boardB, selectedIds: ['a'] }],
      'My mashup',
      'mashup-1',
    );
    const ids = tpl.items.map((i) => i.id);
    expect(ids).toContain('s0:a'); // boardA's 'a'
    expect(ids).toContain('s0:b');
    expect(ids).toContain('s1:a'); // boardB's 'a' — distinct, no collision
    expect(new Set(ids).size).toBe(ids.length); // all ids unique
  });

  it("a within-board connector survives with BOTH endpoints under the same source prefix", () => {
    const tpl = mergeSelectionsToCollection([{ allItems: boardA, selectedIds: ['a', 'b'] }], 'C', 'c');
    const conn = tpl.items.find((i) => i.kind === 'connector')!;
    expect(conn.from).toBe('s0:a');
    expect(conn.to).toBe('s0:b');
  });

  it('the second board is stacked BELOW the first (no overlap)', () => {
    const tpl = mergeSelectionsToCollection(
      [{ allItems: boardA, selectedIds: ['a', 'b'] }, { allItems: boardB, selectedIds: ['a'] }],
      'C', 'c', { gap: 40 },
    );
    const s0a = tpl.items.find((i) => i.id === 's0:a')!;
    const s1a = tpl.items.find((i) => i.id === 's1:a')!;
    // boardA content is 100 tall at y=0; boardB's 'a' starts at 100 + gap 40 = 140.
    expect(s0a.y).toBe(0);
    expect(s1a.y).toBe(140);
  });

  it('strips the LIVE-board endpoint keys from a stored connector (self-consistent template)', () => {
    const tpl = mergeSelectionsToCollection([{ allItems: boardA, selectedIds: ['a', 'b'] }], 'C', 'c');
    const conn = tpl.items.find((i) => i.kind === 'connector')!;
    expect(conn.extra?.fromMemberId).toBeUndefined();
    expect(conn.extra?.toMemberId).toBeUndefined();
    expect(conn.extra?.label).toBe('A-edge'); // other extra preserved
  });

  it('skips boards with nothing selected; all-empty → an honest empty template', () => {
    const only = mergeSelectionsToCollection(
      [{ allItems: boardA, selectedIds: [] }, { allItems: boardB, selectedIds: ['a'] }],
      'C', 'c',
    );
    expect(only.items.map((i) => i.id)).toEqual(['s1:a']); // boardA contributed nothing
    expect(mergeSelectionsToCollection([{ allItems: boardA, selectedIds: [] }], 'Empty', 'empty'))
      .toEqual({ id: 'empty', name: 'Empty', items: [] });
  });

  it('sectionsByLabel wraps each labelled source in a titled section (provenance)', () => {
    const tpl = mergeSelectionsToCollection(
      [{ allItems: boardA, selectedIds: ['a', 'b'], label: 'From Roadmap' }, { allItems: boardB, selectedIds: ['a'], label: 'From Ideas' }],
      'C', 'c', { sectionsByLabel: true },
    );
    const sections = tpl.items.filter((i) => i.kind === 'section');
    expect(sections.map((s) => s.text)).toEqual(['From Roadmap', 'From Ideas']);
    // Each section holds its board's items as children (namespaced).
    const first = sections[0];
    expect(first.children!.map((c) => c.id).sort()).toEqual(['s0:a', 's0:b', 's0:e']);
  });

  it('empty picks array → empty template', () => {
    expect(mergeSelectionsToCollection([], 'Nada', 'nada')).toEqual({ id: 'nada', name: 'Nada', items: [] });
  });
});

describe('selection-to-template red-team — untrusted geometry + endpoint hardening (cont.98 batch-32)', () => {
  // #4: MAX_VALUE / NaN persisted coords yield a FINITE normalized template (NaN would otherwise poison
  // minX/minY so every `x - minX` is NaN; MAX_VALUE would propagate into template coords + section sizes).
  it('clamps MAX_VALUE / NaN item coords to finite template geometry', () => {
    const items = [
      { memberId: 'a', kind: 'note', x: Number.MAX_VALUE, y: Number.NaN, w: Number.MAX_VALUE, h: 50 },
      { memberId: 'b', kind: 'note', x: 10, y: 20, w: 100, h: 40 },
    ];
    const tpl = selectionToTemplate(items, [], ['a', 'b'], 'T');
    for (const it of tpl.items) {
      expect(Number.isFinite(it.x)).toBe(true);
      expect(Number.isFinite(it.y)).toBe(true);
      expect(Number.isFinite(it.w)).toBe(true);
      expect(it.w).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(it.h)).toBe(true);
    }
  });

  // #7: an INHERITED fromMemberId/toMemberId does NOT make a plain item look like a connector (own-key only),
  // so a real note isn't misclassified + dropped.
  it('boardSelectionToTemplate does not misclassify an item with inherited endpoints as a connector', () => {
    const plain = {
      memberId: 'p', kind: 'note', x: 0, y: 0, w: 100, h: 40,
      extra: Object.create({ fromMemberId: 'x', toMemberId: 'y' }) as Record<string, unknown>,
    };
    const tpl = boardSelectionToTemplate([plain], ['p'], 'T');
    expect(tpl.items).toHaveLength(1); // not dropped as a dangling connector
    expect(tpl.items[0].kind).toBe('note');
  });
});
