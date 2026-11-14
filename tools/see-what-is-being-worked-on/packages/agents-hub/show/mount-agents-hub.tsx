// package-set://bitfield-studio/packages/agents-hub/show/mount-agents-hub.tsx
//
// Material mount for the agents hub placeable surface — same shape as every
// other placeable package entry (FloatingMaterialFrame + ErrorBoundary).

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { AgentsHubSurface } from '@/packages/agents-hub/show/AgentsHubSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function AgentsHubMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput as Record<string, unknown>
    : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="agents-hub material">
        <AgentsHubSurface surfaceInput={surfaceInput} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AgentsHubMaterial props={props} />);
}
