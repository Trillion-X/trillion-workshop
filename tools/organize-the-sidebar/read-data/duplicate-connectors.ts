// packages/group/read-data/duplicate-connectors.ts
//
// DUPLICATE CONNECTORS — connector hygiene. It is easy to draw the SAME link twice: you connect A→B, forget,
// and connect A→B again, so two identical lines stack on the board (and double-count in every rollup / critical
// path / graph export that reads the connectors). This finds them: groups of ≥2 connectors sharing the SAME
// (from, to, kind) — the literally-identical relationship drawn more than once — so "clean up my redundant
// lines" falls out. The redundant ones (all but the first per group) are the safe delete set.
//
// STRICT by design: a duplicate is same from AND same to AND same relation KIND. A card with a "blocks" edge
// AND a "relates-to" edge to the same target is NOT a duplicate (two different relationships), so this never
// flags a legitimately-typed pair. Distinct from `board-cycles` (a directed loop) and `board-islands`
// (disconnected components) — this is about REDUNDANT edges, not the graph's shape. A pure composition of the
// relationship graph (`buildRelationGraph`, which already drops DANGLING connectors, L069/L093 — owns no edge
// logic). Pure, deterministic (connector-id order).

import type { BoardItem } from './group-board-model.ts';
import { buildRelationGraph } from './relationship-graph.ts';

/** A set of connectors that express the identical relationship — same endpoints AND kind, drawn ≥2 times. */
export interface DuplicateConnectorGroup {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  /** The connector member ids, sorted — `[0]` is the one to keep, `[1..]` the redundant duplicates. */
  readonly connectorIds: readonly string[];
}

/** Every (from, to, kind) borne by ≥2 connectors → its duplicate group, in first-appearance order. Dangling
 *  connectors (an endpoint not on the board) are already excluded by `buildRelationGraph`, so a phantom line
 *  never pairs with a real one. */
export function duplicateConnectorGroups(items: readonly BoardItem[]): DuplicateConnectorGroup[] {
  const graph = buildRelationGraph(items);
  // Group connector ids by the identical-relationship key; remember first-seen order for determinism.
  const byKey = new Map<string, { from: string; to: string; kind: string; ids: string[] }>();
  for (const e of graph.edges) {
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.ids.push(e.memberId);
    else byKey.set(key, { from: e.from, to: e.to, kind: e.kind, ids: [e.memberId] });
  }
  const out: DuplicateConnectorGroup[] = [];
  for (const { from, to, kind, ids } of byKey.values()) {
    if (ids.length >= 2) out.push({ from, to, kind, connectorIds: [...ids].sort() });
  }
  return out;
}

/** The REDUNDANT connector ids — every duplicate except the first-kept one per group, sorted. Deleting exactly
 *  these leaves one connector per real relationship (the safe de-duplication set). */
export function redundantConnectorIds(items: readonly BoardItem[]): string[] {
  const out: string[] = [];
  for (const g of duplicateConnectorGroups(items)) out.push(...g.connectorIds.slice(1));
  return out.sort();
}

/** True iff any relationship is drawn by ≥2 connectors — the gate for surfacing the de-dup affordance (L118). */
export function boardHasDuplicateConnectors(items: readonly BoardItem[]): boolean {
  return duplicateConnectorGroups(items).length > 0;
}

/** Render the audit: a "## Duplicate connectors (N)" report, one line per identical-relationship group with its
 *  connector count. "No duplicate connectors" when the graph is clean. */
export function duplicateConnectorsText(items: readonly BoardItem[], title?: string): string {
  const groups = duplicateConnectorGroups(items);
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (groups.length === 0) return [...head, 'No duplicate connectors'].join('\n');
  const lines = groups.map((g) => {
    const extra = g.connectorIds.length - 1; // redundant duplicates beyond the one kept
    return `- ${g.from} → ${g.to} (${g.kind}) — ${g.connectorIds.length} connectors, ${extra} redundant`;
  });
  return [...head, `## Duplicate connectors (${groups.length})`, ...lines].join('\n');
}
