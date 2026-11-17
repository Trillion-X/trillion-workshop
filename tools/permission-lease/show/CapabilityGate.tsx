// packages/permission-lease/show/CapabilityGate.tsx
//
// The STRUCTURAL capability lock (not words). Given a `capability-gate` DATA
// descriptor, it reads the SAME live obligations + canonical measure.facts the
// gate cards read, applies the SAME pure decideCapability leaf, and then:
//   • allowed  → embeds the guarded surface (the real capability) via the generic
//                PlaceableSurfaceHost — the work is genuinely available.
//   • withheld → renders the blocking obligations as the SAME satisfy-able gate
//                cards — "I'm not unlocking anything until the tracked fact exists."
// The guarded work is NEVER rendered while locked. This is what makes the gate
// real: not a badge, an actual withheld capability. Everything is DATA — which
// capability, which guarded surface, the locked copy.

import React from 'react';
import { Container, NamedIcon, ScrollableSurface, Spinner, Text } from '../../ui/index.ts';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host';
import { readGateInputs, GateCard } from './ObligationGatePanel.tsx';
import { conditionPack } from '../read-data/condition-node-pack.ts';
import {
  readCapabilityGateDescriptor,
  resolveCapabilityGate,
  CAPABILITY_GATE_KIND,
} from '../read-data/capability-gate-descriptor.ts';

/** Fallback descriptor source: a published `capability-gate` record. Lets a gate
 *  surface be configured by a DATA record even when the surface's own input isn't
 *  delivered. Keyed by `gateId` when the surface names one (so multiple gates
 *  never resolve to the wrong descriptor); only falls back to the first when a
 *  single gate is expected. */
function publishedGate(published: unknown, gateId: string | null): unknown {
  const rows = Array.isArray(published)
    ? published
    : (published && typeof published === 'object' && Array.isArray((published as { rows?: unknown }).rows)
        ? (published as { rows: unknown[] }).rows
        : []);
  let first: unknown = null;
  for (const row of rows) {
    const p = row && typeof row === 'object' ? ((row as { payload?: unknown }).payload ?? row) : null;
    if (!p || typeof p !== 'object' || (p as { kind?: unknown }).kind !== CAPABILITY_GATE_KIND) continue;
    if (gateId) {
      if ((p as { id?: unknown }).id === gateId) return p;
    } else if (first === null) {
      first = p;
    }
  }
  return gateId ? null : first;
}

function gateIdOf(source: unknown): string | null {
  if (source && typeof source === 'object') {
    const id = (source as { gate_id?: unknown }).gate_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl">
        {children}
      </Container>
    </ScrollableSurface>
  );
}

/** `descriptorSource` is the surface's opaque input (its `surface_input`), which
 *  carries the `capability-gate` descriptor. */
export function CapabilityGate({ descriptorSource }: { descriptorSource: unknown }) {
  const published = useBitfieldData('published-records');
  const descriptor = React.useMemo(
    () => readCapabilityGateDescriptor(descriptorSource) ?? readCapabilityGateDescriptor(publishedGate(published, gateIdOf(descriptorSource))),
    [descriptorSource, published],
  );
  const { obligations, facts } = React.useMemo(() => readGateInputs(published), [published]);

  if (published == null) {
    return <Centered><Spinner /></Centered>;
  }
  if (!descriptor) {
    return (
      <Centered>
        <NamedIcon name="TriangleAlert" size="lg" />
        <Text variant="heading-lg" leading="tight" align="center">This gate isn’t set up yet</Text>
      </Centered>
    );
  }

  const view = resolveCapabilityGate(descriptor, obligations, facts, new Date().toISOString(), conditionPack);

  if (view.allowed) {
    // The capability is available — embed the real guarded surface.
    return (
      <PlaceableSurfaceHost
        packageName={descriptor.guarded.package_name}
        entryName={descriptor.guarded.entry_name}
        surfaceInput={descriptor.guarded.surface_input}
        fill
        interactive
      />
    );
  }

  // Withheld — the guarded surface is NOT rendered. Show what must happen first,
  // as the same satisfy-able gate cards (tracked facts, never words).
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl" padding="lg">
        <Container layout="vertical" gap="xs" alignItems="center" padding="none">
          <NamedIcon name="Lock" size="lg" />
          <Text variant="heading-lg" leading="tight" align="center">
            {descriptor.locked_title ?? 'This is paused right now'}
          </Text>
          <Text variant="body" color="muted" leading="snug" align="center">
            {descriptor.locked_subtitle ?? 'Finish what’s below and it opens.'}
          </Text>
        </Container>
        {view.blocking.map((o) => (
          <GateCard key={o.obligation_ref} obligation={o} facts={facts} />
        ))}
      </Container>
    </ScrollableSurface>
  );
}
