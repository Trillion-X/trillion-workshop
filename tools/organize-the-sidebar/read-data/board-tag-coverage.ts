// packages/group/read-data/board-tag-coverage.ts
//
// TAG COVERAGE — the tagging completeness of a board. Once a board is partly tagged (some cards carry a tag),
// the cards WITHOUT one are the gaps — the cards that will fall out of every tag filter / group-by-tag view.
// This is the TAG-dimension analogue of `board-date-coverage` (dated vs undated): it answers "which cards still
// need a tag?" and "how many distinct tags are in play?".
//
// Distinct from `board-tag-hygiene` (which audits the tags that EXIST — near-duplicates, singletons) — this is
// about the cards that have NONE. A pure composition of the tag SSOT (`itemTags` — owns no tag parsing) + the
// furniture guard (so a generated region-heading is never flagged "needs a tag"). Pure, deterministic;
// distinctness is case-insensitive (matching how the tag system dedupes on write).

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import { itemTags } from '../show/item-tags';

/** Content card = not a connector and not generated furniture (only these can meaningfully carry — or lack — a tag). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** The ids of content cards that carry ≥1 tag (sorted). */
export function taggedCardIds(items: readonly BoardItem[]): string[] {
  return contentCards(items).filter((c) => itemTags(c).length > 0).map((c) => c.memberId).sort();
}

/** The ids of content cards with NO tag (sorted) — what "Select untagged cards" selects. */
export function untaggedCardIds(items: readonly BoardItem[]): string[] {
  return contentCards(items).filter((c) => itemTags(c).length === 0).map((c) => c.memberId).sort();
}

/** True when the board is PARTLY tagged — some cards tagged, some not (the gate for the coverage surface). */
export function boardHasTagGaps(items: readonly BoardItem[]): boolean {
  const cards = contentCards(items);
  let tagged = 0;
  let untagged = 0;
  for (const c of cards) {
    if (itemTags(c).length > 0) tagged += 1;
    else untagged += 1;
    if (tagged > 0 && untagged > 0) return true;
  }
  return false;
}

export interface TagCoverage {
  readonly taggedCount: number;
  readonly untaggedCount: number;
  /** Distinct tags in use across the board (case-insensitive). */
  readonly distinctTags: number;
}

/** The board's tag coverage: tagged / untagged card counts + how many distinct tags are in play. */
export function tagCoverage(items: readonly BoardItem[]): TagCoverage {
  const cards = contentCards(items);
  let taggedCount = 0;
  const distinct = new Set<string>();
  for (const c of cards) {
    const tags = itemTags(c);
    if (tags.length > 0) taggedCount += 1;
    for (const t of tags) distinct.add(t.toLowerCase());
  }
  return { taggedCount, untaggedCount: cards.length - taggedCount, distinctTags: distinct.size };
}

/** A human "## Tag coverage" readout: tagged / untagged tallies + distinct-tag count, or an honest empty line. */
export function tagCoverageText(items: readonly BoardItem[], title?: string): string {
  const cov = tagCoverage(items);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Tag coverage');
  if (cov.taggedCount === 0 && cov.untaggedCount === 0) {
    lines.push('- No cards');
    return lines.join('\n');
  }
  lines.push(`- Tagged: ${cov.taggedCount} card${cov.taggedCount === 1 ? '' : 's'}`);
  lines.push(`- Untagged: ${cov.untaggedCount} card${cov.untaggedCount === 1 ? '' : 's'}`);
  lines.push(`- Distinct tags: ${cov.distinctTags}`);
  return lines.join('\n');
}
