// packages/group/read-data/feed-board-projection.ts
//
// THE generic live-feed -> board mapping (L069 keystone of "any live record family
// — agents, tasks, deals, students — rendered as an interactive board"). Given a
// record feed + a DATA config, it emits a `ProducerOutput` of live-mount POINTER
// items: each record becomes a board member whose content is a `placeableSurface`
// mount of a card surface, keyed by the record's id. Feed this to
// `reconcileBoardGraphAuthoritative` (do-work) -> the board mirrors the feed
// (present->upsert, absent->tombstone), and because items OMIT x/y the merge
// preserves any dragged position; new members land un-positioned and the board's
// arrange-by-`groupKey` lens clusters them (zero per-family layout code).
//
// BLIND / DATA-DRIVEN (L090): this file names NO product ("agent"/"task"/"deal").
// The card surface, the id field, the cluster field are all DATA in the config —
// adding a new family is a new config row, ZERO code change here. No agent import,
// so a caller in any package can project any feed. Pure (no I/O, no React).
//
// SSOT: a board member carries ONLY the pointer (`extra.placeableSurface`) + the
// cluster key (`groupKey`) + a status mirror for tone — NEVER a copy of the
// record. The card surface live-reads the record; the record stays the truth.
//
// PRESENTATION ENCODING IS FLAT (the ONE canonical shape). A member's stored
// presentation is a single flat object — core geometry keys (kind/x/y/w/h/text/src)
// plus owner keys (groupKey/status/placeableSurface/…) side by side — exactly what
// `placeItem`/`placeItems` write and what `readItems` copies into `BoardItem.extra`.
// There is NO nested `extra` sub-object inside a stored presentation: `readItems`
// spreads the WHOLE presentation into `item.extra`, so `readPlaceableSurface`
// resolves `item.extra.placeableSurface` = presentation-top-level `placeableSurface`.
// (Incident 2026-07-11: this projection originally nested owner keys under
// `presentation.extra` — every card rendered as the FallbackItem because the
// canonical reader saw no top-level pointer. The bridge now runs EVERY emitted
// presentation through `normalizeProducerPresentation` (producer-output.ts), so
// the divergent encoding can no longer reach storage from ANY producer path.)
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { AddressRef } from '../../ui/show/group/group-graph';
import type { ProducerOutput, ProducerItem } from './producer-output.ts';

/** The card surface a projected item mounts as its live content (a name pair). */
export interface FeedCardSurface {
  readonly packageName: string;
  readonly entryName: string;
}

/** DATA config for projecting one record family onto a board. All Society DATA. */
export interface FeedBoardProjectionConfig {
  /** The card surface each record mounts (the live window onto the record). */
  readonly cardSurface: FeedCardSurface;
  /** Record field holding the stable id (the board memberId + correlation handle). */
  readonly idField: string;
  /** Key under `surfaceInput` to hand the id to the card (e.g. 'agentId'). */
  readonly surfaceInputKey: string;
  /** Record field -> the cluster `groupKey` string (arrangeByFieldWithRegions). Absent -> fallback. */
  readonly groupKeyField?: string;
  /** Cluster used when `groupKeyField` is missing/empty (default 'Unassigned' — never drop). */
  readonly groupKeyFallback?: string;
  /** Record field mirrored to `extra.status` for the card's dot tone. Absent -> no status mirror. */
  readonly statusField?: string;
  /** When set, project only records whose `payload.kind` equals this (skips the rest). */
  readonly kindFilter?: string;
  /** presentation.kind for the item (default 'placeable-surface'). */
  readonly itemKind?: string;
  /** nodeRef family (default 'group.feed-item'). */
  readonly nodeFamily?: string;
  /** Card footprint seeded onto NEW members (defaults 380×300 — the live-surface
   *  footprint). DATA: a family with denser cards overrides per config row. */
  readonly itemW?: number;
  readonly itemH?: number;
  /**
   * EDGE (topology) configs — the plan's core: "edges = records carrying a
   * from-ref/to-ref pair (spawn, assignment, produced-by, blocks, caused-by,
   * depends-on)." Each config names the record fields that hold the endpoints; the
   * projection emits a group CONNECTOR item (a member whose presentation carries
   * `fromMemberId`+`toMemberId` — the structural connector contract `itemIsConnector`,
   * L090) per matching record. group's existing ConnectorLayer draws the routed line
   * between the two node rects and SKIPS a dangling endpoint (a ref to a node not on
   * the board), so a partial/inconsistent ref just doesn't render — never a crash.
   * Blind: group never learns "agent"/"spawned" — the field names + label are DATA.
   */
  readonly edgeConfigs?: ReadonlyArray<FeedEdgeConfig>;
  /**
   * DRILLDOWN (open a console): when set, activating a node opens `drilldown.surface`
   * (a tabbed console) SCOPED to that node's record. The board derives the scope from
   * the node's OWN `placeableSurface.surfaceInput` (the SAME id the card renders with —
   * SSOT, no duplicated/lagging copy in storage) plus the node title as a label, and
   * composes `surfaceInput = { tabs, subject }`. The tab list lives board-level (not
   * copied per node). Blind: group learns no product; the surface + tabs are all DATA.
   */
  readonly drilldown?: FeedDrilldownConfig;
}

