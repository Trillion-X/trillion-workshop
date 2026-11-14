// packages/group/show/content-similar-facet.ts
//
// CONTENT-SIMILAR FACET — the surface bridge that turns b110's near-duplicate detection into a b107
// ClusterFacet, so the EXISTING `ClusterHullOverlay` outlines groups of notes that SAY THE SAME THING, with
// ZERO new render code (L030/L069 reuse, exactly like b109's spatial facet — but grouped by TEXT overlap
// instead of geometry). It also exposes `rankSimilarItems` for a "notes similar to this one" affordance (the
// content sibling of the board's exact-match select-similar). `textOf` is injected (default: the item's plain
// text projection), so the leaf never assumes a note shape.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import {
  duplicateGroups,
  rankSimilar,
  type ShingleMode,
} from 'trillion-workshop/tools/organize-the-sidebar/do-work/text-similarity.ts';
import type { ClusterFacet } from './ClusterHullOverlay';

export interface ContentSimilarOptions {
  /** Extract the comparable text of an item (default: its plain `text`). */
  readonly textOf?: (item: BoardItem) => string;
  /** Min similarity to call two notes "the same thing" (default 0.6). */
  readonly threshold?: number;
  readonly k?: number;
  readonly mode?: ShingleMode;
  /** Human label for a discovered group (default "Similar N", 1-based). */
  readonly labelOf?: (groupId: number) => string;
}

export interface ContentSimilarResult {
  readonly facet: ClusterFacet;
  /** How many near-duplicate groups were found. */
  readonly groupCount: number;
  readonly keyByMember: ReadonlyMap<string, string>;
}

const defaultText = (i: BoardItem): string => (typeof i.text === 'string' ? i.text : '');

/**
 * Detect near-duplicate note groups by content and return a {@link ClusterFacet} for the hull overlay (each
 * duplicate item → a `dup-N` key; a note in no group carries no key → no hull) + the group count + map.
 * Connectors excluded. Deterministic.
 */
export function contentSimilarFacet(items: readonly BoardItem[], opts: ContentSimilarOptions = {}): ContentSimilarResult {
  const textOf = opts.textOf ?? defaultText;
  const labelOf = opts.labelOf ?? ((id: number) => `Similar ${id + 1}`);
  const drawable = items.filter((i) => !itemIsConnector(i));
  const groups = duplicateGroups(drawable.map(textOf), {
    threshold: opts.threshold,
    k: opts.k,
    mode: opts.mode,
  });
  const keyByMember = new Map<string, string>();
  const labelByKey = new Map<string, string>();
  groups.forEach((group, gi) => {
    const key = `dup-${gi}`;
    labelByKey.set(key, labelOf(gi));
    for (const idx of group) keyByMember.set(drawable[idx].memberId, key);
  });
  const facet: ClusterFacet = {
    id: 'content-similar',
    label: 'Outline similar notes',
    keyOf: (item) => keyByMember.get(item.memberId),
    labelOf: (key) => labelByKey.get(key) ?? key,
  };
  return { facet, groupCount: groups.length, keyByMember };
}

/**
 * Rank the OTHER items by content similarity to `target` (the content select-similar). Connectors excluded.
 * Returns `{item, score}` descending. Powers a "find notes like this" board action.
 */
export function rankSimilarItems(
  target: BoardItem,
  items: readonly BoardItem[],
  opts: ContentSimilarOptions & { readonly minScore?: number; readonly limit?: number } = {},
): { item: BoardItem; score: number }[] {
  const textOf = opts.textOf ?? defaultText;
  const drawable = items.filter((i) => !itemIsConnector(i));
  const targetIndex = drawable.findIndex((i) => i.memberId === target.memberId);
  const ranked = rankSimilar(textOf(target), drawable.map(textOf), {
    k: opts.k,
    mode: opts.mode,
    minScore: opts.minScore,
    limit: opts.limit,
    excludeIndex: targetIndex >= 0 ? targetIndex : undefined,
  });
  return ranked.map((r) => ({ item: drawable[r.index], score: r.score }));
}
