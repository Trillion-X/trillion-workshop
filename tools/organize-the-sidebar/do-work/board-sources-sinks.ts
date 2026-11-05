// packages/group/do-work/board-sources-sinks.ts
//
// SOURCES & SINKS — the entry and exit points of a board's DIRECTED dependency graph. On a plan/flow board the
// SOURCES (nothing points to them, but they point onward) are the STARTING POINTS — where the work begins; the
// SINKS (they point to nothing, but something points to them) are the FINAL OUTCOMES — the deliverables the
// whole graph builds toward. Surfacing them answers "where does this plan start?" and "what are its end
// results?" at a glance.
//
// Distinct from the neighbouring readers: `board-orphans` = cards with NO edges at all (a source/sink has ≥1);
// `board-readiness` = the COMPLETION frontier (prereqs done) — a structural source has no prereqs regardless of
// completion; `board-hubs` = the MOST-connected cards by degree. This is the pure in/out-degree extremes. A
// pure composition of the degree SSOT (`nodeDegrees` from board-hubs, which builds the relation graph once and
// excludes connectors + dangling edges, L069/L093 — owns no graph logic). Pure, deterministic (sorted).

import type { BoardItem } from '../read-data/group-board-model.ts';
import { nodeDegrees } from './board-hubs.ts';

/** The SOURCE (root) cards — in-degree 0 AND out-degree ≥1: nothing depends on them, they start the graph. An
 *  isolated card (no edges either way) is an ORPHAN, not a source, so it is excluded. Sorted. */
export function boardSources(items: readonly BoardItem[]): string[] {
  const out: string[] = [];
  for (const [id, d] of nodeDegrees(items)) if (d.inDegree === 0 && d.outDegree > 0) out.push(id);
  return out.sort();
}

/** The SINK (terminal) cards — out-degree 0 AND in-degree ≥1: they point onward to nothing, they are the final
 *  outcomes. An isolated card is excluded (orphan, not a sink). Sorted. */
export function boardSinks(items: readonly BoardItem[]): string[] {
  const out: string[] = [];
  for (const [id, d] of nodeDegrees(items)) if (d.outDegree === 0 && d.inDegree > 0) out.push(id);
  return out.sort();
}

/** True iff the board has ≥1 source — gates the "Select starting points" affordance (L118). */
export function boardHasSources(items: readonly BoardItem[]): boolean {
  return boardSources(items).length > 0;
}

/** True iff the board has ≥1 sink — gates the "Select final outcomes" affordance (L118). */
export function boardHasSinks(items: readonly BoardItem[]): boolean {
  return boardSinks(items).length > 0;
}

/** Render the entry/exit readout: a "## Starting points (N)" list + a "## Final outcomes (M)" list, each by
 *  card id. "No dependency flow" when the board has neither (no connected direction to read). */
export function sourcesSinksText(items: readonly BoardItem[], title?: string): string {
  const sources = boardSources(items);
  const sinks = boardSinks(items);
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (sources.length === 0 && sinks.length === 0) return [...head, 'No dependency flow'].join('\n');
  const lines: string[] = [...head];
  if (sources.length > 0) {
    lines.push(`## Starting points (${sources.length})`);
    for (const id of sources) lines.push(`- ${id}`);
  }
  if (sinks.length > 0) {
    if (sources.length > 0) lines.push('');
    lines.push(`## Final outcomes (${sinks.length})`);
    for (const id of sinks) lines.push(`- ${id}`);
  }
  return lines.join('\n');
}
