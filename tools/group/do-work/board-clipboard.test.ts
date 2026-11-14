// packages/group/do-work/board-clipboard.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  copyItemsToClipboard,
  capsuleBoardToClipboard,
  clipboardToDrafts,
  planPaste,
  setBoardClipboard,
  getBoardClipboard,
  clipboardItemCount,
  setStyleClipboard,
  getStyleClipboard,
  hasStyleClipboard,
} from './board-clipboard';
import type { BoardItem } from '../read-data/group-board-model';
import type { VisualLayerStackRecord } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

function item(p: Partial<BoardItem> & { memberId: string; x: number; y: number }): BoardItem {
  return {
    memberId: p.memberId,
    nodeRef: { family: 'test.item', parts: { id: p.memberId } },
    kind: p.kind ?? 'note',
    x: p.x,
    y: p.y,
    w: p.w ?? 100,
    h: p.h ?? 60,
    text: p.text,
    src: p.src,
    isSection: false,
    childCount: 0,
    extra: p.extra ?? {},
  } as BoardItem;
}

describe('copyItemsToClipboard', () => {
  it('returns null for an empty selection', () => {
    expect(copyItemsToClipboard([])).toBeNull();
  });

  it('normalizes positions to a (0,0) top-left anchor, preserving relative layout', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 200, y: 100 }),
      item({ memberId: 'b', x: 260, y: 180 }),
    ])!;
    expect(clip.kind).toBe('board-item-clipboard');
    const [a, b] = clip.items;
    expect([a.dx, a.dy]).toEqual([0, 0]); // top-left anchor
    expect([b.dx, b.dy]).toEqual([60, 80]); // relative offset preserved
  });

  it('strips geometry from extra (so a paste origin owns position), keeps the rest', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 10, y: 10, extra: { x: 10, y: 10, w: 100, h: 60, locked: true, html: '<b>hi</b>' } }),
    ])!;
    const e = clip.items[0].extra!;
    expect('x' in e).toBe(false);
    expect('y' in e).toBe(false);
    expect('w' in e).toBe(false);
    expect('h' in e).toBe(false);
    expect(e.locked).toBe(true);
    expect(e.html).toBe('<b>hi</b>');
  });

  it('captures kind/text/src/w/h', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 0, y: 0, kind: 'image', src: 'cas:abc', w: 240, h: 160, text: 'cap' }),
    ])!;
    const it = clip.items[0];
    expect([it.kind, it.src, it.w, it.h, it.text]).toEqual(['image', 'cas:abc', 240, 160, 'cap']);
  });
});

describe('clipboardToDrafts', () => {
  it('anchors drafts at the paste origin, preserving relative layout', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 200, y: 100 }),
      item({ memberId: 'b', x: 260, y: 180 }),
    ])!;
    const drafts = clipboardToDrafts(clip, 500, 500);
    expect([drafts[0].x, drafts[0].y]).toEqual([500, 500]);
    expect([drafts[1].x, drafts[1].y]).toEqual([560, 580]); // +60,+80 offset preserved
  });

  it('a draft carries no geometry in extra (new position survives placeItem spread)', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 9, y: 9, extra: { x: 9, y: 9, locked: false } }),
    ])!;
    const [d] = clipboardToDrafts(clip, 1000, 1000);
    expect(d.x).toBe(1000);
    expect((d.extra ?? {}).x).toBeUndefined(); // would otherwise clobber d.x via spread
  });
});

const connector = (memberId: string, from: string, to: string): BoardItem =>
  item({ memberId, x: 0, y: 0, w: 0, h: 0, kind: 'connector', extra: { fromMemberId: from, toMemberId: to } });

