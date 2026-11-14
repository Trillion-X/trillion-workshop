// packages/group/do-work/board-card-merge.ts
//
// CARD MERGE -- combine several cards into one (b132). The board can already FIND near-duplicate cards
// (`text-similarity` `duplicateGroups` + the `content-similar-facet` overlay), but nothing could MERGE them: a
// brainstorm where the same idea was written three times stayed three cards. This is the missing action --
// "merge these into one" -- that folds a selection of cards into a single primary card, carrying every
// connector so the plan's structure survives the merge.
//
// The hard part is the connectors: when cards fold into the primary, every connector that touched a merged card
// must RE-ANCHOR to the primary, and the merge must not leave garbage behind -- a connector whose BOTH ends
// collapse onto the primary becomes a self-loop (dropped), and two connectors that collapse onto the SAME
// (from, to, kind) become duplicates (deduped to one). This mirrors the re-anchor discipline the clipboard/paste
// pipeline already uses (`board-clipboard`), applied to a fold instead of a clone.
//
// Split into a PURE planner (`planCardMerge` -> a machine-readable `CardMergePlan`) + a pure applier
// (`applyCardMerge`, for tests/proof) + a live graph action (`mergeCardsInGraph`). The planner names no kind and
// reads only self-describing fields (L090); deterministic throughout.

import type { BoardItem } from '../read-data/group-board-model';
import {
  readItems,
  patchItem,
  patchItems,
  removeItems,
  itemIsConnector,
} from '../read-data/group-board-model';
import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

/** A machine-readable description of a merge -- what the primary becomes, what to drop, what to re-anchor. */
export interface CardMergePlan {
  /** The card everything folds INTO (survives the merge). */
  readonly primaryId: string;
  /** The primary's new text -- the distinct, non-empty texts of all merged cards joined (primary first). */
  readonly mergedText: string;
  /** Members to delete: the non-primary merged cards + connectors that became self-loops or duplicates. */
  readonly removeMemberIds: readonly string[];
  /** Connectors whose endpoint(s) moved onto the primary and are kept -- their new endpoints. */
  readonly reanchor: readonly { readonly memberId: string; readonly from: string; readonly to: string }[];
}

const connEnds = (item: BoardItem): { from: string; to: string } | null => {
  const e = (item.extra ?? {}) as Record<string, unknown>;
  const from = e.fromMemberId;
  const to = e.toMemberId;
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
};
const connKind = (item: BoardItem): string => {
  const k = (item.extra as Record<string, unknown> | undefined)?.relationKind;
  return typeof k === 'string' ? k : '';
};
const cardText = (item: BoardItem | undefined): string => (typeof item?.text === 'string' ? item.text.trim() : '');

/**
 * Plan the merge of `mergeIds` into one primary card. The primary is `primaryId` when it is one of the merged
 * cards, else the first merged card in board (reading) order. Non-card ids (connectors) and absent ids are
 * ignored. Fewer than 2 real cards -> a no-op plan. Connectors re-anchor to the primary; a connector collapsing
 * to a self-loop is removed; connectors collapsing to the same (from, to, kind) are deduped to the first.
 * Pure & deterministic (given a fixed board order; the primary is by reading order by design).
 */
