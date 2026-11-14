// package://packages/destination-surface/show/DestinationView.tsx
//
// Generic, owner-projection-only destination host. Section behavior is selected
// by an open DATA key through the shared blind registry; the host contains no
// presentation-key branches and unknown keys remain visibly honest.

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Container, StatementHeader, Text } from '@/packages/ui';
import {
  findDestinationDescriptor,
  finishedCelebratingRefs,
  type DestinationDescriptor,
} from '@/packages/destination-surface/read-data/read-destination';
import {
  createDestinationSectionRegistry,
  type DestinationSectionRegistry,
} from '@/packages/destination-surface/show/destination-section-registry';

export interface DestinationViewProps {
  destinationRef?: string | null;
  destination_ref?: string | null;
  /** Server/host-projected viewer identity for read filtering only. */
  viewerRef?: string | null;
  viewer_ref?: string | null;
  registry?: DestinationSectionRegistry;
  onRetry?: () => void;
  [key: string]: unknown;
}

export interface DestinationSurfaceProps {
  descriptor: DestinationDescriptor;
  registry: DestinationSectionRegistry;
  burstKey?: string | null;
  onRetry?: () => void;
}

/** Pure destination surface used by the live host and render-state proofs. */
export function DestinationSurface({ descriptor, registry, burstKey, onRetry }: DestinationSurfaceProps) {
  const main = descriptor.sections.filter((section) => section.column !== 'rail');
  const rail = descriptor.sections.filter((section) => section.column === 'rail');
  const draw = (section: DestinationDescriptor['sections'][number], index: number) => {
    const Renderer = registry.resolve(section.presentation);
    return <Renderer key={`${section.presentation}:${index}`} section={section} onRetry={onRetry} />;
  };

  return (
    <Container height="full" overflow="y-auto" width="full" padding="none">
      {burstKey ? <Text variant="caption" color="accent" aria-live="polite">Progress updated.</Text> : null}
      <Container as="section" gap="lg" padding="xl" maxWidth="5xl" width="full" centered>
        <StatementHeader
          kicker={descriptor.kicker}
          statement={descriptor.statement}
          subtitle={descriptor.subtitle}
        />
        <Container layout="horizontal" alignItems="start" gap="lg" padding="none" width="full">
          <Container gap="md" padding="none" flex={1} minWidth="0">
            {main.map(draw)}
          </Container>
          {rail.length > 0 ? (
            <Container gap="md" padding="none" width="rail">
              {rail.map(draw)}
            </Container>
          ) : null}
        </Container>
      </Container>
    </Container>
  );
}

export function DestinationView(props: DestinationViewProps) {
  const ref =
    (typeof props.destinationRef === 'string' && props.destinationRef) ||
    (typeof props.destination_ref === 'string' && props.destination_ref) ||
    '';
  const publishedRaw = useBitfieldData('published-records');
  const viewerRef = typeof props.viewerRef === 'string'
    ? props.viewerRef
    : typeof props.viewer_ref === 'string'
      ? props.viewer_ref
      : null;
  const descriptor = React.useMemo(
    () => (ref ? findDestinationDescriptor(publishedRaw, ref, viewerRef) : null),
    [publishedRaw, ref, viewerRef],
  );
  const defaultRegistry = React.useMemo(createDestinationSectionRegistry, []);
  const registry = props.registry ?? defaultRegistry;

  // Celebration is visual-only. Owner DATA already decided completion.
  const [burstKey, setBurstKey] = React.useState<string | null>(null);
  const celebratedRefs = React.useRef<Set<string> | null>(null);
  const baselineRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (baselineRef.current !== ref) {
      baselineRef.current = ref;
      celebratedRefs.current = null;
      setBurstKey(null);
    }
    if (!descriptor) return;
    const finished = finishedCelebratingRefs(descriptor);
    if (celebratedRefs.current === null) {
      celebratedRefs.current = new Set(finished);
      return;
    }
    const fresh = finished.filter((itemRef) => !celebratedRefs.current!.has(itemRef));
    if (fresh.length === 0) return;
    fresh.forEach((itemRef) => celebratedRefs.current!.add(itemRef));
    setBurstKey(`${ref}:${fresh.join('+')}`);
  }, [descriptor, ref]);

  React.useEffect(() => {
    const rows = Array.isArray(publishedRaw) ? publishedRaw.length : publishedRaw === null ? 'null' : typeof publishedRaw;
    console.log(`[destination-surface] ref=${ref || '(none)'} rows=${rows} found=${Boolean(descriptor)}`);
  }, [ref, publishedRaw, descriptor]);

  if (!descriptor) {
    return (
      <Container alignItems="center" justifyContent="center" padding="xl" height="full">
        <Text variant="body" color="muted">Nothing here yet.</Text>
      </Container>
    );
  }

  return <DestinationSurface descriptor={descriptor} registry={registry} burstKey={burstKey} onRetry={props.onRetry} />;
}
