// packages/group/do-work/board-readiness-actions.ts
//
// The GRAPH bridge for the readiness primitive (read-data/board-readiness): feed the blind engine the
// board's dependency edges + each card's completion. It REUSES the SAME prerequisite relation the critical-
// path + rollup already use — `childrenAccessor(graph, spec)` (a card's dependency children = the cards that
// must finish before it) — so there is ONE definition of "prerequisite" on the board (SSOT), and REUSES the
// unified `cardCompletion` reading for "is it done?". No new engine, no new storage: readiness is a pure
// composition of two shipped primitives (the connectors + the completion signal). Owns no Society beyond the
// canonical default spec.
//
// The DEFAULT dependency spec (`depends-on` / childEndpoint `to`) matches the relation-kind catalog: an edge
// `A --depends-on--> B` (arrow end = B) makes B a prerequisite (child) of A, i.e. B gates A. A board that
// configures its own rollup/dependency spec passes it in; absent, this canonical one is used.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { buildRelationGraph } from '../read-data/relationship-graph';
import { childrenAccessor, type RollupSpec } from './board-rollup-actions';
import { cardCompletion } from '../read-data/card-completion';
import { labelForGoal } from './board-critical-path-actions';
import {
  classifyReadiness,
  readyIds,
  blockedReadiness,
  type CardReadiness,
} from '../read-data/board-readiness';

/** The canonical dependency relation when a board hasn't configured its own: "A depends-on B" => B gates A. */
export const DEFAULT_PREREQ_SPEC: RollupSpec = { relationKind: 'depends-on', childEndpoint: 'to' };

/** Classify every content card (connectors + sections excluded) as done / ready / blocked under the spec. */
export function boardReadiness(items: readonly BoardItem[], spec: RollupSpec = DEFAULT_PREREQ_SPEC): CardReadiness[] {
  const graph = buildRelationGraph(items);
  const prerequisitesOf = childrenAccessor(graph, spec);
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const completionOf = (id: string): number | undefined => {
    const it = byId.get(id);
    return it ? cardCompletion(it) : undefined;
  };
  const cardIds = items.filter((it) => !itemIsConnector(it) && !it.isSection).map((it) => it.memberId);
  return classifyReadiness(cardIds, completionOf, prerequisitesOf);
}

/** The READY frontier as card ids — actionable-now cards (for a "Select ready" bulk action). */
export function readyCardIds(items: readonly BoardItem[], spec: RollupSpec = DEFAULT_PREREQ_SPEC): string[] {
  return readyIds(boardReadiness(items, spec));
}

/** True iff the board has at least one ready card — the gate for surfacing the "Select ready" action. */
export function boardHasReadyCards(items: readonly BoardItem[], spec: RollupSpec = DEFAULT_PREREQ_SPEC): boolean {
  return readyCardIds(items, spec).length > 0;
}

/**
 * Render the readiness as a GTD-style "Next actions" report: a "Ready to start" section (the frontier) and a
 * "Blocked" section (each card + the cards it is waiting on), by human card label. Empty sections are
 * dropped; a board with neither yields the honest "No actionable cards" line.
 */
export function nextActionsText(
  items: readonly BoardItem[],
  spec: RollupSpec = DEFAULT_PREREQ_SPEC,
  title?: string,
): string {
  const readiness = boardReadiness(items, spec);
  const labelOf = labelForGoal(items);
  const ready = readyIds(readiness);
  const blocked = blockedReadiness(readiness);
  const lines: string[] = [];
  if (title && title.trim() !== '') lines.push(`# ${title.trim()}`, '');
  if (ready.length > 0) {
    lines.push(`## Ready to start (${ready.length})`);
    for (const id of ready) lines.push(`- ${labelOf(id)}`);
  }
  if (blocked.length > 0) {
    if (ready.length > 0) lines.push('');
    lines.push(`## Blocked (${blocked.length})`);
    for (const row of blocked) {
      const waiting = row.blockedBy.map(labelOf).join(', ');
      lines.push(`- ${labelOf(row.cardId)} — waiting on: ${waiting}`);
    }
  }
  if (lines.length === 0 || (ready.length === 0 && blocked.length === 0)) {
    const head = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
    return [...head, 'No actionable cards'].join('\n');
  }
  return lines.join('\n');
}