/** DATA config: activating a node opens a tabbed console scoped to that record. */
export interface FeedDrilldownConfig {
  /** The console surface to mount (default screen-arrangement:worker-console). */
  readonly surface?: FeedCardSurface;
  /** The tabs the console shows — opaque DATA rows handed to the console via `surfaceInput.tabs`. */
  readonly tabs: ReadonlyArray<Record<string, unknown>>;
}

/** DATA config for one topology edge family (record → connector). */
export interface FeedEdgeConfig {
  /** Stable id for this edge family (namespaces the connector memberId). */
  readonly id: string;
  /** Only project edges from records of this kind. Absent → every record considered. */
  readonly kindFilter?: string;
  /** Field holding the FROM-endpoint node id. Default: the node `idField` (the record itself is the source). */
  readonly fromField?: string;
  /** Field holding the TO-endpoint node id (the target this record points at). REQUIRED. */
  readonly toField: string;
  /** Self-describing relation kind written to the connector (DATA, not a group enum). */
  readonly relationKind?: string;
  /** Edge label drawn at the connector midpoint. */
  readonly label?: string;
  /** Self-describing connector style (all optional, all DATA — group reads these blind). */
  readonly style?: {
    readonly color?: string;
    readonly dashed?: boolean;
    readonly arrow?: 'end' | 'both' | 'none';
    readonly routing?: string;
  };
  /** nodeRef family for the edge (default 'group.feed-edge'). */
  readonly nodeFamily?: string;
}

/** A published record from the feed (payload-carrying). */
export interface FeedRecord {
  readonly payload?: unknown;
}

const DEFAULT_KIND = 'placeable-surface';
const DEFAULT_NODE_FAMILY = 'group.feed-item';
const DEFAULT_EDGE_FAMILY = 'group.feed-edge';
const DEFAULT_FALLBACK = 'Unassigned';

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * Project a record feed into a `ProducerOutput` of live-mount pointer items.
 * Records lacking the id field are skipped (never a broken member). Deterministic
 * (feed order preserved, no Date/random). The result's `items` ARE the complete
 * authoritative membership — pass straight to `reconcileBoardGraphAuthoritative`.
 */