describe('copyItemsToClipboard — internal connectors (#187)', () => {
  it('carries an internal connector as bundle-local endpoint ids, stripped from extra', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 0, y: 0 }),
      item({ memberId: 'b', x: 100, y: 0 }),
      connector('c', 'a', 'b'),
    ])!;
    expect(clip.items).toHaveLength(3);
    const conn = clip.items.find((i) => i.fromLocalId)!;
    expect([conn.fromLocalId, conn.toLocalId]).toEqual(['a', 'b']);
    // Raw endpoint ids must NOT leak in extra — they are stale the moment the item clones.
    expect(conn.extra?.fromMemberId).toBeUndefined();
    expect(conn.extra?.toMemberId).toBeUndefined();
    // Every item carries its bundle-local id.
    expect(clip.items.map((i) => i.localId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('drops a connector whose other endpoint is NOT in the copied set (would dangle)', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 0, y: 0 }),
      connector('c', 'a', 'z'), // z is not copied
    ])!;
    expect(clip.items).toHaveLength(1);
    expect(clip.items[0].localId).toBe('a');
  });
});

describe('planPaste — remap internal connectors to the fresh clones (#187)', () => {
  const counter = () => {
    let n = 0;
    return () => `new${++n}`;
  };

  it('re-anchors a duplicated connector to the NEW node ids (nodes first, connector last)', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: 0, y: 0 }),
      item({ memberId: 'b', x: 100, y: 0 }),
      connector('c', 'a', 'b'),
    ])!;
    const drafts = clipboardToDrafts(clip, 500, 500);
    const placed = planPaste(drafts, counter());
    const nodes = placed.filter((p) => !p.isConnector);
    const conns = placed.filter((p) => p.isConnector);
    expect(nodes).toHaveLength(2);
    expect(conns).toHaveLength(1);
    // The pasted connector points at the two NEW node ids — never the originals a/b.
    const [na, nb] = nodes.map((n) => n.memberId);
    expect(conns[0].extra?.fromMemberId).toBe(na);
    expect(conns[0].extra?.toMemberId).toBe(nb);
    expect([conns[0].extra?.fromMemberId, conns[0].extra?.toMemberId]).not.toContain('a');
    // Connectors sort after nodes so they render above the joined nodes.
    expect(placed[placed.length - 1].isConnector).toBe(true);
  });

  it('assigns a fresh id to every node draft', () => {
    const clip = copyItemsToClipboard([item({ memberId: 'a', x: 0, y: 0 }), item({ memberId: 'b', x: 9, y: 9 })])!;
    const placed = planPaste(clipboardToDrafts(clip, 0, 0), counter());
    expect(placed.map((p) => p.memberId)).toEqual(['new1', 'new2']);
  });

  it('a node placement carries its source localId (so a caller can find the clone — #190 anchor)', () => {
    const clip = copyItemsToClipboard([item({ memberId: 'orig', x: 0, y: 0 })])!;
    const [p] = planPaste(clipboardToDrafts(clip, 0, 0), counter());
    expect(p.localId).toBe('orig');
    expect(p.memberId).toBe('new1'); // the clone id differs from the source localId
  });

  it('drops a connector draft whose endpoint local id was not among the pasted nodes', () => {
    const orphan = { kind: 'connector', x: 0, y: 0, w: 0, h: 0, fromLocalId: 'a', toLocalId: 'ghost' };
    const placed = planPaste([{ kind: 'note', x: 0, y: 0, w: 10, h: 10, localId: 'a' }, orphan], counter());
    expect(placed).toHaveLength(1); // the node survives, the dangling connector is dropped
    expect(placed[0].isConnector).toBe(false);
  });
});

describe('live clipboard store (cross-board singleton)', () => {
  beforeEach(() => setBoardClipboard(null));
  it('round-trips a bundle and reports its count', () => {
    expect(getBoardClipboard()).toBeNull();
    expect(clipboardItemCount()).toBe(0);
    const clip = copyItemsToClipboard([item({ memberId: 'a', x: 0, y: 0 }), item({ memberId: 'b', x: 5, y: 5 })])!;
    setBoardClipboard(clip);
    expect(getBoardClipboard()).toBe(clip);
    expect(clipboardItemCount()).toBe(2);
  });
});

