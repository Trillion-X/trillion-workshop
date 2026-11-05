// packages/group/do-work/board-rollup-actions.ts
//
// The GRAPH bridge for the goal-rollup primitive (read-data/board-rollup): turn the board's typed
// connectors + per-card metrics into "who are my children" + "my own progress" and hand them to the
// blind tree reducer. The hierarchy relation is DATA — a `RollupSpec {relationKind, childEndpoint}` chosen
// by the board (per the Codex convergence: NO default relation kind — a bare `relates-to` line is too
// ambiguous to be hierarchy). `childEndpoint` says which end of a connector is the CHILD, so both drawing
// conventions ("Run 5k -> Get fit" and "Get fit -> Run 5k") are supported by DATA, not code branches.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { type RelationGraph, buildRelationGraph, relationsFrom, relationsTo } from '../read-data/relationship-graph.ts';
import { cardCompletion } from '../read-data/card-completion.ts';
import { type RollupResult, rollupOf } from '../read-data/board-rollup.ts';

/** How the board declares its goal hierarchy: which relation kind + which endpoint of it is the child. */
export interface RollupSpec {
  readonly relationKind: string;
  readonly childEndpoint: 'from' | 'to';
}

/** Fail-closed spec reader: a non-empty relationKind + a valid childEndpoint, else null (rollup off). */
export function rollupSpecFromRaw(raw: unknown): RollupSpec | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.relationKind === 'string' ? o.relationKind.trim() : '';
  if (kind === '') return null;
  if (o.childEndpoint !== 'from' && o.childEndpoint !== 'to') return null;
  return { relationKind: kind, childEndpoint: o.childEndpoint };
}

/** The `childrenOf` accessor for the reducer: the distinct child ids of a node under the spec's relation. */
export function childrenAccessor(graph: RelationGraph, spec: RollupSpec): (id: string) => string[] {
  return (id: string) => {
    const edges = spec.childEndpoint === 'from' ? relationsTo(graph, id, spec.relationKind) : relationsFrom(graph, id, spec.relationKind);
    const ids = edges.map((e) => (spec.childEndpoint === 'from' ? e.from : e.to));
    return [...new Set(ids)];
  };
}

/** The `fractionOf` accessor for the reducer: a card's own progress 0..1, or null. Reads the UNIFIED
 *  `cardCompletion` SSOT — metric completion if the card has a metric, ELSE its checklist fraction — so
 *  a sub-goal tracked by a CHECKLIST (not a metric) now counts toward its parent's rollup instead of
 *  silently contributing nothing. EXACT 0..1 (over-achievement caps at 1 inside cardCompletion), NOT
 *  display-rounded, so a 99.5% child aggregates as 0.995, never a false-complete 1.0. */
export function fractionAccessor(items: readonly BoardItem[]): (id: string) => number | null {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string) => {
    const it = byId.get(id);
    if (!it) return null;
    return cardCompletion(it) ?? null;
  };
}

/** The rollup verdict for ONE card under the spec (childCount 0 when it has no children). */
export function rollupOfItem(items: readonly BoardItem[], memberId: string, spec: RollupSpec): RollupResult {
  const graph = buildRelationGraph(items);
  return rollupOf(memberId, childrenAccessor(graph, spec), fractionAccessor(items));
}

/** True iff a card has children under the spec — i.e. a rolled-up badge is meaningful on it. */
export function itemIsRollupParent(items: readonly BoardItem[], memberId: string, spec: RollupSpec): boolean {
  const graph = buildRelationGraph(items);
  return childrenAccessor(graph, spec)(memberId).length > 0;
}

/** One rollup row: a parent card + its aggregate + coverage — the DATA behind a badge or a breakdown. */
export interface RollupRow {
  readonly memberId: string;
  readonly label: string;
  readonly result: RollupResult;
}

function labelOf(items: readonly BoardItem[]): (id: string) => string {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string) => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
}

/**
 * Every card that HAS children under the spec, paired with its rollup — the DATA behind the per-card
 * rolled-up badges. Cards with no children are excluded (a rollup badge would be meaningless). Pure.
 */
export function rollupParents(items: readonly BoardItem[], spec: RollupSpec): RollupRow[] {
  const graph = buildRelationGraph(items);
  const childrenOf = childrenAccessor(graph, spec);
  const fractionOf = fractionAccessor(items);
  const label = labelOf(items);
  const out: RollupRow[] = [];
  for (const it of items) {
    if (childrenOf(it.memberId).length === 0) continue;
    out.push({ memberId: it.memberId, label: label(it.memberId), result: rollupOf(it.memberId, childrenOf, fractionOf) });
  }
  return out;
}

/** One child of a rollup parent, with its own rolled-up contribution — the DATA behind a breakdown panel. */
export interface RollupChild {
  readonly memberId: string;
  readonly label: string;
  readonly result: RollupResult;
}

/** The direct children of a parent (each with its OWN rollup) — the "what's under this vision" breakdown. */
export function rollupChildren(items: readonly BoardItem[], parentId: string, spec: RollupSpec): RollupChild[] {
  const graph = buildRelationGraph(items);
  const childrenOf = childrenAccessor(graph, spec);
  const fractionOf = fractionAccessor(items);
  const label = labelOf(items);
  return childrenOf(parentId).map((cid) => ({ memberId: cid, label: label(cid), result: rollupOf(cid, childrenOf, fractionOf) }));
}