export function recordFeedToProducerOutput(
  records: readonly FeedRecord[],
  targetGroupRef: AddressRef,
  config: FeedBoardProjectionConfig,
): ProducerOutput {
  const kind = config.itemKind ?? DEFAULT_KIND;
  const nodeFamily = config.nodeFamily ?? DEFAULT_NODE_FAMILY;
  const fallback = config.groupKeyFallback ?? DEFAULT_FALLBACK;

  const seen = new Set<string>();
  const items: ProducerItem[] = [];
  for (const rec of records) {
    const payload = rec.payload;
    if (!isRecord(payload)) continue;
    if (config.kindFilter && payload.kind !== config.kindFilter) continue;
    const id = text(payload[config.idField]);
    if (!id || seen.has(id)) continue; // skip idless + duplicate ids (first wins)
    seen.add(id);

    const groupKey = (config.groupKeyField ? text(payload[config.groupKeyField]) : undefined) ?? fallback;
    const status = config.statusField ? text(payload[config.statusField]) : undefined;

    items.push({
      memberId: id,
      nodeRef: { family: nodeFamily, parts: { item: id } },
      // FLAT presentation (the one canonical encoding — see the header): pointer +
      // cluster + tone side by side with `kind`. NO x/y/w/h — the merge must never
      // move or resize an existing member (drag/resize survives a reconcile); NEW
      // members get their seed geometry from `seedNewMemberPositions` (the reconcile
      // seam decorates ONLY ids absent from the before-graph). The bridge's
      // `normalizeProducerPresentation` codec guarantees the stored shape (and
      // heals any member written by the pre-fix nested encoding on first merge).
      presentation: {
        kind,
        groupKey,
        ...(status ? { status } : {}),
        placeableSurface: {
          packageName: config.cardSurface.packageName,
          entryName: config.cardSurface.entryName,
          surfaceInput: { [config.surfaceInputKey]: id },
        },
      },
    });
  }

  // TOPOLOGY EDGES (append AFTER the node items): each edge config projects a
  // group CONNECTOR member per matching record. `seen` is the set of node ids
  // that exist on THIS board; we drop a self-loop and de-dup identical edges, but
  // we DO keep an edge whose endpoint is not (yet) a node — group's ConnectorLayer
  // skips a dangling endpoint at render time, so a ref to an off-board node simply
  // doesn't draw (never a crash), and the edge appears the instant that node joins.
  if (config.edgeConfigs && config.edgeConfigs.length > 0) {
    const edgeSeen = new Set<string>();
    for (const edge of config.edgeConfigs) {
      const fromField = edge.fromField ?? config.idField;
      const edgeFamily = edge.nodeFamily ?? DEFAULT_EDGE_FAMILY;
      for (const rec of records) {
        const payload = rec.payload;
        if (!isRecord(payload)) continue;
        if (edge.kindFilter && payload.kind !== edge.kindFilter) continue;
        const fromId = text(payload[fromField]);
        const toId = text(payload[edge.toField]);
        if (!fromId || !toId || fromId === toId) continue; // need both, no self-loop
        const dedup = `${edge.id}|${fromId}|${toId}`;
        if (edgeSeen.has(dedup)) continue;
        edgeSeen.add(dedup);
        items.push({
          memberId: `edge:${dedup}`,
          nodeRef: { family: edgeFamily, parts: { edge: dedup } },
          // FLAT connector presentation: `fromMemberId`+`toMemberId` at the top level
          // ARE the structural connector contract (itemIsConnector reads item.extra.*,
          // and readItems spreads presentation → item.extra). relationKind/label/style
          // are self-describing DATA the connector renderer reads blind (L090). NO x/y —
          // a connector's geometry comes from its endpoint node rects, not a position.
          presentation: {
            kind: 'connector',
            fromMemberId: fromId,
            toMemberId: toId,
            ...(edge.relationKind ? { relationKind: edge.relationKind } : {}),
            ...(edge.label ? { label: edge.label } : {}),
            ...(edge.style?.color ? { color: edge.style.color } : {}),
            ...(edge.style?.dashed !== undefined ? { dashed: edge.style.dashed } : {}),
            ...(edge.style?.arrow ? { arrow: edge.style.arrow } : {}),
            ...(edge.style?.routing ? { routing: edge.style.routing } : {}),
          },
        });
      }
    }
  }

  return { targetGroupRef, items };
}
