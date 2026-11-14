// frontends/web/src/packages/ui/show/node-graph/project-topology.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pure record→topology transform — the "graph layout mode" of a record
// projection. Given a flat array of HETEROGENEOUS records (any shape, straight
// off the log) and a DATA descriptor, it produces {nodes, edges} ready for the
// NodeGraph view. This is the generic capability the convergence flagged as the
// real primitive gap: (1) arbitrary record→node projection, (2) arbitrary
// record/ref→edge projection, (3) status/activity carried as fields.
//
// It knows NOTHING about "workers", "runs", "pipelines". The descriptor — pure
// DATA — says which records become nodes, which fields carry id/label/status,
// and which fields carry the from/to refs of edges. Swap the descriptor and the
// SAME transform yields a worker graph, a build pipeline, a data-lineage graph,
// an org chart… zero code change.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — record shapes + field names are all DATA.
// 2. PURE + DETERMINISTIC — no I/O, no clock, no mutation of inputs; stable
//    ordering (records processed in array order; first-wins dedup).
// 3. TOTAL — malformed records, missing fields, and dangling edge refs never
//    throw; they are skipped, not fatal.
// 4. Field access is by dotted PATH ("payload.status") so nested records work.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { GraphNodeInput, GraphEdgeInput } from './NodeGraph';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** A record is any object; the transform reads it by DATA-supplied field paths. */
export type TopologyRecord = Readonly<Record<string, unknown>>;

/** A match condition on one field path. Empty where[] = match every record. */
export interface FieldMatch {
  readonly field: string;                 // dotted path
  readonly in?: readonly string[];        // value ∈ in
  readonly equals?: string;               // value === equals
  readonly exists?: boolean;              // presence check (true = must be present)
}

/** How a matching record becomes a NODE. All values are field PATHS (DATA). */
export interface NodeSource {
  readonly where?: readonly FieldMatch[];
  readonly id: string;                    // path → node id (required)
  readonly label?: string;                // path → label
  readonly subtitle?: string;             // path → subtitle
  readonly status?: string;               // path → raw status key
  readonly width?: number;
  readonly height?: number;
}

/** How a matching record becomes an EDGE. from/to are field PATHS (DATA). */
export interface EdgeSource {
  readonly where?: readonly FieldMatch[];
  readonly from: string;                  // path → source node id
  readonly to: string;                    // path → target node id
  readonly id?: string;                   // path → edge id (optional)
  readonly activity?: string;             // path → raw activity key
}

/** The full DATA descriptor: what records become nodes and edges. */
export interface TopologyDescriptor {
  readonly nodeSources: readonly NodeSource[];
  readonly edgeSources?: readonly EdgeSource[];
}

// ---------------------------------------------------------------------------
// FIELD ACCESS (pure)
// ---------------------------------------------------------------------------

/** Read a dotted path out of a record. Missing/typed-wrong → undefined. */
export function getPath(record: TopologyRecord, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = record;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** A value as the ids it names: one, or each of a list's (empty and non-text members are left out). */
function asStrs(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).map(asStr).filter((id): id is string => Boolean(id));
}

/** Does a record satisfy ALL conditions? Empty/absent where = yes. */
export function matchesWhere(record: TopologyRecord, where?: readonly FieldMatch[]): boolean {
  if (!where || where.length === 0) return true;
  for (const c of where) {
    const v = getPath(record, c.field);
    if (c.exists !== undefined) {
      const present = v !== undefined && v !== null;
      if (present !== c.exists) return false;
    }
    if (c.equals !== undefined && asStr(v) !== c.equals) return false;
    if (c.in !== undefined && !c.in.includes(asStr(v) ?? '\u0000__nomatch__')) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TRANSFORM (the ONE place records → {nodes, edges})
// ---------------------------------------------------------------------------

/**
 * Project heterogeneous records into a topology view-model.
 *
 * @param records    flat array of records (any shape)
 * @param descriptor DATA rules mapping records → nodes and edges
 * @returns {nodes, edges} ready for <NodeGraph/>. Deterministic, total.
 */
export function projectTopology(
  records: readonly TopologyRecord[],
  descriptor: TopologyDescriptor,
): { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] } {
  const nodes = new Map<string, GraphNodeInput>();  // first-wins by id (stable)
  const edges = new Map<string, GraphEdgeInput>();  // dedup by from->to(:id)

  for (const record of records) {
    // Nodes
    for (const src of descriptor.nodeSources) {
      if (!matchesWhere(record, src.where)) continue;
      const id = asStr(getPath(record, src.id));
      if (!id || nodes.has(id)) continue;
      nodes.set(id, {
        id,
        label: src.label ? asStr(getPath(record, src.label)) : undefined,
        subtitle: src.subtitle ? asStr(getPath(record, src.subtitle)) : undefined,
        status: src.status ? asStr(getPath(record, src.status)) : undefined,
        width: src.width,
        height: src.height,
      });
    }
    // Edges
    for (const src of descriptor.edgeSources ?? []) {
      if (!matchesWhere(record, src.where)) continue;
      // A path holding several ids (a record under several others) draws one edge to or from each.
      const edgeId = src.id ? asStr(getPath(record, src.id)) : undefined;
      for (const from of asStrs(getPath(record, src.from))) {
        for (const to of asStrs(getPath(record, src.to))) {
          const key = `${from}\u0000${to}\u0000${edgeId ?? ''}`;
          if (edges.has(key)) continue;
          edges.set(key, {
            id: edgeId,
            from,
            to,
            activity: src.activity ? asStr(getPath(record, src.activity)) : undefined,
          });
        }
      }
    }
  }

  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) };
}