describe('style clipboard (cross-board appearance singleton)', () => {
  beforeEach(() => setStyleClipboard(null));
  const stack = (id: string): VisualLayerStackRecord => ({
    kind: 'visual-layer-stack',
    version: 1,
    region: { family: 'test.board', parts: { id } },
    layers: [],
  });

  it('starts empty', () => {
    expect(getStyleClipboard()).toBeNull();
    expect(hasStyleClipboard()).toBe(false);
  });

  it('round-trips the exact copied bundle and reports presence', () => {
    const s = stack('a');
    setStyleClipboard(s);
    expect(getStyleClipboard()).toBe(s); // same reference — stamp reads it verbatim
    expect(hasStyleClipboard()).toBe(true);
  });

  it('clears on null', () => {
    setStyleClipboard(stack('a'));
    setStyleClipboard(null);
    expect(getStyleClipboard()).toBeNull();
    expect(hasStyleClipboard()).toBe(false);
  });

  it('is independent of the item clipboard', () => {
    setStyleClipboard(stack('a'));
    setBoardClipboard(null);
    expect(hasStyleClipboard()).toBe(true); // item-clipboard clear doesn't touch style
  });
});

describe('capsuleBoardToClipboard — hardened against a hostile capsule (cont.98 batch-8)', () => {
  it('a __proto__ key in an item extra does not pollute a prototype and is dropped', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"locked":true,"html":"hi"}');
    const board = { boardId: 'b', title: 't', items: [{ memberId: 'm', kind: 'note', x: 0, y: 0, w: 10, h: 10, extra: evil }] };
    const clip = capsuleBoardToClipboard(board as never);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global prototype pollution
    const carried = clip.items[0].extra as Record<string, unknown> | undefined;
    expect(carried?.locked).toBe(true); // safe keys survive
    expect(carried?.html).toBe('hi');
    expect(Object.getPrototypeOf(carried ?? {})).toBe(Object.prototype); // the carried object is clean
    expect((carried as Record<string, unknown>)?.polluted).toBeUndefined();
  });

  it('non-finite (NaN) coordinates in a capsule become finite paste drafts (never NaN)', () => {
    const board = {
      boardId: 'b', title: 't', items: [
        { memberId: 'a', kind: 'note', x: NaN, y: 0, w: 10, h: 10 },
        { memberId: 'b', kind: 'note', x: 5, y: 5, w: NaN, h: 10 },
      ],
    };
    const drafts = clipboardToDrafts(capsuleBoardToClipboard(board as never), 100, 100);
    for (const d of drafts) {
      expect(Number.isFinite(d.x) && Number.isFinite(d.y)).toBe(true);
      expect(Number.isFinite(d.w) && Number.isFinite(d.h)).toBe(true);
    }
  });
});

