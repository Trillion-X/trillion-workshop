// packages/group/read-data/card-progress-view.ts
//
// The card-face progress READOUT: turns a card's unified completion into the {percent, complete} a
// bottom-edge progress strip renders, or null when there's nothing to show. Pure derivation over the
// `cardCompletion` SSOT (metric else checklist) — so the strip, the "Sort by progress" arrange, and the
// goal rollup all speak the SAME completion. A card with no metric and no checklist → null → no strip
// (plain notes render byte-identically, zero regression).

import type { BoardItem } from './group-board-model.ts';
import { cardCompletion } from './card-completion.ts';

export interface CardProgressView {
  /** Whole-percent completion 0..100 (for the strip width + an aria label). */
  readonly percent: number;
  /** 100% reached — the strip flips to the "done" tone. */
  readonly complete: boolean;
}

/** The progress strip's DATA for a card, or null when the card tracks no progress (no metric, no
 *  checklist). Reads the `cardCompletion` SSOT; clamps to [0,100] defensively for the bar width. */
export function cardProgressView(item: BoardItem): CardProgressView | null {
  const f = cardCompletion(item);
  if (f === undefined) return null;
  const clamped = f < 0 ? 0 : f > 1 ? 1 : f;
  return { percent: Math.round(clamped * 100), complete: clamped >= 1 };
}
