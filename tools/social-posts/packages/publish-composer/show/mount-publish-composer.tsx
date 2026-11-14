import React from 'react';
import { Container, ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { PublishComposer } from '@/packages/publish-composer/show/PublishComposer';
import {
  readPublishComposerSurfaceView,
  type PublishComposerSurfaceView,
} from '@/packages/publish-composer/read-data/read-publish-composer';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// DATA EDGE
// ---------------------------------------------------------------------------
// The mount wrapper is the only place that touches live data. It reads the
// owner-translated destination fragments, projects them into the resolved
// surface view, and hands the result to the pure `PublishComposer`. `null` rows
// (data not resolved) flow through as a `null` surface — the surface renders its
// own loading state. The hook throws on error; the ErrorBoundary catches it.

export function readComposerDestinationsSourceAddress(surfaceInput: unknown): string | null {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return null;
  const value = (surfaceInput as Record<string, unknown>).destinations_source_address;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function publishComposerDestinationSelector(surfaceInput: unknown):
  | 'contentDistributionEvidence'
  | { input: 'contentDistributionEvidence'; params: { address: string } } {
  const address = readComposerDestinationsSourceAddress(surfaceInput);
  return address
    ? { input: 'contentDistributionEvidence', params: { address } }
    : 'contentDistributionEvidence';
}

function PublishComposerPanel({ surfaceInput }: { surfaceInput?: unknown }) {
  const sourceAddress = React.useMemo(
    () => readComposerDestinationsSourceAddress(surfaceInput),
    [surfaceInput],
  );
  const selector = React.useMemo(
    () => publishComposerDestinationSelector(surfaceInput),
    [surfaceInput],
  );
  const rows = useBitfieldData(selector);
  const surface = React.useMemo<PublishComposerSurfaceView | null>(
    () => (rows === null ? null : readPublishComposerSurfaceView(rows)),
    [rows],
  );
  return (
    <Container
      height="full"
      width="full"
      data-publish-composer-destinations-source={sourceAddress ?? 'default'}
    >
      <PublishComposer surface={surface} />
    </Container>
  );
}

function PublishComposerMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Write a post">
        <PublishComposerPanel surfaceInput={props.surfaceInput} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PublishComposerMaterial props={props} />);
}