describe('board-clipboard — cont.98 batch-26 hardening (paste-bomb, malformed, huge coords, dup ids)', () => {
  it('#6 clipboardToDrafts fails closed on a malformed non-array items payload (no TypeError)', () => {
    // A crafted external clipboard could carry items:null — the old code threw on .map.
    const bad = { kind: 'board-item-clipboard', version: 1, items: null } as never;
    expect(() => clipboardToDrafts(bad, 0, 0)).not.toThrow();
    expect(clipboardToDrafts(bad, 0, 0)).toEqual([]);
  });

  it('#7 copyItemsToClipboard does not RangeError on a huge selection (Math.min spread → minOf)', () => {
    const many = Array.from({ length: 200000 }, (_, i) => item({ memberId: `n${i}`, x: i, y: 0, w: 10, h: 10 }));
    expect(() => copyItemsToClipboard(many)).not.toThrow();
    expect(copyItemsToClipboard(many)!.items).toHaveLength(200000);
  });

  it('#8 finite-huge coordinates do not collapse the far item onto the paste origin', () => {
    const clip = copyItemsToClipboard([
      item({ memberId: 'a', x: -Number.MAX_VALUE, y: 0, w: 10, h: 10 }),
      item({ memberId: 'b', x: Number.MAX_VALUE, y: 0, w: 10, h: 10 }),
    ])!;
    const drafts = clipboardToDrafts(clip, 100, 100);
    for (const d of drafts) expect(Number.isFinite(d.x)).toBe(true);
    // the two items stay far apart (clamped to ±1e7 span), NOT both at the origin
    expect(Math.abs(drafts[0].x - drafts[1].x)).toBeGreaterThan(1_000_000);
  });

  it('#9 a duplicate localId remaps a connector to the FIRST clone deterministically', () => {
    let n = 0;
    const mint = () => `m${n++}`;
    const placed = planPaste(
      [
        { kind: 'note', localId: 'a', x: 0, y: 0, w: 10, h: 10 },
        { kind: 'note', localId: 'a', x: 50, y: 0, w: 10, h: 10 },
        { kind: 'note', localId: 'b', x: 100, y: 0, w: 10, h: 10 },
        { kind: 'connector', fromLocalId: 'a', toLocalId: 'b', x: 0, y: 0, w: 0, h: 0 },
      ],
      mint,
    );
    const firstA = placed.find((p) => p.localId === 'a')!; // the FIRST 'a' node (m0)
    const conn = placed.find((p) => p.isConnector)!;
    expect(conn.extra!.fromMemberId).toBe(firstA.memberId); // first-wins, not the last 'a'
    expect(firstA.memberId).toBe('m0');
  });

  it('#10 clipboardToDrafts budgets a pathologically large bundle', () => {
    const huge = {
      kind: 'board-item-clipboard' as const,
      version: 1 as const,
      items: Array.from({ length: 100000 }, (_, i) => ({ kind: 'note', w: 10, h: 10, dx: i, dy: 0, localId: `n${i}` })),
    };
    expect(clipboardToDrafts(huge, 0, 0)).toHaveLength(20000); // capped at MAX_PASTE_ITEMS
  });

  it('#11 clipboardToDrafts strips proto-pollution + geometry from a RAW crafted clipboard extra (not only the copy/capsule producers)', () => {
    // A crafted external clipboard ALREADY in board-item-clipboard shape reaches the resolver WITHOUT
    // passing carriedExtra on a producer — so the resolver boundary itself must strip it. This extra
    // carries __proto__/constructor (prototype-pollution vectors) + x/y/w/h (geometry that clobbers the
    // paste origin via placeItem's extra-spread). Fails BEFORE batch-44 (extra flowed through raw).
    const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"c":1},"x":9,"y":9,"w":9,"h":9,"locked":true}');
    const clip = {
      kind: 'board-item-clipboard' as const,
      version: 1 as const,
      items: [{ kind: 'note', w: 10, h: 10, dx: 0, dy: 0, localId: 'a', extra: evil }],
    };
    const [d] = clipboardToDrafts(clip, 100, 100);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global prototype pollution
    const ex = d.extra as Record<string, unknown> | undefined;
    expect(ex?.locked).toBe(true); // the safe key survives
    for (const k of ['__proto__', 'constructor', 'prototype', 'x', 'y', 'w', 'h']) {
      expect(Object.prototype.hasOwnProperty.call(ex ?? {}, k)).toBe(false); // dangerous + geometry keys dropped
    }
    expect(Object.getPrototypeOf(ex ?? {})).toBe(Object.prototype); // carried object is clean
  });

  it('#12 clipboardToDrafts drops stale endpoint ids from a crafted CONNECTOR extra (planPaste re-anchors)', () => {
    // A connector draft (fromLocalId/toLocalId present) must not carry raw fromMemberId/toMemberId in
    // extra — those are stale ids; planPaste re-adds the remapped ones. carriedExtra strips them only
    // for connectors, which the resolver now infers from the bundle-local endpoint ids.
    const clip = {
      kind: 'board-item-clipboard' as const,
      version: 1 as const,
      items: [{
        kind: 'connector', w: 0, h: 0, dx: 0, dy: 0, localId: 'c',
        fromLocalId: 'a', toLocalId: 'b',
        extra: { fromMemberId: 'STALE_A', toMemberId: 'STALE_B', dash: true },
      }],
    };
    const [d] = clipboardToDrafts(clip, 0, 0);
    const ex = d.extra as Record<string, unknown> | undefined;
    expect(ex?.dash).toBe(true); // non-endpoint presentation survives
    expect(ex?.fromMemberId).toBeUndefined(); // stale endpoint id dropped
    expect(ex?.toMemberId).toBeUndefined();
  });
});
