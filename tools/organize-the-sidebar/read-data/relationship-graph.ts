// packages/group/read-data/relationship-graph.ts
//
// R9: connectors as TYPED RELATIONSHIPS. A connector on the board already carries
// from/to (connector-models.ts); giving it a self-describing `extra.relationKind`
// ("depends-on", "blocks", "relates-to", …) turns the visual line into a semantic edge
// you can QUERY — "what does this card depend on?", "what blocks it?", "what does it
// touch?". Within a board the connectors ARE the relationship graph, so these queries are
// fully self-contained (no external package): the cross-board/cross-package relationship
// truth is `relationship-graph`'s job, but the in-board graph is derived right here.
//
// Enum-dissolved (L090): nothing branches on the relation kind — it is opaque DATA carried
// on the edge and grouped/filtered generically. A new relationship kind is a new DATA value
// on a connector, never a code change. Pure, deterministic, no I/O.

import type { BoardItem } from './group-board-model';
import { connectorEndpoints } from '../show/connector-models';

/** The default relation kind when a connector carries none — a bare, untyped link. */
export const DEFAULT_RELATION_KIND = 'relates-to';

export interface RelationEdge {
  readonly memberId: string; // the connector's own id
  readonly from: string;
  readonly to: string;
  readonly kind: string; // self-describing relationship kind (opaque)
  readonly label?: string; // optional human label carried on the connector
}

export interface RelationGraph {
  readonly edges: readonly RelationEdge[];
  /** memberId → outgoing edges (this → other). */
  readonly out: Readonly<Record<string, readonly RelationEdge[]>>;
  /** memberId → incoming edges (other → this). */
  readonly inc: Readonly<Record<string, readonly RelationEdge[]>>;
}

function pushEdge(map: Record<string, RelationEdge[]>, key: string, edge: RelationEdge): void {
  // `map` is a NULL-PROTOTYPE object (see buildRelationGraph). On a plain `{}`, an endpoint memberId
  // of '__proto__' would make `map['__proto__']` read Object.prototype (not null → `??=` skips) and
  // then `.push` on it throws (Object.prototype has no push); 'constructor' likewise. A null-proto map
  // has no such inherited keys, so any representable memberId is a safe own-key.
  (map[key] ??= []).push(edge);
}

/** Build the relationship graph from board items. Only items that are connectors (carry
 *  from/to) contribute edges; the relation kind is read from self-describing DATA. */
export function buildRelationGraph(items: readonly BoardItem[]): RelationGraph {
  const edges: RelationEdge[] = [];
  // Null-prototype adjacency maps: keys are endpoint memberIds (untrusted — a crafted/corrupted item
  // can carry memberId '__proto__'/'constructor'), and a plain `{}` would expose the prototype chain to
  // both the write (`pushEdge`) and every read (`graph.out[id] ?? []` → spread/filter Object.prototype).
  const out: Record<string, RelationEdge[]> = Object.create(null);
  const inc: Record<string, RelationEdge[]> = Object.create(null);
  // A connector to a member id that is not present is a DANGLING edge (a node was deleted but its connector
  // lingered, or a partial share dropped the endpoint). It must NOT become a real relationship: a phantom
  // edge miscounts a rollup's coverage and turns a critical path non-authoritative on a nonexistent
  // prerequisite. Only connect endpoints that actually exist among the items.
  const memberIds = new Set(items.map((it) => it.memberId));
  for (const it of items) {
    const ends = connectorEndpoints(it);
    if (!ends) continue;
    if (!memberIds.has(ends.from) || !memberIds.has(ends.to)) continue; // drop the dangling connector
    const ex = it.extra ?? {};
    const kind = typeof ex.relationKind === 'string' && ex.relationKind.length > 0 ? ex.relationKind : DEFAULT_RELATION_KIND;
    const edge: RelationEdge = {
      memberId: it.memberId,
      from: ends.from,
      to: ends.to,
      kind,
      label: typeof ex.label === 'string' ? ex.label : undefined,
    };
    edges.push(edge);
    pushEdge(out, edge.from, edge);
    pushEdge(inc, edge.to, edge);
  }
  return { edges, out, inc };
}

const byKind = (edges: readonly RelationEdge[], kind?: string): RelationEdge[] =>
  kind === undefined ? [...edges] : edges.filter((e) => e.kind === kind);

/** Edges leaving `memberId` (optionally of one kind). */
export function relationsFrom(graph: RelationGraph, memberId: string, kind?: string): RelationEdge[] {
  return byKind(graph.out[memberId] ?? [], kind);
}

/** Edges arriving at `memberId` (optionally of one kind). */
export function relationsTo(graph: RelationGraph, memberId: string, kind?: string): RelationEdge[] {
  return byKind(graph.inc[memberId] ?? [], kind);
}

/** All distinct member ids directly related to `memberId` (either direction), sorted. */
export function neighbors(graph: RelationGraph, memberId: string): string[] {
  const set = new Set<string>();
  for (const e of graph.out[memberId] ?? []) set.add(e.to);
  for (const e of graph.inc[memberId] ?? []) set.add(e.from);
  return [...set].sort();
}