export function planCardMerge(items: readonly BoardItem[], mergeIds: readonly string[], primaryId?: string): CardMergePlan {
  const wanted = new Set(mergeIds);
  // Merged cards in board (reading) order -- only present, non-connector items.
  const cards = items.filter((i) => wanted.has(i.memberId) && !itemIsConnector(i));
  const cardIds = cards.map((c) => c.memberId);
  const primary = primaryId && cardIds.includes(primaryId) ? primaryId : cardIds[0];

  if (cards.length < 2 || !primary) {
    return { primaryId: primary ?? (cardIds[0] ?? ''), mergedText: cardText(cards[0]), removeMemberIds: [], reanchor: [] };
  }

  const others = new Set(cardIds.filter((id) => id !== primary));

  // Merged text: distinct non-empty texts, primary first, others in board order.
  const ordered = [cards.find((c) => c.memberId === primary)!, ...cards.filter((c) => c.memberId !== primary)];
  const seenText = new Set<string>();
  const mergedText = ordered
    .map(cardText)
    .filter((t) => t.length > 0 && !seenText.has(t) && (seenText.add(t), true))
    .join('\n\n');

  const remove: string[] = [...others];
  const reanchor: { memberId: string; from: string; to: string }[] = [];
  const keptPairs = new Set<string>(); // "from to kind" of every kept connector -- drop collapses onto them
  const moved: { memberId: string; from: string; to: string; kind: string }[] = [];

  // Pass 1: an UNMOVED connector (neither end folds onto the primary) is always kept -- register its final
  // pair so a re-anchored connector can't duplicate it.
  for (const item of items) {
    if (!itemIsConnector(item)) continue;
    const ends = connEnds(item);
    if (!ends) continue;
    const from = others.has(ends.from) ? primary : ends.from;
    const to = others.has(ends.to) ? primary : ends.to;
    if (from === ends.from && to === ends.to) {
      keptPairs.add(from + ' ' + to + ' ' + connKind(item));
    } else {
      moved.push({ memberId: item.memberId, from, to, kind: connKind(item) });
    }
  }
  // Pass 2: a MOVED connector -- drop it if it became a self-loop or a duplicate of a kept pair, else re-anchor.
  for (const m of moved) {
    if (m.from === m.to) {
      remove.push(m.memberId); // both ends collapsed onto primary -> self-loop -> drop
      continue;
    }
    const key = m.from + ' ' + m.to + ' ' + m.kind;
    if (keptPairs.has(key)) {
      remove.push(m.memberId); // a parallel duplicate after the fold -> drop
      continue;
    }
    keptPairs.add(key);
    reanchor.push({ memberId: m.memberId, from: m.from, to: m.to });
  }

  return {
    primaryId: primary,
    mergedText,
    removeMemberIds: [...new Set(remove)].sort((a, b) => a.localeCompare(b)),
    reanchor: reanchor.sort((a, b) => a.memberId.localeCompare(b.memberId)),
  };
}

/**
 * Apply a merge plan to a plain item array (pure -- for tests/proof). Removes the dropped members, sets the
 * primary's text, and re-anchors the kept connectors' endpoints. Never mutates the input.
 */
export function applyCardMerge(items: readonly BoardItem[], plan: CardMergePlan): BoardItem[] {
  const drop = new Set(plan.removeMemberIds);
  const reanchorById = new Map(plan.reanchor.map((r) => [r.memberId, r]));
  const out: BoardItem[] = [];
  for (const item of items) {
    if (drop.has(item.memberId)) continue;
    if (item.memberId === plan.primaryId) {
      out.push({ ...item, text: plan.mergedText } as BoardItem);
      continue;
    }
    const re = reanchorById.get(item.memberId);
    if (re) {
      out.push({ ...item, extra: { ...(item.extra ?? {}), fromMemberId: re.from, toMemberId: re.to } } as BoardItem);
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * The LIVE board action -- merge `mergeIds` into one card in the graph. Reads the current items, plans the
 * merge, and applies it as graph mutations: patch the primary's text, re-anchor the kept connectors' endpoints
 * (merging into each connector's existing `extra` so `relationKind`/`label` survive), and batch-remove the
 * folded cards + dropped connectors. A no-op merge returns the SAME graph reference. Pure graph -> graph.
 */
export function mergeCardsInGraph(graph: GroupGraph, parentRef: AddressRef, mergeIds: readonly string[], primaryId?: string): GroupGraph {
  const items = readItems(graph, parentRef);
  const plan = planCardMerge(items, mergeIds, primaryId);
  if (plan.removeMemberIds.length === 0 && plan.reanchor.length === 0) return graph;

  const byId = new Map(items.map((i) => [i.memberId, i]));
  let g = patchItem(graph, parentRef, plan.primaryId, { text: plan.mergedText });
  if (plan.reanchor.length > 0) {
    g = patchItems(
      g,
      parentRef,
      plan.reanchor.map((r) => {
        const cur = (byId.get(r.memberId)?.extra ?? {}) as Record<string, unknown>;
        return { memberId: r.memberId, patch: { extra: { ...cur, fromMemberId: r.from, toMemberId: r.to } } };
      }),
    );
  }
  return removeItems(g, parentRef, plan.removeMemberIds);
}
