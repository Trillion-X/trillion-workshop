// packages/group/show/RelationInspector.tsx
//
// R9 product surface: the semantic readout of a card's relationships. Select a card and
// this shows what it points at, grouped by relationship kind and coloured by the kind
// catalog — "depends on: Build, Test", "blocks: Ship". It reads the pure relationship graph
// (relationship-graph.ts) derived from the board's own typed connectors, so it needs no
// engine and no external package for in-board relations.
//
// Generic (L090): it never names a relationship kind — it iterates whatever kinds the graph
// contains and resolves each through the injected relation-kind catalog. A new kind is DATA.
// Renders null when the card has no relations (no filler, L118). Colour is the only dynamic
// style (per-kind DATA); everything else is ui components (L065).

import { Container, Text } from '../../ui';
import {
  impactCone,
  isInCycle,
  reachableFrom,
  reachableTo,
  relationsFrom,
  relationsTo,
  type RelationGraph,
} from '../read-data/relationship-graph';
import {
  relationKindSpec,
  type RelationKindSpec,
} from '../read-data/relation-kind-catalog';

export interface RelationInspectorProps {
  readonly graph: RelationGraph;
  readonly memberId: string;
  readonly titleOf: (id: string) => string;
  readonly catalog?: Readonly<Record<string, RelationKindSpec>>;
  /** Select the card's full dependency cone (itself + everything up- and down-stream). When
   *  provided, a "Select impact cone" affordance appears once the card has a transitive chain. */
  readonly onSelectImpact?: (memberIds: readonly string[]) => void;
}

function groupByKind(edges: readonly { kind: string; other: string }[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const e of edges) {
    const list = by.get(e.kind) ?? [];
    list.push(e.other);
    by.set(e.kind, list);
  }
  return by;
}

function KindRow({
  kind,
  titles,
  incoming,
  catalog,
}: {
  kind: string;
  titles: readonly string[];
  incoming: boolean;
  catalog?: Readonly<Record<string, RelationKindSpec>>;
}): JSX.Element {
  const spec = relationKindSpec(kind, catalog);
  const label = incoming ? `${spec.label} (from)` : spec.label;
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      <Container position="relative" style={{ background: spec.color, borderRadius: 5, padding: '1px 7px' }}>
        <Text variant="body-sm" weight="medium" style={{ color: '#fff', whiteSpace: 'nowrap' }}>
          {label}
        </Text>
      </Container>
      <Text variant="body-sm">{titles.join(', ')}</Text>
    </Container>
  );
}

export function RelationInspector({ graph, memberId, titleOf, catalog, onSelectImpact }: RelationInspectorProps): JSX.Element | null {
  const outByKind = groupByKind(relationsFrom(graph, memberId).map((e) => ({ kind: e.kind, other: titleOf(e.to) })));
  const inByKind = groupByKind(relationsTo(graph, memberId).map((e) => ({ kind: e.kind, other: titleOf(e.from) })));
  if (outByKind.size === 0 && inByKind.size === 0) return null;

  // Transitive downstream impact: everything reachable via out-edges, minus the direct
  // neighbours already shown — "changing this card also ripples to these".
  const directOut = new Set(relationsFrom(graph, memberId).map((e) => e.to));
  const downstream = reachableFrom(graph, memberId).filter((id) => !directOut.has(id));
  // Transitive upstream: everything this card (transitively) waits on, minus the direct
  // prerequisites already shown — "before this can start, all of these must finish".
  const directIn = new Set(relationsTo(graph, memberId).map((e) => e.from));
  const upstream = reachableTo(graph, memberId).filter((id) => !directIn.has(id));
  const inCycle = isInCycle(graph, memberId);
  // The full cone (self + up + down) minus the card itself = how many other cards a change touches.
  const cone = impactCone(graph, memberId);
  const coneOthers = cone.length - 1;

  return (
    <Container layout="vertical" gap="sm">
      <Text variant="body-md" weight="semibold">
        {titleOf(memberId)}
      </Text>
      {inCycle ? (
        <Text variant="body-sm" color="error">
          ⚠ In a circular dependency
        </Text>
      ) : null}
      {[...outByKind.entries()].map(([kind, titles]) => (
        <KindRow key={`out:${kind}`} kind={kind} titles={titles} incoming={false} catalog={catalog} />
      ))}
      {[...inByKind.entries()].map(([kind, titles]) => (
        <KindRow key={`in:${kind}`} kind={kind} titles={titles} incoming catalog={catalog} />
      ))}
      {upstream.length > 0 ? (
        <Text variant="body-sm" tone="muted">
          ↑ waits on {upstream.length} upstream: {upstream.map(titleOf).join(', ')}
        </Text>
      ) : null}
      {downstream.length > 0 ? (
        <Text variant="body-sm" tone="muted">
          ↓ ripples to {downstream.length} more: {downstream.map(titleOf).join(', ')}
        </Text>
      ) : null}
      {onSelectImpact && coneOthers > 0 ? (
        <Container
          role="button"
          data-select-cone={memberId}
          onClick={() => onSelectImpact(cone)}
          style={{ alignSelf: 'flex-start', padding: '3px 10px', borderRadius: 7, background: '#eef2ff', border: '1px solid #c7d2fe', cursor: 'pointer' }}
        >
          <Text variant="body-sm" style={{ color: '#4338ca' }}>Select impact cone ({cone.length})</Text>
        </Container>
      ) : null}
    </Container>
  );
}
