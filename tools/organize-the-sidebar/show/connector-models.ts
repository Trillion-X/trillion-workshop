// packages/group/show/connector-models.ts
//
// PURE connector-model derivation for the board. `connectorEndpoints` is the
// self-describing predicate that decides whether an item IS a connector (it
// carries `extra.fromMemberId` + `extra.toMemberId`) and what it links — never a
// kind branch (L090). `buildConnectorModels` folds the connector items into the
// `ConnectorModel[]` the ConnectorLayer renders: it suppresses lines to hidden
// endpoints and reads each connector's self-describing DATA (label/color/dashed/
// arrow/routing/anchors) through fail-soft type guards. Extracted out of the
// GroupBoardPanel show component so this core derivation is unit-testable and the
// god surface shrinks — zero behavior change, no React, no hooks.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { BoardItem } from '../read-data/group-board-model.ts';
import { readConnectorAnchor, readWaypoints } from '../do-work/connector-geometry.ts';
import type { ConnectorModel } from './ConnectorLayer.tsx';
import {
  DEFAULT_RELATION_KINDS,
  relationKindSpec,
  connectorLabelOf,
  type RelationKindSpec,
} from '../read-data/relation-kind-catalog.ts';

/** The two member ids a connector links, or null when the item is NOT a connector.
 *  A connector is self-describing: it carries string `extra.fromMemberId` +
 *  `extra.toMemberId`. Anything else (a note, a section, a malformed row) → null,
 *  so the board partitions node-items vs connector-items by SHAPE, not by kind. */
export function connectorEndpoints(item: BoardItem): { from: string; to: string } | null {
  const f = item.extra?.fromMemberId;
  const t = item.extra?.toMemberId;
  return typeof f === 'string' && typeof t === 'string' ? { from: f, to: t } : null;
}

/** Inputs the connector-model fold reads beyond the connector items themselves. */
export interface BuildConnectorModelsOptions {
  /** The current selection — a connector is `selected` iff its member id is in here. */
  selectedIds: ReadonlySet<string>;
  /** Members currently hidden (#149) — a connector touching one is suppressed… */
  hiddenIds: ReadonlySet<string>;
  /** …unless the board is revealing hidden items, in which case all lines show. */
  showHidden: boolean;
  /** Relation-kind catalog: a connector carrying `extra.relationKind` (R9 typed relationship)
   *  takes its default colour/label/arrow from this catalog, so a 'depends-on' line is blue
   *  and labelled with zero per-connector styling. Injected (L090); explicit `extra.color/
   *  label/arrow` always win. Defaults to the built-in kinds. */
  relationCatalog?: Readonly<Record<string, RelationKindSpec>>;
}

/**
 * Fold connector items → the render models the ConnectorLayer draws. A connector to
 * a hidden node is suppressed (no line to a vanished item) unless `showHidden`.
 * Every visual facet is read from the member's self-describing `extra.*` DATA with
 * a fail-soft guard (an unknown value cleanly falls back to the default), so a new
 * facet is a new DATA field — never a kind branch (L090). `arrow:'end'` and
 * `routing:'straight'` are the defaults, left `undefined` so the renderer applies them.
 */
export function buildConnectorModels(
  connectorItems: readonly BoardItem[],
  opts: BuildConnectorModelsOptions,
): ConnectorModel[] {
  const { selectedIds, hiddenIds, showHidden, relationCatalog = DEFAULT_RELATION_KINDS } = opts;
  return connectorItems
    .filter((it) => {
      if (showHidden) return true;
      // A connector is suppressed by its OWN hidden flag (so Hide/Show works on a line, not just
      // nodes) OR when either endpoint is hidden (no line to a vanished item). Both read the same
      // `hiddenIds` set — a connector's memberId lands there when its extra.hidden is set.
      if (hiddenIds.has(it.memberId)) return false;
      const e = connectorEndpoints(it)!;
      return !hiddenIds.has(e.from) && !hiddenIds.has(e.to);
    })
    .map((it) => {
      const e = connectorEndpoints(it)!;
      const ex = it.extra ?? {};
      // R9 — a typed relationship gives the line its default look: `extra.relationKind`
      // resolves to a catalog spec (colour/label/arrow). Explicit `extra.color/label/arrow`
      // still win, so a connector with no relationKind is byte-identical to before.
      const relationKind = typeof ex.relationKind === 'string' && ex.relationKind.length > 0 ? ex.relationKind : undefined;
      const spec = relationKind ? relationKindSpec(relationKind, relationCatalog) : undefined;
      return {
        memberId: it.memberId,
        fromMemberId: e.from,
        toMemberId: e.to,
        selected: selectedIds.has(it.memberId),
        label: connectorLabelOf(ex, relationCatalog), // ONE resolver — live == export (ML085)
        color: typeof ex.color === 'string' ? ex.color : spec?.color,
        dashed: ex.dashed === true,
        // cont.26 — per-line hand-drawn roughness (0/absent → crisp). DATA on the member.
        roughness: typeof ex.roughness === 'number' && Number.isFinite(ex.roughness) && ex.roughness > 0 ? ex.roughness : undefined,
        // cont.26 Line-style axis — the NAMED brushstroke + a raw bowing override, both self-describing
        // per-line DATA. `strokeStyle` resolves to roughness+bowing+dash via `resolveStroke` in the layer.
        strokeStyle: typeof ex.strokeStyle === 'string' && ex.strokeStyle ? ex.strokeStyle : undefined,
        bowing: typeof ex.bowing === 'number' && Number.isFinite(ex.bowing) ? ex.bowing : undefined,
        arrow:
          ex.arrow === 'both' || ex.arrow === 'none'
            ? ex.arrow
            : spec?.arrow === 'both' || spec?.arrow === 'none'
              ? spec.arrow
              : undefined,
        // `arrow` above is a CLOSED enum on purpose — Physics: a line has 0, 1, or 2
        // directed ends, an unbounded set is meaningless. `routing` is the opposite:
        // the algorithm NAME is Society-open (ROUTING_ALGORITHMS is a string-keyed map a
        // composition root can extend), so we pass ANY non-empty string straight through
        // to the open dispatcher (unknown → straight). Narrowing to a fixed list here
        // would silently drop a newly-registered routing to `straight` (enum-dissolution).
        routing: typeof ex.routing === 'string' && ex.routing.length > 0 ? ex.routing : undefined,
        // Line weight (#197): ANY positive finite number of px. Not a closed
        // thin/medium/bold enum — the format bar offers preset weights but the DATA is a
        // free number, so an arbitrary weight is equally valid (absent → renderer default).
        thickness:
          typeof ex.thickness === 'number' && Number.isFinite(ex.thickness) && ex.thickness > 0
            ? ex.thickness
            : undefined,
        waypoints: readWaypoints(ex.waypoints),
        fromAnchor: readConnectorAnchor(ex.fromAnchor),
        toAnchor: readConnectorAnchor(ex.toAnchor),
      };
    });
}