/** Distinct relation kinds present in the graph, sorted — drives filters/legends generically. */
export function relationKinds(graph: RelationGraph): string[] {
  const set = new Set<string>();
  for (const e of graph.edges) set.add(e.kind);
  return [...set].sort();
}

/** True iff `memberId` lies on a directed cycle following out-edges (optionally one kind) —
 *  a circular dependency (A depends-on B, B depends-on A). A board of dependencies with a
 *  cycle is a broken plan: nothing in the cycle can start. Starts from the node's successors
 *  and reports a hit if any path returns to the node. Cycle-safe (bounded by `seen`). */
export function isInCycle(graph: RelationGraph, memberId: string, kind?: string): boolean {
  const seen = new Set<string>();
  const stack = byKind(graph.out[memberId] ?? [], kind).map((e) => e.to);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === memberId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of byKind(graph.out[id] ?? [], kind)) stack.push(e.to);
  }
  return false;
}

/** Everything reachable FROM `memberId` following out-edges (optionally one kind), excluding
 *  the start. Breadth-first, cycle-safe, deterministic (sorted). Answers "the full downstream
 *  chain" — e.g. every task transitively blocked by this one. */
export function reachableFrom(graph: RelationGraph, memberId: string, kind?: string): string[] {
  const seen = new Set<string>([memberId]);
  const found = new Set<string>();
  let frontier = [memberId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of byKind(graph.out[id] ?? [], kind)) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        found.add(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return [...found].sort();
}

/** Everything that reaches `memberId` following IN-edges (optionally one kind), excluding the
 *  start — the full transitive UPSTREAM: everything this card (transitively) depends on / waits
 *  on. The exact mirror of {@link reachableFrom} over the incoming adjacency. Breadth-first,
 *  cycle-safe, deterministic (sorted). Answers "the full prerequisite chain" — e.g. everything
 *  that must finish before this card can start. */
export function reachableTo(graph: RelationGraph, memberId: string, kind?: string): string[] {
  const seen = new Set<string>([memberId]);
  const found = new Set<string>();
  let frontier = [memberId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of byKind(graph.inc[id] ?? [], kind)) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        found.add(e.from);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return [...found].sort();
}

/** The full DEPENDENCY CONE of `memberId` — the card itself plus everything it transitively
 *  depends on (upstream) plus everything that transitively depends on it (downstream). The
 *  connected slice of the plan that a change to this card touches. Sorted, deterministic. */
export function impactCone(graph: RelationGraph, memberId: string, kind?: string): string[] {
  return [...new Set([memberId, ...reachableTo(graph, memberId, kind), ...reachableFrom(graph, memberId, kind)])].sort();
}

/** The SHORTEST directed path from `from` to `to` following out-edges (optionally one kind) — the ordered
 *  chain of member ids `[from, …, to]`, or `[]` if `to` is unreachable from `from`. Where {@link reachableFrom}
 *  returns the SET of reachable nodes, this reconstructs the ROUTE: "how does A lead to B?" — the dependency
 *  chain connecting two cards (Research → Design → Build → Ship). Breadth-first so the path is minimum-length;
 *  neighbours are explored in sorted id order so the chosen path is deterministic among equal-length ties.
 *  Cycle-safe (a `seen` set). `from === to` → the trivial one-node path `[from]`. */
export function shortestPath(graph: RelationGraph, from: string, to: string, kind?: string): string[] {
  if (from === to) return [from];
  const prev = new Map<string, string>(); // node → the node we first reached it from (at minimum depth)
  const seen = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const targets = byKind(graph.out[id] ?? [], kind).map((e) => e.to).sort();
      for (const t of targets) {
        if (seen.has(t)) continue;
        seen.add(t);
        prev.set(t, id);
        if (t === to) {
          const path = [to];
          let cur = to;
          while (cur !== from) {
            cur = prev.get(cur) as string;
            path.push(cur);
          }
          return path.reverse();
        }
        next.push(t);
      }
    }
    frontier = next.sort(); // next BFS level in deterministic order
  }
  return [];
}

/** The connector edges along a `path` (each consecutive `[a, b]` pair) — the lines to HIGHLIGHT when the
 *  path is shown. For each hop, the out-edge from a to b (the lexicographically-first by connector id when
 *  two cards share several connectors). Empty for a path shorter than two nodes. Deterministic. */
export function pathEdges(graph: RelationGraph, path: readonly string[]): RelationEdge[] {
  const result: RelationEdge[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const hop = (graph.out[a] ?? []).filter((e) => e.to === b).sort((x, y) => x.memberId.localeCompare(y.memberId))[0];
    if (hop) result.push(hop);
  }
  return result;
}

/** The shortest path connecting two cards in EITHER direction — tries `from → to`, then `to → from`, so a
 *  user who selects two cards gets the chain regardless of which way the dependency arrows point. Returns the
 *  ordered ids (empty if the two are not connected by a directed path either way). The natural "trace the
 *  path between these two" query for a 2-card selection. */
export function pathBetween(graph: RelationGraph, a: string, b: string, kind?: string): string[] {
  const forward = shortestPath(graph, a, b, kind);
  return forward.length > 0 ? forward : shortestPath(graph, b, a, kind);
}
