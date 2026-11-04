// packages/group/read-data/board-split-candidates.ts
//
// SPLIT CANDIDATES — the cards that have quietly become mini-documents and would benefit from being broken into
// separate cards. `board-card-split` is the MUTATION (split ONE card into a card per segment); this is the
// board-wide DETECTOR that answers "which cards SHOULD I split?" — the read side that feeds the mutation.
//
// The signal is not an arbitrary length threshold: a card is a split candidate exactly when the SAME split
// engine that would break it up (`splitSegments`) finds ≥`minSegments` real segments — i.e. splitting it would
// actually produce ≥2 children (otherwise the Split action is a dead no-op on it, L118). Composes the split SSOT
// (`splitSegments` — owns no segmentation logic of its own) + the title SSOT (`cardTitle` for a readable label)
// + the furniture guard (L069/L093, no god package). Ranked most-splittable first. Pure, deterministic.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import { splitSegments } from '../do-work/board-card-split';
import { cardTitle } from './card-references';

/** A card worth splitting: its id, how many segments it would split into, and a readable title. */
export interface SplitCandidate {
  readonly memberId: string;
  readonly segmentCount: number;
  readonly title: string;
}

export interface SplitCandidateOptions {
  /** Minimum segments a card must break into to count as a candidate. Default 2 (the Split action's own gate). */
  readonly minSegments?: number;
  /** Cap the returned candidates (most-splittable first). Default: all. */
  readonly limit?: number;
}

/** Content card = not a connector and not generated furniture (only these carry splittable prose). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** The cards that would split into ≥`minSegments` children, ranked segment-count desc then title asc then id. */
export function boardSplitCandidates(items: readonly BoardItem[], opts: SplitCandidateOptions = {}): SplitCandidate[] {
  const minSegments = opts.minSegments ?? 2;
  const out: SplitCandidate[] = [];
  for (const card of contentCards(items)) {
    const text = typeof card.text === 'string' ? card.text : '';
    const segmentCount = splitSegments(text).length;
    if (segmentCount < minSegments) continue;
    out.push({ memberId: card.memberId, segmentCount, title: cardTitle(card) });
  }
  out.sort(
    (a, b) =>
      b.segmentCount - a.segmentCount ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
      (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0),
  );
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

/** The ids of the split candidates (sorted) — what "Select cards to split" selects. */
export function splitCandidateIds(items: readonly BoardItem[], opts: SplitCandidateOptions = {}): string[] {
  return boardSplitCandidates(items, opts).map((c) => c.memberId).sort();
}

/** True when ≥1 card would meaningfully split — the gate for the split-candidates surface. */
export function boardHasSplitCandidates(items: readonly BoardItem[], opts: SplitCandidateOptions = {}): boolean {
  return boardSplitCandidates(items, opts).length > 0;
}

/** A human "## Cards to split" readout: each candidate with its section count, or an honest empty line. */
export function splitCandidatesText(items: readonly BoardItem[], title?: string, opts: SplitCandidateOptions = {}): string {
  const cands = boardSplitCandidates(items, opts);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Cards to split');
  if (cands.length === 0) {
    lines.push('- No cards to split');
    return lines.join('\n');
  }
  for (const c of cands) lines.push(`- ${c.title || '(untitled)'} — ${c.segmentCount} sections`);
  return lines.join('\n');
}
