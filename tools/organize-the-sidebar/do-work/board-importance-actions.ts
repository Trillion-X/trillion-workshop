// packages/group/do-work/board-importance-actions.ts
//
// The row-builder for the CORE-IDEAS surface: turns the PageRank importance leaf (board-importance) into ranked,
// human-labelled rows for the generic RankedJumpList. "Which cards are the core ideas everything traces back
// to?" — a card endorsed by IMPORTANT cards ranks high transitively, which raw degree cannot see. Mirrors
// board-time-log-actions' shape exactly (injected `label` resolver so this stays blind to how a card titles
// itself, L098). Owns NO ranking math (importanceRanks) and NO graph construction (buildRelationGraph) — pure
// composition (L069/L093). Deterministic: score desc, memberId tie-break. Zero I/O.

import type { BoardItem } from '../read-data/group-board-model';
import { importanceRanks } from '../read-data/board-importance';
import { buildRelationGraph, relationsTo } from '../read-data/relationship-graph';

export interface ImportanceRow {
  readonly memberId: string;
  readonly label: string;
  /** PageRank score — this card's share of the board's total influence (ranks sum to ~1). */
  readonly score: number;
  /** In-degree: how many cards point AT this one (its direct endorsements). */
  readonly endorsers: number;
}

/**
 * The board's content cards ranked by transitive importance, most-important first (memberId tie-break for
 * determinism). `label` is injected (the caller resolves a card's display title). `k` caps the list (default:
 * all). An empty/edgeless board yields rows with uniform scores — honest, not hidden.
 */
export function importanceRows(items: readonly BoardItem[], label: (memberId: string) => string, k = Number.POSITIVE_INFINITY): ImportanceRow[] {
  const ranks = importanceRanks(items);
  if (ranks.size === 0) return [];
  const graph = buildRelationGraph(items);
  const rows: ImportanceRow[] = [];
  for (const [memberId, score] of ranks) {
    rows.push({ memberId, label: label(memberId), score, endorsers: relationsTo(graph, memberId).length });
  }
  rows.sort((a, b) => (b.score - a.score) || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  return Number.isFinite(k) ? rows.slice(0, Math.max(0, k)) : rows;
}

/** A compact summary line for the panel header — the count ranked + the single most-central card's share. */
export interface ImportanceSummary {
  readonly ranked: number;
  readonly topShare: number;
}
export function importanceSummary(rows: readonly ImportanceRow[]): ImportanceSummary {
  return { ranked: rows.length, topShare: rows.length > 0 ? rows[0].score : 0 };
}
