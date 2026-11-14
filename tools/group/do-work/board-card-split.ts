// packages/group/do-work/board-card-split.ts
//
// CARD SPLIT -- explode one card into many (b133). The exact inverse of card MERGE (b132): a brainstorm card
// with several ideas crammed into it ("- book flight / - book hotel / - rent car") becomes one card per line, so
// each idea can be moved, connected, and tracked on its own. The head child inherits the original's connectors,
// so the plan's structure survives the split (mirror of merge, where the survivor inherits them).
//
// A card's text is parsed into SEGMENTS -- one per line, with a leading bullet/ordinal marker ("- ", "* ",
// "1. ", "1) ") stripped -- and each non-empty segment becomes a child stacked below the original. Split into a
// PURE planner (`planCardSplit` -> child placements + head + the card to remove) + a pure applier
// (`applyCardSplit`, for tests/proof) + a live graph action (`splitCardInGraph`). The planner names no kind and
// reads only the item's own text (L090); deterministic given an injected id mint.

import type { BoardItem } from '../read-data/group-board-model';
import {
  readItems,
  placeItems,
  patchItems,
  removeItem,
  itemIsConnector,
  itemRef,
} from '../read-data/group-board-model';
import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

/** One child card produced by a split -- a minted id + its stacked position + the segment text. */
export interface SplitChild {
  readonly memberId: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
}

export interface CardSplitPlan {
  /** The child cards (>= 2 when the split fires; [] for a no-op). */
  readonly childCards: readonly SplitChild[];
  /** The first child -- inherits the original's connectors. */
  readonly headId: string;
  /** The original card, to delete once the children are placed. */
  readonly removeMemberId: string;
}

const cardText = (item: BoardItem | undefined): string => (typeof item?.text === 'string' ? item.text : '');

/**
 * Parse a card body into its segments: one per line, with a leading list marker ("- ", "* ", "<bullet> ",
 * "1. ", "1) ") stripped, trimmed, empties dropped. A single line of prose stays one segment (so it won't
 * split). Pure.
 */
export function splitSegments(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•‣◦]|\d+[.)])\s+/, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Plan the split of `item` into one child per text segment, each stacked below the original (same width/height/
 * kind). `mintMemberId` supplies fresh unique member ids (injected -> deterministic in tests). Fewer than 2
 * segments -> a no-op plan (childCards []). The first child is the head that will inherit the original's
 * connectors. Pure & deterministic.
 */
export function planCardSplit(item: BoardItem, mintMemberId: () => string, gap = 16): CardSplitPlan {
  const segments = splitSegments(cardText(item));
  if (segments.length < 2) {
    return { childCards: [], headId: item.memberId, removeMemberId: item.memberId };
  }
  const childCards: SplitChild[] = segments.map((text, i) => ({
    memberId: mintMemberId(),
    kind: item.kind,
    x: item.x,
    y: item.y + i * (item.h + gap),
    w: item.w,
    h: item.h,
    text,
  }));
  return { childCards, headId: childCards[0].memberId, removeMemberId: item.memberId };
}

const asBoardItem = (c: SplitChild): BoardItem =>
  ({ memberId: c.memberId, nodeRef: { id: c.memberId } as never, kind: c.kind, x: c.x, y: c.y, w: c.w, h: c.h, isSection: false, childCount: 0, text: c.text, extra: {} } as BoardItem);

/**
 * Apply a split plan to a plain item array (pure -- for tests/proof): remove the original, re-anchor every
 * connector that touched it onto the head child, and append the child cards. Never mutates the input.
 */
export function applyCardSplit(items: readonly BoardItem[], plan: CardSplitPlan): BoardItem[] {
  if (plan.childCards.length < 2) return [...items];
  const removed = plan.removeMemberId;
  const head = plan.headId;
  const out: BoardItem[] = [];
  for (const item of items) {
    if (item.memberId === removed) continue; // the original is replaced by its children (appended below)
    if (itemIsConnector(item)) {
      const e = (item.extra ?? {}) as Record<string, unknown>;
      const from = e.fromMemberId === removed ? head : e.fromMemberId;
      const to = e.toMemberId === removed ? head : e.toMemberId;
      if (from !== e.fromMemberId || to !== e.toMemberId) {
        out.push({ ...item, extra: { ...e, fromMemberId: from, toMemberId: to } } as BoardItem);
        continue;
      }
    }
    out.push(item);
  }
  for (const c of plan.childCards) out.push(asBoardItem(c));
  return out;
}

/**
 * The LIVE board action -- split the card `memberId` into one card per line. Reads the current items, plans the
 * split, places the children (fresh minted ids + nodeRefs) in ONE batch, re-anchors the original's connectors
 * onto the head child, then removes the original. A card that is a connector or has fewer than 2 segments is a
 * no-op (returns the SAME graph reference). `newId(prefix)` supplies fresh ids. Pure graph -> graph.
 */
export function splitCardInGraph(
  graph: GroupGraph,
  parentRef: AddressRef,
  boardId: string,
  memberId: string,
  newId: (prefix: string) => string,
): GroupGraph {
  const items = readItems(graph, parentRef);
  const item = items.find((i) => i.memberId === memberId);
  if (!item || itemIsConnector(item)) return graph;
  const plan = planCardSplit(item, () => newId('m'));
  if (plan.childCards.length < 2) return graph;
  const head = plan.headId;

  let g = placeItems(
    graph,
    parentRef,
    plan.childCards.map((c) => ({
      memberId: c.memberId,
      nodeRef: itemRef(boardId, newId('i')),
      kind: c.kind,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      text: c.text,
    })),
  );

  const reanchors: { memberId: string; patch: Record<string, unknown> }[] = [];
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const e = (it.extra ?? {}) as Record<string, unknown>;
    const from = e.fromMemberId === memberId ? head : e.fromMemberId;
    const to = e.toMemberId === memberId ? head : e.toMemberId;
    if (from !== e.fromMemberId || to !== e.toMemberId) {
      reanchors.push({ memberId: it.memberId, patch: { extra: { ...e, fromMemberId: from, toMemberId: to } } });
    }
  }
  if (reanchors.length > 0) g = patchItems(g, parentRef, reanchors);

  return removeItem(g, parentRef, memberId);
}
